import { describe, expect, it } from "vitest";
import type { Exec } from "../src/cli/exec";
import { detectHardware } from "../src/cli/hardware";

function fakeExec(table: Record<string, string>): Exec {
  return async (cmd, args) => {
    const hit = table[[cmd, ...args].join(" ")] ?? table[cmd];
    if (hit === undefined) throw new Error(`${cmd}: command not found`);
    return hit;
  };
}

describe("detectHardware", () => {
  it("classifies an NVIDIA box as discrete-vram with named GPUs", async () => {
    const hw = await detectHardware({
      platform: "linux",
      arch: "x64",
      exec: fakeExec({
        "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits":
          "NVIDIA GeForce RTX 4090, 24564\nNVIDIA GeForce RTX 4090, 24564\n",
      }),
    });
    expect(hw.memoryModel).toBe("discrete-vram");
    expect(hw.accelerators).toEqual([
      { kind: "cuda", name: "NVIDIA GeForce RTX 4090", memoryMb: 24564 },
      { kind: "cuda", name: "NVIDIA GeForce RTX 4090", memoryMb: 24564 },
    ]);
  });

  it("classifies Apple Silicon as unified with the metal pool sized to system RAM", async () => {
    const hw = await detectHardware({
      platform: "darwin",
      arch: "arm64",
      exec: fakeExec({ "sw_vers -productVersion": "15.5\n" }),
    });
    expect(hw.memoryModel).toBe("unified");
    expect(hw.accelerators).toHaveLength(1);
    expect(hw.accelerators[0].kind).toBe("metal");
    expect(hw.accelerators[0].memoryMb).toBe(hw.totalRamMb);
    expect(hw.osVersion).toBe("macOS 15.5");
  });
});
