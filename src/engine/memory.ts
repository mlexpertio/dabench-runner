import { BYTES_PER_MB, round2 } from "./calc";
import { isLoopbackHost } from "./deployment";
import { defaultExec, outputLines, sumNumericLines, type Exec } from "./exec";
import { isJsonObject, type JsonObject } from "./guards";
import { Harness, knownHarness } from "./harness";
import { endpointRoots, fetchJson } from "./provider-http";
import type { MemoryKind, MemoryUsage } from "./schema";

const SAMPLE_INTERVAL_MS = 1000;
const KB_PER_MB = 1024;
const DEFAULT_HTTP_PORT = 80;
const DEFAULT_HTTPS_PORT = 443;

interface MemorySample {
  mb: number;
  kind: MemoryKind;
}

interface MemoryProbe {
  readonly source: string;
  sample(): Promise<MemorySample | null>;
}

class PortPidResolver {
  private listeners: number[] | null = null;

  constructor(
    private readonly port: number,
    private readonly exec: Exec,
  ) {}

  async resolve(): Promise<number[]> {
    if (!this.listeners) {
      try {
        const out = await this.exec("lsof", ["-nP", "-t", `-iTCP:${this.port}`, "-sTCP:LISTEN"]);
        const pids = [
          ...new Set(
            outputLines(out)
              .map(Number)
              .filter((pid) => Number.isInteger(pid) && pid > 0),
          ),
        ];
        if (pids.length > 0) this.listeners = pids;
      } catch {
        return [];
      }
    }
    if (!this.listeners) return [];
    return this.withDescendants(this.listeners);
  }

  private async withDescendants(roots: number[]): Promise<number[]> {
    try {
      const out = await this.exec("ps", ["-axo", "pid=,ppid="]);
      const children = new Map<number, number[]>();
      for (const line of outputLines(out)) {
        const [pid, ppid] = line.split(/\s+/).map(Number);
        if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
        const siblings = children.get(ppid);
        if (siblings) siblings.push(pid);
        else children.set(ppid, [pid]);
      }
      const seen = new Set(roots);
      const queue = [...roots];
      while (queue.length > 0) {
        for (const pid of children.get(queue.shift()!) ?? []) {
          if (!seen.has(pid)) {
            seen.add(pid);
            queue.push(pid);
          }
        }
      }
      return [...seen];
    } catch {
      return roots;
    }
  }
}

function nvidiaSmiProcessProbe(pids: PortPidResolver, exec: Exec): MemoryProbe {
  return {
    source: "nvidia-smi (process)",
    sample: async () => {
      const out = await exec("nvidia-smi", ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"]);
      const rows = outputLines(out)
        .map((line) => {
          const [pid, mb] = line.split(",").map((cell) => Number(cell.trim()));
          return { pid, mb };
        })
        .filter((row) => Number.isInteger(row.pid) && Number.isFinite(row.mb));
      if (rows.length === 0) return null;
      const serverPids = new Set(await pids.resolve());
      if (serverPids.size === 0) return null;
      const total = rows.filter((row) => serverPids.has(row.pid)).reduce((sum, row) => sum + row.mb, 0);
      return total > 0 ? { mb: total, kind: "vram" } : null;
    },
  };
}

function nvidiaSmiTotalProbe(exec: Exec): MemoryProbe {
  return {
    source: "nvidia-smi (total gpu)",
    sample: async () => {
      const total = sumNumericLines(
        await exec("nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits"]),
      );
      return total > 0 ? { mb: total, kind: "vram" } : null;
    },
  };
}

interface OllamaPsProbeOptions {
  baseUrl: string;
  modelId: string;
  gpuKind: MemoryKind;
  fetchImpl?: typeof fetch;
}

function ollamaPsProbe({ baseUrl, modelId, gpuKind, fetchImpl }: OllamaPsProbeOptions): MemoryProbe {
  const psUrl = `${endpointRoots(baseUrl).root}/api/ps`;
  return {
    source: "ollama /api/ps",
    sample: async () => {
      const payload = await fetchJson(psUrl, { baseUrl, fetchImpl });
      const models = isJsonObject(payload) && Array.isArray(payload.models) ? payload.models.filter(isJsonObject) : [];
      const entry = loadedModel(models, modelId);
      if (!entry) return null;
      const sizeVram = bytes(entry.size_vram);
      const onGpu = sizeVram > 0;
      const total = onGpu ? sizeVram : bytes(entry.size);
      if (total <= 0) return null;
      return { mb: total / BYTES_PER_MB, kind: onGpu ? gpuKind : "system-ram" };
    },
  };
}

