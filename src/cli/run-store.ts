import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { RunIdentity, RunKey } from "../engine/artifact";
import type { CompletedCase } from "../engine/runner";
import type { Artifact } from "../engine/schema";

const ARTIFACT_DIRECTORY = "artifacts";

export interface ResumableRun {
  runId: string;
  artifact: Artifact | null;
  startedAt: string;
  completedAt: string | null;
}

export interface RunStore {
  findResumableRun(key: RunKey): Promise<ResumableRun | null>;
  beginRun(identity: RunIdentity): Promise<void>;
  checkpointRun(artifact: Artifact, completed: CompletedCase): Promise<void>;
  completeRun(artifact: Artifact): Promise<void>;
  completionNote(artifact: Artifact): string;
}

export function createLocalRunStore(outPath: string | undefined): RunStore {
  const pathOf = (artifact: Artifact) => outPath ?? `${ARTIFACT_DIRECTORY}/${artifact.runId}.artifact.json`;
  return {
    findResumableRun: async () => null,
    beginRun: async () => {},
    checkpointRun: async (artifact) => writeJson(pathOf(artifact), artifact),
    completeRun: async (artifact) => writeJson(pathOf(artifact), artifact),
    completionNote: (artifact) => `saved to ${pathOf(artifact)}`,
  };
}

export function writeJson(path: string, value: unknown): void {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  renameSync(temporary, target);
}
