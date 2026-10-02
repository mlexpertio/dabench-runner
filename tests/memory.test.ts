import { describe, expect, it } from "vitest";
import type { Exec } from "dabench/engine/exec";
import { createLocalMemoryMonitor } from "dabench/engine/memory";

type ExecReply = string | (() => string);

function fakeExec(table: Record<string, ExecReply>): Exec {
  return async (cmd, args) => {
    const hit = table[[cmd, ...args].join(" ")];
    if (hit === undefined) throw new Error(`${cmd}: command not found`);
    return typeof hit === "function" ? hit() : hit;
  };
}

const LLAMA_CPP_URL = "http://localhost:8080/v1";
const OLLAMA_URL = "http://localhost:11434/v1";
const LSOF = "lsof -nP -t -iTCP:8080 -sTCP:LISTEN";
const PS_TREE = "ps -axo pid=,ppid=";
const SMI_APPS = "nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits";
const SMI_TOTAL = "nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits";
const BYTES_PER_MB = 1024 * 1024;

function llamaCpp(platform: NodeJS.Platform, table: Record<string, ExecReply>, baseUrl = LLAMA_CPP_URL) {
  return createLocalMemoryMonitor({ harness: "llama.cpp", modelId: "m", baseUrl, platform, exec: fakeExec(table) });
}

function ollama(modelId: string, models: unknown[]) {
  const fetchImpl = (async (url: unknown) => {
    expect(String(url)).toBe("http://localhost:11434/api/ps");
    return new Response(JSON.stringify({ models }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return createLocalMemoryMonitor({
    harness: "ollama",
    modelId,
    baseUrl: OLLAMA_URL,
    platform: "linux",
    exec: fakeExec({}),
    fetchImpl,
  });
}

describe("createLocalMemoryMonitor — the serving process's memory, never a hand-typed number", () => {
  it("attributes VRAM to the server's whole process tree on an NVIDIA box", async () => {
    const monitor = llamaCpp("linux", {
      [LSOF]: "100\n",
      [PS_TREE]: "  100  1\n  200  100\n  300  200\n  999  1\n",
      [SMI_APPS]: "200, 14000\n300, 1000\n999, 6000\n",
    });
    expect(await monitor.probe()).toEqual({ mb: 15000, kind: "vram" });
  });

  it("reads a Mac's unified memory from the server's resident set", async () => {
    const monitor = llamaCpp("darwin", {
      [LSOF]: "100",
      [PS_TREE]: "100 1\n200 100\n",
      "ps -o rss= -p 100,200": "1048576\n2097152\n",
    });
    expect(await monitor.probe()).toEqual({ mb: 3072, kind: "unified-ram" });
  });

  it.each([
    [
      "the requested model among several",
      "llama3:8b",
      [
        { model: "other:latest", size: 1, size_vram: 1 },
        { model: "llama3:8b", size: 5 * BYTES_PER_MB, size_vram: 4 * BYTES_PER_MB },
      ],
      { mb: 4, kind: "vram" },
    ],
    [
      "the model across its :latest tag",
      "llama3",
      [{ model: "llama3:latest", size_vram: 2 * BYTES_PER_MB }],
      { mb: 2, kind: "vram" },
    ],
    [
      "the only loaded model",
      "no-such-model",
      [{ model: "resolved:7b", size_vram: BYTES_PER_MB }],
      { mb: 1, kind: "vram" },
    ],
    [
      "a model running on the CPU",
      "llama3:8b",
      [{ model: "llama3:8b", size: 3 * BYTES_PER_MB, size_vram: 0 }],
      { mb: 3, kind: "system-ram" },
    ],
  ])("asks Ollama what it holds: %s", async (_, modelId, models, sample) => {
    expect(await ollama(modelId, models).probe()).toEqual(sample);
  });

  it("falls through to the whole GPU when no server process holds VRAM, keeping the run's peak and average", async () => {
    const readings = ["1000", "3000"];
    const monitor = llamaCpp("linux", { [SMI_APPS]: "999, 6000\n", [SMI_TOTAL]: () => readings.shift()! });
    monitor.start();
    expect(await monitor.stop()).toEqual({
      kind: "vram",
      peakMb: 3000,
      avgMb: 2000,
      samples: 2,
      source: "nvidia-smi (total gpu)",
    });
  });

  it("reports nothing when no probe can attribute the server", async () => {
    const monitor = llamaCpp("linux", {});
    monitor.start();
    expect(await monitor.stop()).toBeNull();
  });

  it("never samples this machine for a server on another host", async () => {
    const monitor = llamaCpp(
      "linux",
      { [LSOF]: "100", [PS_TREE]: "100 1\n", [SMI_APPS]: "100, 14000\n", [SMI_TOTAL]: "20000" },
      "http://192.168.1.20:8080/v1",
    );
    expect(await monitor.probe()).toBeNull();
  });
});
