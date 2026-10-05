import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ArtifactSchema } from "../src/engine/schema";
import { Harness } from "../src/engine/harness";
import type { JsonObject } from "../src/engine/guards";

const execFileAsync = promisify(execFile);
const BIN_PATH = resolve("bin/dabench.mjs");

describe("dabench CLI", () => {
  it.each([
    [undefined, "default", "openai", 0.000036],
    ["flex", "flex", "openai/flex", 0.000018],
  ] as const)(
    "runs an OpenRouter suite with service-tier flag %s and records its endpoint and pricing",
    async (tier, expectedTier, tag, costUsd) => {
      const directory = await mkdtemp(join(tmpdir(), "dabench-cli-"));
      const requests: JsonObject[] = [];
      const server = createServer((request, response) => {
        if (request.url === "/v1/models" || request.url === "/v1/models?output_modalities=all") {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ data: [{ id: "stub-model", name: "Stub model" }] }));
          return;
        }
        if (request.url === "/v1/models/stub-model/endpoints") {
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              data: {
                endpoints: [
                  {
                    tag: "openai",
                    provider_name: "OpenAI",
                    quantization: "bf16",
                    status: 0,
                    supported_parameters: ["tools"],
                    pricing: { prompt: "0.000002", completion: "0.000008" },
                  },
                  {
                    tag: "openai/flex",
                    provider_name: "OpenAI",
                    quantization: "unknown",
                    status: 0,
                    supported_parameters: ["tools"],
                    pricing: { prompt: "0.000001", completion: "0.000004" },
                  },
                ],
              },
            }),
          );
          return;
        }
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          requests.push(JSON.parse(body));
        });
        response.setHeader("content-type", "text/event-stream");
        response.end(
          [
            { model: "stub-model", choices: [{ index: 0, delta: { content: "Paris" }, finish_reason: null }] },
            { model: "stub-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
            { model: "stub-model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join("") + "data: [DONE]\n\n",
        );
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("missing server port");
        const suite = {
          id: "public-cli",
          version: "v1",
          categories: [
            {
              slug: "answers",
              label: "Answers",
              short: "ANSWER",
              generation: { reasoningTokens: 2048, reasoningEffort: "medium", maxOutputTokens: 4096 },
            },
          ],
          cases: [
            {
              id: "capital",
              category: "answers",
              tier: 1,
              graderKind: "exact",
              prompt: { user: "What is the capital of France?" },
              expected: "Paris",
            },
          ],
        };
        await writeFile(join(directory, "suite.json"), JSON.stringify(suite));
        await writeFile(
          join(directory, "run.json"),
          JSON.stringify({
            suite: "suite.json",
            model: { id: "stub-model", name: "Stub model", provider: "stub" },
            config: {},
            openai: {
              harness: Harness.OpenRouter,
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              apiKeyEnv: "RUNNER_TEST_KEY",
            },
          }),
        );
        const output = join(directory, "result.json");
        await execFileAsync(
          process.execPath,
          [
            BIN_PATH,
            "run",
            "--config",
            join(directory, "run.json"),
            "--out",
            output,
            ...(tier ? ["--service-tier", tier] : []),
          ],
          {
            cwd: directory,
            env: { ...process.env, RUNNER_TEST_KEY: "test-key" },
          },
        );

        const artifact = ArtifactSchema.parse(JSON.parse(await readFile(output, "utf8")));
        expect(artifact.caseResults[0].response).toBe("Paris");
        expect(artifact.caseResults[0].score).toBe(100);
        expect(requests).toHaveLength(1);
        expect(requests[0].service_tier).toBe(expectedTier);
        expect(artifact.config.providerParameters?.service_tier).toBe(expectedTier);
        const routing = { order: [tag], allow_fallbacks: false };
        expect(requests[0].provider).toEqual(routing);
        expect(artifact.config.providerParameters?.provider).toEqual(routing);
        expect(artifact.reproduce.command).toContain(`--endpoint ${tag}`);
        if (tier) expect(artifact.reproduce.command).toContain(`--service-tier ${tier}`);
        expect(artifact.cost.amountUsd).toBeCloseTo(costUsd, 10);
      } finally {
        server.close();
      }
    },
  );
});
