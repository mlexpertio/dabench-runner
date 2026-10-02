import os from "node:os";
import { BYTES_PER_MB } from "./calc";
import { defaultExec, outputLines, type Exec } from "./exec";
import type { Accelerator, Hardware } from "./schema";

interface DetectHardwareOptions {
  exec?: Exec;
  platform?: NodeJS.Platform;
  arch?: string;
}

export async function detectHardware(opts: DetectHardwareOptions = {}): Promise<Hardware> {
  const exec = opts.exec ?? defaultExec;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? os.arch();
  const cpus = os.cpus();
  const totalRamMb = Math.round(os.totalmem() / BYTES_PER_MB);

  const [accelerators, version] = await Promise.all([cudaAccelerators(exec), osVersion(exec, platform)]);
  if (accelerators.length === 0 && platform === "darwin" && arch === "arm64") {
    accelerators.push({
      kind: "metal",
      name: cpus[0]?.model ?? "Apple Silicon",
      memoryMb: totalRamMb,
    });
  }

  const memoryModel = accelerators.some((a) => a.kind === "cuda")
    ? "discrete-vram"
    : accelerators.some((a) => a.kind === "metal")
      ? "unified"
      : "cpu-only";

  return {
    platform,
    arch,
    osVersion: version,
    cpuModel: cpus[0]?.model ?? null,
    cpuCores: cpus.length > 0 ? cpus.length : null,
    totalRamMb,
    accelerators,
    memoryModel,
  };
}

async function cudaAccelerators(exec: Exec): Promise<Accelerator[]> {
  try {
    const out = await exec("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
    return outputLines(out)
      .map((line): Accelerator | null => {
        const comma = line.lastIndexOf(",");
        const name = (comma === -1 ? line : line.slice(0, comma)).trim();
        const memory = comma === -1 ? NaN : Number(line.slice(comma + 1).trim());
        if (!name) return null;
        return { kind: "cuda", name, memoryMb: Number.isFinite(memory) ? memory : null };
      })
      .filter((a): a is Accelerator => a !== null);
  } catch {
    return [];
  }
}

async function osVersion(exec: Exec, platform: NodeJS.Platform): Promise<string | null> {
  if (platform === "darwin") {
    try {
      const version = (await exec("sw_vers", ["-productVersion"])).trim();
      if (version) return `macOS ${version}`;
    } catch {}
  }
  return `${os.type()} ${os.release()}`;
}
