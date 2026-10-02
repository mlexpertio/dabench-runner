import { sha256Canonical } from "./canonical";
import type { Deployment } from "./deployment";
import type { CaseSubset } from "./subset";
import {
  ARTIFACT_SCHEMA_VERSION,
  ArtifactSchema,
  type Artifact,
  type CaseResult,
  type CategoryScore,
  type Cost,
  type Hardware,
  type Metrics,
  type ModelConfig,
  type ModelRef,
} from "./schema";
import { caseGradingContent, type Suite } from "./suite";

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

/** Everything a run record says before any case has run. */
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
