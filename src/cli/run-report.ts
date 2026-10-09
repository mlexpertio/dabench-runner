import { formatPerMillion, MB_PER_GB, passedCount, pluralize, shortHash } from "../engine/format";
import type { ServingEndpoint } from "../engine/openrouter-endpoints";
import type { DiscoveredModel } from "../engine/provider-discovery";
import type { Artifact, Hardware, MemoryKind, ModelConfig } from "../engine/schema";
import type { Suite } from "../engine/suite";

const DEFAULT_BASE_URL_LABEL = "OpenAI default base URL";
const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  vram: "vram",
  "unified-ram": "unified ram",
  "system-ram": "ram",
};

interface LocalEndpoint {
  baseUrl: string | undefined;
  gpuHourlyUsd: number;
}

interface RunHeader {
  suite: Suite;
  modelId: string;
  config: ModelConfig;
  discovered: DiscoveredModel | null;
  pinned: ServingEndpoint | null;
  local: LocalEndpoint | null;
  hardware: Hardware | null;
  resumed: { runId: string; recorded: number } | null;
}

export function printRunHeader({
  suite,
  modelId,
  config,
  discovered,
  pinned,
  local,
  hardware,
  resumed,
}: RunHeader): void {
  if (resumed) {
    const total = suite.cases.length;
    console.error(
      `▸ reusing run ${resumed.runId} · ${resumed.recorded}/${total} cases recorded · ${Math.max(0, total - resumed.recorded)} remaining`,
    );
  }
  console.error(`▸ running suite ${suite.id}@${suite.version} against ${modelId} via ${config.harness}…`);
  if (discovered) {
    const facts = [
      discovered.name && discovered.name !== modelId ? `actual model ${discovered.name}` : null,
      config.quantization ? `quant ${config.quantization}` : null,
      config.contextWindow ? `context ${config.contextWindow}` : null,
    ].filter(Boolean);
    if (facts.length > 0) console.error(`  provider metadata · ${facts.join(" · ")}`);
  }
  if (pinned) console.error(`  pinned endpoint ${pinned.tag} · ${pinnedFacts(pinned).join(" · ")}`);
  if (local) {
    console.error(
      `  local endpoint ${local.baseUrl ?? DEFAULT_BASE_URL_LABEL} · GPU $${local.gpuHourlyUsd}/hr (estimated cost)`,
    );
  }
  if (hardware) console.error(`  hardware ${hardwareSummary(hardware)}`);
}

export function printRunSummary(artifact: Artifact, isLocal: boolean): void {
  const memory = artifact.metrics.memory;
  const vramNote = memory
    ? ` · ${MEMORY_KIND_LABELS[memory.kind]} peak ${(memory.peakMb / MB_PER_GB).toFixed(1)} GB (${memory.source}, ${pluralize(memory.samples, "sample")})`
    : isLocal
      ? " · memory unknown (no probe could attribute the endpoint)"
      : "";
  const costNote = artifact.cost.estimated ? `~$${artifact.cost.amountUsd} (est.)` : `$${artifact.cost.amountUsd}`;
  console.error("");
  console.error(`✓ ${artifact.model.name}:`);
  for (const c of artifact.categoryScores) {
    const pass = `${passedCount(c)}/${c.caseCount} pass`;
    console.error(`    ${String(c.score).padStart(3)}/100  ${c.category.padEnd(22)} ${pass}`);
  }
  const m = artifact.metrics;
  console.error(
    `  avg ${m.avgTokensPerSecond} tok/s · out ${Math.round(m.avgCompletionTokens)} tok/case (${Math.round(m.avgReasoningTokens)} reasoning) · window ${m.tokensPerSecond} tok/s${vramNote}`,
  );
  console.error(`  cost ${costNote} · suite ${shortHash(artifact.suite.hash)}`);
  if (artifact.reproduce.modelHash) {
    console.error(`  model ${shortHash(artifact.reproduce.modelHash)} (weights pinned)`);
  }
}

function hardwareSummary(hw: Hardware): string {
  const accelerators = hw.accelerators
    .map((a) => `${a.name}${a.memoryMb ? ` ${(a.memoryMb / MB_PER_GB).toFixed(0)} GB` : ""}`)
    .join(", ");
  const compute = accelerators || hw.cpuModel || "unknown cpu";
  return `${compute} · ram ${(hw.totalRamMb / MB_PER_GB).toFixed(0)} GB · ${hw.memoryModel} · ${hw.osVersion ?? hw.platform}`;
}

function pinnedFacts(endpoint: ServingEndpoint): string[] {
  const price = endpoint.pricing;
  return [
    `served by ${endpoint.providerName}`,
    endpoint.precision ? `precision ${endpoint.precision}` : "precision undisclosed",
    price
      ? `${formatPerMillion(price.promptUsdPerToken)} in, ${formatPerMillion(price.completionUsdPerToken)} out`
      : "no list price",
  ];
}
