import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ArtifactSchema } from "dabench/engine/schema";

const execFileAsync = promisify(execFile);
const BIN_PATH = resolve("bin/dabench.mjs");

describe("dabench CLI", () => {
  it("runs a suite from the published bin and writes a run artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dabench-cli-"));
    const server = createServer((request, response) => {
      if (request.url === "/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "stub-model", name: "Stub model" }] }));
        return;
      }
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
          openai: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: "RUNNER_TEST_KEY" },
        }),
      );
      const output = join(directory, "result.json");
      await execFileAsync(
        process.execPath,
        [BIN_PATH, "run", "--config", join(directory, "run.json"), "--out", output],
        {
          cwd: directory,
          env: { ...process.env, RUNNER_TEST_KEY: "test-key" },
        },
      );

      const artifact = ArtifactSchema.parse(JSON.parse(await readFile(output, "utf8")));
      expect(artifact.caseResults[0].response).toBe("Paris");
      expect(artifact.caseResults[0].score).toBe(100);
    } finally {
      server.close();
    }
  });
});
