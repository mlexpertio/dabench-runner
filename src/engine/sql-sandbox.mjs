import { constants, DatabaseSync } from "node:sqlite";

const READ_ONLY_ACTIONS = new Set([
  constants.SQLITE_SELECT,
  constants.SQLITE_READ,
  constants.SQLITE_FUNCTION,
  constants.SQLITE_RECURSIVE,
]);

process.on("message", ({ schema, seed, query }) => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schema);
    db.exec(seed);
  } catch (err) {
    process.send({ ok: false, error: `the case's schema or seed failed: ${err?.message ?? err}` });
    return;
  }
  try {
    db.setAuthorizer((action) => (READ_ONLY_ACTIONS.has(action) ? constants.SQLITE_OK : constants.SQLITE_DENY));
    const statement = db.prepare(query);
    statement.setReturnArrays(true);
    process.send({ ok: true, rows: statement.all() });
  } catch (err) {
    process.send({ ok: false, error: String(err?.message ?? err) });
  }
});