function loadedModel(models: JsonObject[], modelId: string): JsonObject | null {
  const id = normalizeTag(modelId);
  const match = models.find((m) => normalizeTag(m.model) === id || normalizeTag(m.name) === id);
  if (match) return match;
  return models.length === 1 ? models[0] : null;
}

function processRssProbe(pids: PortPidResolver, kind: MemoryKind, exec: Exec): MemoryProbe {
  return {
    source: "process rss",
    sample: async () => {
      const serverPids = await pids.resolve();
      if (serverPids.length === 0) return null;
      const totalKb = sumNumericLines(await exec("ps", ["-o", "rss=", "-p", serverPids.join(",")]));
      return totalKb > 0 ? { mb: totalKb / KB_PER_MB, kind } : null;
    },
  };
}

export interface MemoryMonitor {
  start(): void;
  stop(): Promise<MemoryUsage | null>;
  probe(): Promise<MemorySample | null>;
  /** The readings taken so far. */
  usage(): MemoryUsage | null;
}

class PollingMemoryMonitor implements MemoryMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private peak: (MemorySample & { source: string }) | null = null;
  private sumMb = 0;
  private samples = 0;

  constructor(private readonly probes: MemoryProbe[]) {}

  start(): void {
    if (this.timer || this.probes.length === 0) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), SAMPLE_INTERVAL_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<MemoryUsage | null> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight) await this.inFlight;
    await this.sampleOnce();
    return this.usage();
  }

  usage(): MemoryUsage | null {
    if (!this.peak || this.samples === 0) return null;
    return {
      kind: this.peak.kind,
      peakMb: Math.round(this.peak.mb),
      avgMb: round2(this.sumMb / this.samples),
      samples: this.samples,
      source: this.peak.source,
    };
  }

  async probe(): Promise<MemorySample | null> {
    if (this.inFlight) await this.inFlight;
    return this.sampleOnce();
  }

  private tick(): void {
    if (this.inFlight) return;
    this.inFlight = this.sampleOnce()
      .then(() => undefined)
      .finally(() => {
        this.inFlight = null;
      });
  }

  private async sampleOnce(): Promise<MemorySample | null> {
    for (const probe of this.probes) {
      const sample = await probe.sample().catch(() => null);
      if (sample && sample.mb > 0) {
        this.samples++;
        this.sumMb += sample.mb;
        if (!this.peak || sample.mb > this.peak.mb) {
          this.peak = { ...sample, source: probe.source };
        }
        return sample;
      }
    }
    return null;
  }
}

interface LocalMemoryMonitorOptions {
  harness: string;
  modelId: string;
  baseUrl?: string;
  platform?: NodeJS.Platform;
  exec?: Exec;
  fetchImpl?: typeof fetch;
}

/** Samples the serving process's memory with the most precise probe that works for its harness and platform. */
export function createLocalMemoryMonitor(opts: LocalMemoryMonitorOptions): MemoryMonitor {
  return new PollingMemoryMonitor(localMemoryProbes(opts));
}

/** The probes to try, most precise first, for the harness serving the model and the platform it runs on. */
function localMemoryProbes(opts: LocalMemoryMonitorOptions): MemoryProbe[] {
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? defaultExec;
  const port = loopbackPort(opts.baseUrl);
  const pids = port !== null ? new PortPidResolver(port, exec) : null;
  const hostKind: MemoryKind = platform === "darwin" ? "unified-ram" : "system-ram";

  const probes: MemoryProbe[] = [];
  if (knownHarness(opts.harness) === Harness.Ollama && opts.baseUrl) {
    probes.push(
      ollamaPsProbe({
        baseUrl: opts.baseUrl,
        modelId: opts.modelId,
        gpuKind: platform === "darwin" ? "unified-ram" : "vram",
        fetchImpl: opts.fetchImpl,
      }),
    );
  }
  if (!pids) return probes;
  if (platform !== "darwin") probes.push(nvidiaSmiProcessProbe(pids, exec), nvidiaSmiTotalProbe(exec));
  probes.push(processRssProbe(pids, hostKind, exec));
  return probes;
}

/** The port of a server on this machine; null for any other host, whose memory this machine can't see. */
function loopbackPort(baseUrl?: string): number | null {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    if (!isLoopbackHost(url.hostname)) return null;
    if (url.port) return Number(url.port);
    if (url.protocol === "http:") return DEFAULT_HTTP_PORT;
    if (url.protocol === "https:") return DEFAULT_HTTPS_PORT;
    return null;
  } catch {
    return null;
  }
}

function bytes(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeTag(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.toLowerCase().replace(/:latest$/, "");
}
