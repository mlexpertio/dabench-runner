import { sha256Canonical } from "./canonical";
import {
  ARTIFACT_SCHEMA_VERSION,
  ArtifactSchema,
  type Artifact,
  type CaseResult,
  type CaseSubset,
  type CategoryScore,
  type Cost,
  type Deployment,
  type Hardware,
  type Metrics,
  type ModelConfig,
  type ModelRef,
} from "./schema";
import type { Suite, TestCase } from "./suite";

interface SuiteFingerprint {
  hash: string;
  caseHashes: string[];
}

export function suiteFingerprint(suite: Suite): SuiteFingerprint {
  return {
    hash: sha256Canonical(suite),
    caseHashes: suite.cases.map((testCase) => sha256Canonical(caseGradingContent(testCase))),
  };
}

function caseGradingContent(testCase: TestCase): Record<string, unknown> {
  const { id: _id, category: _category, tier: _tier, ...gradingContent } = testCase;
  return gradingContent;
}

interface RunSubject {
  model: ModelRef;
  config: ModelConfig;
  suite: Suite;
  modelHash: string | null;
  subset: CaseSubset | null;
}

export interface RunKey extends RunSubject {
  fingerprint: SuiteFingerprint;
  configHash: string;
}

export function runKey(subject: RunSubject): RunKey {
  return { ...subject, fingerprint: suiteFingerprint(subject.suite), configHash: sha256Canonical(subject.config) };
}

export interface RunIdentity extends RunKey {
  runId: string;
  startedAt: string;
  hardware: Hardware | null;
  deployment: Deployment;
  servingProvider: string | null;
  reproduceCommand: string;
}

interface RunOutcome {
  caseResults: CaseResult[];
  categoryScores: CategoryScore[];
  metrics: Metrics;
  cost: Cost;
}

export type ArtifactHeader = Omit<Artifact, keyof RunOutcome>;

export interface CompletedCase {
  result: CaseResult;
  suiteIndex: number;
}

export interface ResumableRun {
  runId: string;
  artifact: Artifact | null;
  startedAt: string;
  completedAt: string | null;
}

export interface RunStore {
  findResumableRun(key: RunKey): Promise<ResumableRun | null>;
  beginRun(header: ArtifactHeader): Promise<void>;
  checkpointRun(artifact: Artifact, completed: CompletedCase): Promise<void>;
  completeRun(artifact: Artifact): Promise<void>;
  completionNote(artifact: Artifact): string;
}

export function artifactHeader(identity: RunIdentity): ArtifactHeader {
  const { suite, fingerprint } = identity;
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    runId: identity.runId,
    model: identity.model,
    config: identity.config,
    suite: { id: suite.id, version: suite.version, hash: fingerprint.hash },
    categories: suite.categories,
    run: {
      timestamp: identity.startedAt,
      engineVersion: identity.config.engineVersion,
      hardware: identity.hardware,
      deployment: identity.deployment,
      servingProvider: identity.servingProvider,
      subset: identity.subset,
    },
    reproduce: {
      command: identity.reproduceCommand,
      suiteRef: `${suite.id}@${suite.version}`,
      suiteHash: fingerprint.hash,
      configHash: identity.configHash,
      caseHashes: fingerprint.caseHashes,
      modelHash: identity.modelHash,
    },
  };
}

export function buildArtifact(identity: RunIdentity, outcome: RunOutcome): Artifact {
  return ArtifactSchema.parse({ ...artifactHeader(identity), ...outcome });
}
