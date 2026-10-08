const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { transaction } = require("./transaction");
const { pool } = require("./pool");

const migrations = [
  "001-initial.sql",
  "002-query-indexes.sql",
  "003-demo-seed.sql",
];

async function migrate(source = pool) {
  await transaction(async (client) => {
    // Schema-scoped locking also keeps isolated test databases independent.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext(current_schema()), 41001)",
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query(
      "SELECT version FROM schema_migrations",
    );
    const applied = new Set(rows.map((row) => row.version));
    for (const version of migrations) {
      if (applied.has(version)) continue;
      await client.query(
        await readFile(path.join(__dirname, "migrations", version), "utf8"),
      );
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [
        version,
      ]);
    }
  }, source);
}

module.exports = { migrate };
