import { createContext, Script } from "node:vm";

const testTimeoutMs = Number(process.argv[2]);

function errorMessage(err) {
  const isRecord = typeof err === "object" && err !== null && !Array.isArray(err);
  return isRecord && typeof err.message === "string" ? err.message : String(err);
}

function compile(code) {
  new Script(code);
  return { ok: true };
}

function call({ setup, code, entry, argsJson }) {
  // Block VM escapes through host constructors.
  const context = createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate",
  });
  const invocation = `${setup ?? ""}\n${code}\n;JSON.stringify({value:(${entry})(...${argsJson})});`;
  const serialized = new Script(invocation).runInContext(context, { timeout: testTimeoutMs });
  if (typeof serialized !== "string") throw new Error("function result is not JSON-serializable");
  return { ok: true, value: JSON.parse(serialized).value };
}

process.on("message", (request) => {
  try {
    process.send(request.kind === "compile" ? compile(request.code) : call(request));
  } catch (err) {
    process.send({ ok: false, error: errorMessage(err) });
  }
});
process.send({ ready: true });
