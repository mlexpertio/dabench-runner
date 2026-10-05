import { fileURLToPath } from "node:url";
import { MS_PER_SECOND } from "./calc";
import { errorMessage } from "./guards";
import { Sandbox } from "./sandbox";

const SQL_TIMEOUT_MS = 2000;
const SANDBOX_SCRIPT = fileURLToPath(new URL("./sql-sandbox.mjs", import.meta.url));

type QueryRun = { ok: true; rows: unknown[][] } | { ok: false; error: string };

export async function runSqlQuery(database: { schema: string; seed: string }, query: string): Promise<QueryRun> {
  const sandbox = Sandbox.fork({ script: SANDBOX_SCRIPT, label: "SQL sandbox", serialization: "advanced" });
  try {
    return await sandbox.request<QueryRun>(
      { ...database, query },
      SQL_TIMEOUT_MS,
      `the query ran longer than ${SQL_TIMEOUT_MS / MS_PER_SECOND} s`,
    );
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  } finally {
    sandbox.stop();
  }
}
