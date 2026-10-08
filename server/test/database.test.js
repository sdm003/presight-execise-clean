const test = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");
const { setTimeout: delay } = require("node:timers/promises");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { InMemorySpanExporter } = require("@opentelemetry/sdk-trace-base");

const quiet = { info() {}, error() {}, fatal() {} };

function clearServerModules() {
  for (const key of Object.keys(require.cache))
    if (key.includes("/server/src/")) delete require.cache[key];
}

function connectionConfig() {
  return {
    connectionString: process.env.TEST_DATABASE_URL,
    ...(process.env.PG_SSL === "true"
      ? { ssl: { rejectUnauthorized: true } }
      : {}),
  };
}

test(
  "PostgreSQL integration: migrations, telemetry, concurrency and recovery",
  {
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Set TEST_DATABASE_URL to run PostgreSQL integration tests",
  },
  async (t) => {
    const schema = `directory_test_${process.pid}_${Date.now()}`;
    const admin = new Pool(connectionConfig());
    const previousEnv = {
      DATABASE_URL: process.env.DATABASE_URL,
      PGOPTIONS: process.env.PGOPTIONS,
      NODE_ENV: process.env.NODE_ENV,
      OTEL_ENABLED: process.env.OTEL_ENABLED,
      OTEL_SAMPLE_RATIO: process.env.OTEL_SAMPLE_RATIO,
    };
    let pool;
    let migrate;
    let transaction;
    let createDatabase;
    let createRepository;
    let createApp;
    let initializeTracing;
    let telemetry;
    let exporter;
    let server;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
      process.env.PGOPTIONS = `-c search_path=${schema}`;
      process.env.NODE_ENV = "test";
      clearServerModules();
      ({ pool, createDatabase } = require("../src/database/pool"));
      ({ migrate } = require("../src/database/migrate"));
      ({ transaction } = require("../src/database/transaction"));
      ({ createRepository } = require("../src/modules/users/repository"));
      ({ initializeTracing } = require("../src/observability/tracing"));
      ({ createApp } = require("../src/index"));

      await Promise.all([migrate(pool), migrate(pool), migrate(pool)]);
      exporter = new InMemorySpanExporter();
      telemetry = initializeTracing({
        exporter,
        env: { OTEL_ENABLED: "true" },
        sampleRatio: 1,
      });

      const app = createApp({
        config: { mode: "test", origin: "", maxInFlight: 4 },
        log: quiet,
      });
      server = app.listen(0);
      const base = `http://127.0.0.1:${server.address().port}/api/users`;
      const get = async (query = "") => {
        const response = await fetch(query ? `${base}?${query}` : base);
        assert.equal(response.status, 200);
        return response.json();
      };
      const post = async (body) => {
        const response = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return { response, json: await response.json() };
      };

      await t.test(
        "seed is complete, valid, concurrent-safe and never restores deleted records",
        async () => {
          const { validateUser } = require("../src/modules/users/validation");
          const readSeed = () =>
            pool.query(
              `SELECT u.*, COALESCE(
              (SELECT array_agg(h.hobby ORDER BY h.hobby) FROM hobbies h WHERE h.user_id = u.id),
              ARRAY[]::text[]) hobbies FROM users u ORDER BY u.id`,
            );
          try {
            const { rows } = await readSeed();
            assert.equal(rows.length, 1000);
            rows.forEach((row) => assert.doesNotThrow(() => validateUser(row)));
            assert.equal(
              new Set(rows.map((row) => `${row.first_name} ${row.last_name}`))
                .size,
              1000,
            );
            assert.equal(new Set(rows.map((row) => row.nationality)).size, 32);
            assert.equal(new Set(rows.flatMap((row) => row.hobbies)).size, 32);
            assert.equal(Math.min(...rows.map((row) => row.hobbies.length)), 0);
            assert.equal(
              Math.max(...rows.map((row) => row.hobbies.length)),
              10,
            );
            const firstPage = await get();
            assert.equal(firstPage.data.length, 40);
            assert.equal(firstPage.pagination.total, 1000);
            assert.equal(firstPage.pagination.hasMore, true);
            for (const [facet, values] of [
              ["nationalities", rows.map((row) => row.nationality)],
              ["hobbies", rows.flatMap((row) => row.hobbies)],
            ]) {
              const expected = [...new Set(values)]
                .map((value) => ({
                  value,
                  count: values.filter((item) => item === value).length,
                }))
                .sort(
                  (a, b) =>
                    b.count - a.count ||
                    (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
                )
                .slice(0, 20);
              assert.deepEqual(firstPage.facets[facet], expected);
            }
            await Promise.all([migrate(pool), migrate(pool)]);
            assert.deepEqual((await readSeed()).rows, rows);
            await pool.query("DELETE FROM users WHERE id = $1", [rows[0].id]);
            await migrate(pool);
            assert.equal((await get()).pagination.total, 999);
          } finally {
            // Keep the existing API fixtures isolated from the initial seed.
            await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
          }
        },
      );

      await t.test(
        "seed preserves populated databases and failed migration rolls back atomically",
        async () => {
          const upgradeSchema = `${schema}_upgrade`;
          await admin.query(`CREATE SCHEMA ${upgradeSchema}`);
          const upgrade = new Pool({
            ...connectionConfig(),
            options: `-c search_path=${upgradeSchema}`,
          });
          try {
            await upgrade.query(
              await readFile(
                path.join(
                  __dirname,
                  "../src/database/migrations/001-initial.sql",
                ),
                "utf8",
              ),
            );
            const {
              rows: [existing],
            } = await upgrade.query(
              `INSERT INTO users (avatar, first_name, last_name, age, nationality)
               VALUES ('https://example.com/real.png', 'Existing', 'Person', 30, 'French') RETURNING *`,
            );
            await upgrade.query("INSERT INTO hobbies VALUES ($1, 'Reading')", [
              existing.id,
            ]);
            await migrate(upgrade);
            assert.deepEqual(
              (await upgrade.query("SELECT * FROM users")).rows,
              [existing],
            );
            assert.equal(
              (await upgrade.query("SELECT * FROM hobbies")).rows.length,
              1,
            );
            await upgrade.query("TRUNCATE users RESTART IDENTITY CASCADE");
            await migrate(upgrade);
            assert.equal(
              (await upgrade.query("SELECT COUNT(*)::integer count FROM users"))
                .rows[0].count,
              0,
            );
            await upgrade.query(
              "DELETE FROM schema_migrations WHERE version = '003-demo-seed.sql'",
            );
            await upgrade.query(
              "ALTER TABLE hobbies ADD CONSTRAINT reject_seed CHECK (hobby <> 'Reading')",
            );
            await assert.rejects(
              migrate(upgrade),
              (error) => error.code === "23514",
            );
            assert.equal(
              (await upgrade.query("SELECT COUNT(*)::integer count FROM users"))
                .rows[0].count,
              0,
            );
            assert.equal(
              (
                await upgrade.query(
                  "SELECT COUNT(*)::integer count FROM hobbies",
                )
              ).rows[0].count,
              0,
            );
            assert.equal(
              (
                await upgrade.query(
                  "SELECT * FROM schema_migrations WHERE version = '003-demo-seed.sql'",
                )
              ).rows.length,
              0,
            );
            await upgrade.query(
              "ALTER TABLE hobbies DROP CONSTRAINT reject_seed",
            );
            await Promise.all([migrate(upgrade), migrate(upgrade)]);
            assert.equal(
              (await upgrade.query("SELECT COUNT(*)::integer count FROM users"))
                .rows[0].count,
              1000,
            );
          } finally {
            await upgrade.end();
            await admin.query(`DROP SCHEMA ${upgradeSchema} CASCADE`);
          }
        },
      );

      await t.test(
        "atomic creation, filtering, sorting, pagination and rollback stay correct after migrate(pool)",
        async () => {
          assert.deepEqual(await get(), {
            data: [],
            pagination: { page: 1, limit: 40, total: 0, hasMore: false },
            facets: { hobbies: [], nationalities: [] },
          });
          const fixtures = [
            ["A_%\\", "American", ["Reading", "Cycling"], 30],
            ["Ava", "British", ["Reading"], 30],
            ["Ava", "American", [], 20],
            ["Zoe", "French", ["Cycling"], 50],
          ];
          for (const [first_name, nationality, hobbies, age] of fixtures) {
            const user = {
              avatar: "https://example.com/a.png",
              first_name,
              last_name: "Chen",
              age,
              nationality,
              hobbies,
            };
            const { response, json: created } = await post(user);
            assert.equal(response.status, 201);
            assert.ok(Number.isInteger(created.id));
            assert.deepEqual(created, { id: created.id, ...user });
            assert.deepEqual(
              (await get()).data.find((record) => record.id === created.id),
              { ...created, hobbies: [...hobbies].sort() },
            );
          }

          await migrate(pool);
          assert.equal((await get()).pagination.total, fixtures.length);
          const all = await get("sort=age&limit=2");
          assert.equal(all.pagination.total, 4);
          assert.equal(all.pagination.hasMore, true);
          assert.deepEqual(
            all.data.map((user) => user.id),
            [3, 1],
          );
          assert.deepEqual(all.data[0].hobbies, []);

          const second = await get("sort=age&limit=2&page=2");
          assert.deepEqual(
            second.data.map((user) => user.id),
            [2, 4],
          );
          assert.equal(second.pagination.hasMore, false);

          const orders = {
            first_name: { asc: [1, 2, 3, 4], desc: [4, 2, 3, 1] },
            last_name: { asc: [1, 2, 3, 4], desc: [1, 2, 3, 4] },
            age: { asc: [3, 1, 2, 4], desc: [4, 1, 2, 3] },
            nationality: { asc: [1, 3, 2, 4], desc: [4, 2, 1, 3] },
          };
          for (const [sort, directions] of Object.entries(orders)) {
            for (const [direction, expected] of Object.entries(directions)) {
              const query = `sort=${sort}&direction=${direction}&limit=2`;
              const pages = [await get(query), await get(`${query}&page=2`)];
              const ids = pages.flatMap((page) =>
                page.data.map((user) => user.id),
              );
              assert.deepEqual(
                ids,
                expected,
                `${sort} ${direction} uses id ASC ties`,
              );
              assert.equal(
                new Set(ids).size,
                4,
                `${sort} ${direction} has no overlaps`,
              );
              assert.deepEqual(
                pages.map((page) => [
                  page.pagination.total,
                  page.pagination.hasMore,
                ]),
                [
                  [4, true],
                  [4, false],
                ],
              );
              assert.deepEqual(pages[0].facets, pages[1].facets);
              assert.deepEqual(pages[0].facets, all.facets);
            }
          }

          const and = await get("hobby=Reading&hobby=Cycling");
          assert.equal(and.pagination.total, 1);
          assert.deepEqual(and.facets.hobbies, [
            { value: "Cycling", count: 1 },
            { value: "Reading", count: 1 },
          ]);

          const or = await get("nationality=American&nationality=British");
          assert.equal(or.pagination.total, 3);
          assert.deepEqual(or.facets.nationalities, [
            { value: "American", count: 2 },
            { value: "British", count: 1 },
          ]);

          const combined = await get(
            "nationality=American&hobby=Reading&search=A",
          );
          assert.equal(combined.pagination.total, 1);
          assert.deepEqual(combined.facets.nationalities, [
            { value: "American", count: 1 },
          ]);
          assert.equal(
            (await get(`search=${encodeURIComponent("_%\\")}`)).pagination
              .total,
            1,
          );
          assert.equal(
            (await get("search=%20%20Ava%20%20")).pagination.total,
            2,
          );
          assert.equal((await get("sort=constructor")).pagination.total, 4);
          assert.equal((await get("page=99")).data.length, 0);
          const missing = await get("search=does-not-exist");
          assert.deepEqual(missing.pagination, {
            page: 1,
            limit: 40,
            total: 0,
            hasMore: false,
          });
          assert.deepEqual(missing.facets.hobbies, []);
          assert.deepEqual(missing.facets.nationalities, []);

          await assert.rejects(
            transaction(async (client) => {
              const { rows } = await client.query(
                `INSERT INTO users (avatar, first_name, last_name, age, nationality)
                 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                ["https://example.com/a.png", "Rollback", "Test", 20, "French"],
              );
              await client.query(
                "INSERT INTO hobbies (user_id, hobby) SELECT $1, unnest($2::text[])",
                [rows[0].id, ["Duplicate", "Duplicate"]],
              );
            }, pool),
          );
          assert.equal((await get()).pagination.total, 4);

          const invalid = await fetch(base, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          assert.equal(invalid.status, 400);
        },
      );

      await t.test(
        "migrations are idempotent, concurrent, non-destructive and keep expected indexes",
        async () => {
          const before = (await get()).pagination.total;
          await Promise.all([migrate(pool), migrate(pool), migrate(pool)]);
          assert.equal((await get()).pagination.total, before);

          const versions = await pool.query(
            "SELECT version FROM schema_migrations ORDER BY version",
          );
          assert.deepEqual(
            versions.rows.map((row) => row.version),
            ["001-initial.sql", "002-query-indexes.sql", "003-demo-seed.sql"],
          );

          const indexes = await pool.query(
            `SELECT indexname
             FROM pg_indexes
             WHERE schemaname = current_schema()
               AND indexname IN (
                 'users_first_name_id',
                 'users_last_name_id',
                 'users_age_id',
                 'users_nationality_id',
                 'hobbies_hobby_user_id',
                 'hobbies_hobby'
               )
             ORDER BY indexname`,
          );
          assert.deepEqual(
            indexes.rows.map((row) => row.indexname),
            [
              "hobbies_hobby_user_id",
              "users_age_id",
              "users_first_name_id",
              "users_last_name_id",
              "users_nationality_id",
            ],
          );
          assert.ok(
            !indexes.rows.some((row) => row.indexname === "hobbies_hobby"),
          );
        },
      );

      await t.test(
        "statement timeout cancels long queries and the next query still succeeds",
        async () => {
          const timed = createDatabase({
            config: {
              connectionString: process.env.TEST_DATABASE_URL,
              max: 1,
              connectionTimeoutMillis: 500,
              statement_timeout: 50,
              lock_timeout: 3000,
              idle_in_transaction_session_timeout: 1000,
              idleTimeoutMillis: 1000,
            },
            maxQueue: 1,
          });
          try {
            await assert.rejects(
              timed.query("SELECT pg_sleep(0.2)"),
              (error) => error?.code === "57014",
            );
            const result = await timed.query("SELECT 1 AS value");
            assert.equal(result.rows[0].value, 1);
          } finally {
            await timed.end();
          }
        },
      );

      await t.test(
        "real pool acquisition timeout removes waiters and recovers",
        async () => {
          const bounded = createDatabase({
            config: {
              ...connectionConfig(),
              max: 1,
              connectionTimeoutMillis: 50,
            },
            maxQueue: 1,
            log: quiet,
          });
          let leased;
          try {
            leased = await bounded.connect();
            const waiting = bounded.query("SELECT 1");
            await assert.rejects(
              bounded.query("SELECT 1"),
              (error) => error.status === 503,
            );
            await assert.rejects(waiting, (error) => error.status === 503);
            assert.equal(bounded.stats().inFlight, 1);
            assert.equal(bounded.stats().waiting, 0);
            leased.release();
            leased = null;
            assert.equal(
              (await bounded.query("SELECT 1 AS value")).rows[0].value,
              1,
            );
            assert.equal(bounded.stats().inFlight, 0);
          } finally {
            leased?.release();
            await bounded.end();
          }
        },
      );

      await t.test(
        "lock timeout bounds contention without losing a connection",
        async () => {
          const timed = createDatabase({
            config: {
              ...connectionConfig(),
              max: 1,
              connectionTimeoutMillis: 500,
              statement_timeout: 500,
              lock_timeout: 50,
            },
            maxQueue: 1,
            log: quiet,
          });
          const holder = await pool.connect();
          try {
            await holder.query("BEGIN");
            await holder.query("UPDATE users SET age = age WHERE id = 1");
            await assert.rejects(
              timed.query("UPDATE users SET age = age WHERE id = 1"),
              (error) => error.code === "55P03",
            );
            assert.equal(
              (await timed.query("SELECT 1 AS value")).rows[0].value,
              1,
            );
          } finally {
            await holder.query("ROLLBACK");
            holder.release();
            await timed.end();
          }
        },
      );

      await t.test(
        "idle transaction expiry is handled on leased clients without crashing",
        async () => {
          let reportFailure;
          const reported = new Promise((resolve) => {
            reportFailure = resolve;
          });
          const timed = createDatabase({
            config: {
              ...connectionConfig(),
              max: 1,
              connectionTimeoutMillis: 500,
              idle_in_transaction_session_timeout: 50,
            },
            maxQueue: 1,
            log: { ...quiet, error: (fields) => reportFailure(fields.err) },
          });
          let leased;
          let deadline;
          try {
            leased = await timed.connect();
            await leased.query("BEGIN");
            const error = await Promise.race([
              reported,
              new Promise((_, reject) => {
                deadline = setTimeout(
                  () => reject(Error("Idle transaction was not terminated")),
                  2000,
                );
              }),
            ]);
            assert.equal(error.code, "25P03");
            await assert.rejects(
              leased.query("SELECT 1"),
              (failure) => failure.status === 503,
            );
            leased.release();
            leased = null;
            assert.equal(
              (await timed.query("SELECT 1 AS value")).rows[0].value,
              1,
            );
            assert.equal(timed.stats().inFlight, 0);
          } finally {
            clearTimeout(deadline);
            leased?.release();
            await timed.end();
          }
        },
      );

      await t.test(
        "tracing exports sanitized HTTP, service, transaction and database spans",
        async () => {
          const traceparent =
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
          const response = await fetch(
            `${base}?search=${encodeURIComponent("do-not-log")}`,
            { headers: { traceparent } },
          );
          assert.equal(response.status, 200);
          assert.match(
            response.headers.get("traceparent"),
            /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/,
          );

          await telemetry.forceFlush();
          const spans = exporter.getFinishedSpans();
          const requestSpan = spans.find(
            (entry) =>
              entry.name === "GET /api/users" &&
              entry.parentSpanContext?.spanId === "00f067aa0ba902b7",
          );
          assert.ok(requestSpan);
          assert.equal(requestSpan.attributes["http.request.method"], "GET");
          assert.equal(requestSpan.attributes["http.route"], "/api/users");
          assert.equal(
            requestSpan.attributes["http.response.status_code"],
            200,
          );
          const serviceSpan = spans.find(
            (entry) =>
              entry.name === "users.service.list" &&
              entry.parentSpanContext?.spanId ===
                requestSpan.spanContext().spanId,
          );
          assert.ok(serviceSpan);
          const repositorySpan = spans.find(
            (entry) =>
              entry.name === "users.repository.list" &&
              entry.parentSpanContext?.spanId ===
                serviceSpan.spanContext().spanId,
          );
          assert.ok(repositorySpan);
          const querySpans = spans.filter(
            (entry) =>
              entry.name === "db.query" &&
              entry.parentSpanContext?.spanId ===
                repositorySpan.spanContext().spanId,
          );
          assert.equal(querySpans.length, 1);
          assert.equal(querySpans[0].attributes["db.operation.name"], "SELECT");
          assert.ok(
            !spans.some(
              (entry) =>
                entry.name === "db.transaction" &&
                entry.spanContext().traceId ===
                  requestSpan.spanContext().traceId,
            ),
          );
          assert.ok(spans.some((entry) => entry.name === "db.transaction"));
          assert.ok(
            spans.some(
              (entry) =>
                entry.name === "db.query" &&
                entry.attributes["db.operation.name"] === "SELECT",
            ),
          );
          const exported = JSON.stringify(
            spans.map((entry) => ({
              name: entry.name,
              attributes: entry.attributes,
              status: entry.status,
              events: entry.events,
              resource: { attributes: entry.resource.attributes },
              parentSpanContext: entry.parentSpanContext,
            })),
          );
          assert.ok(!exported.includes("do-not-log"));
        },
      );

      await t.test(
        "concurrent GET and POST traffic respects maxInFlight and persists successful writes",
        async () => {
          const slowDatabase = {
            async connect() {
              const client = await pool.connect();
              return {
                query: async (...args) => {
                  await delay(15);
                  return client.query(...args);
                },
                release: (...args) => client.release(...args),
              };
            },
            async query(...args) {
              const client = await this.connect();
              try {
                return await client.query(...args);
              } finally {
                client.release();
              }
            },
            async end() {},
          };
          const burstApp = createApp({
            config: { mode: "test", origin: "", maxInFlight: 4 },
            log: quiet,
            database: slowDatabase,
            repository: createRepository({ database: slowDatabase }),
          });
          const burstServer = burstApp.listen(0);
          try {
            const burstBase = `http://127.0.0.1:${burstServer.address().port}/api/users`;
            const startingTotal = (await get()).pagination.total;
            const warmup = await Promise.all(
              [0, 1].map((index) =>
                fetch(burstBase, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    avatar: "https://example.com/burst.png",
                    first_name: `Burst${index}`,
                    last_name: "User",
                    age: 20 + (index % 30),
                    nationality: "American",
                    hobbies: [],
                  }),
                }),
              ),
            );
            assert.deepEqual(
              warmup.map((response) => response.status),
              [201, 201],
            );
            const firstWave = [
              { method: "GET", index: 2 },
              { method: "GET", index: 3 },
            ];
            const remaining = Array.from({ length: 96 }, (_, offset) => ({
              method: offset % 4 === 0 ? "POST" : "GET",
              index: offset + 4,
            }));
            const requests = [...firstWave, ...remaining].map(
              ({ method, index }) =>
                method === "POST"
                  ? fetch(burstBase, {
                      method,
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        avatar: "https://example.com/burst.png",
                        first_name: `Burst${index}`,
                        last_name: "User",
                        age: 20 + (index % 30),
                        nationality: "American",
                        hobbies: [],
                      }),
                    })
                  : fetch(burstBase),
            );
            const responses = [...warmup, ...(await Promise.all(requests))];
            const counts = responses.reduce((summary, response) => {
              summary[response.status] = (summary[response.status] || 0) + 1;
              return summary;
            }, {});
            assert.ok((counts[200] || 0) > 0);
            assert.ok((counts[201] || 0) > 0);
            assert.ok((counts[503] || 0) > 0);
            const final = await get();
            assert.equal(
              final.pagination.total,
              startingTotal + (counts[201] || 0),
            );
          } finally {
            burstServer.closeAllConnections();
            await new Promise((resolve) => burstServer.close(resolve));
          }
        },
      );
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      if (telemetry) await telemetry.shutdown();
      if (pool) await pool.end();
      process.env.DATABASE_URL = previousEnv.DATABASE_URL;
      process.env.PGOPTIONS = previousEnv.PGOPTIONS;
      process.env.NODE_ENV = previousEnv.NODE_ENV;
      process.env.OTEL_ENABLED = previousEnv.OTEL_ENABLED;
      process.env.OTEL_SAMPLE_RATIO = previousEnv.OTEL_SAMPLE_RATIO;
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      clearServerModules();
    }
  },
);
