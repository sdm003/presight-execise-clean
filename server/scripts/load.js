const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { Pool } = require("pg");
const { createApp } = require("../src/http/app");
const { createDatabase } = require("../src/database/pool");
const { migrate } = require("../src/database/migrate");
const { createRepository } = require("../src/modules/users/repository");
const { databaseConfig } = require("../src/config");

const quiet = { info() {}, error() {}, fatal() {} };
const empty = {
  data: [],
  pagination: { page: 1, limit: 40, total: 0, hasMore: false },
  facets: { hobbies: [], nationalities: [] },
};

async function exercise(repository, database, label) {
  const app = createApp({
    repository,
    database,
    log: quiet,
    config: { maxInFlight: 4 },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/users`;
  const timings = [];
  try {
    const started = performance.now();
    const responses = await Promise.all(
      Array.from({ length: 100 }, async (_, index) => {
        const start = performance.now();
        const response = await fetch(
          base,
          index % 5 === 0
            ? {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  avatar: "https://example.com/avatar.png",
                  first_name: `Load ${index}`,
                  last_name: "Test",
                  age: 25,
                  nationality: "Test",
                  hobbies: [],
                }),
              }
            : undefined,
        );
        await response.json();
        timings.push(performance.now() - start);
        if (response.status === 503)
          assert.equal(response.headers.get("retry-after"), "1");
        return response.status;
      }),
    );
    assert.ok(!responses.includes(500), "Burst must not surface HTTP 500");
    assert.ok(
      responses.every((status) => [200, 201, 503].includes(status)),
      responses.join(","),
    );
    assert.ok(
      responses.some((status) => status === 503),
      "Burst must exercise overload rejection",
    );
    assert.ok(
      responses.some((status) => status !== 503),
      "Some requests must succeed",
    );
    const recovery = await fetch(base);
    assert.equal(recovery.status, 200);
    const result = await recovery.json();
    if (label === "PostgreSQL")
      assert.equal(
        result.pagination.total,
        responses.filter((status) => status === 201).length,
      );
    const steadyStarted = performance.now();
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let index = 0; index < 10; index++) {
          const response = await fetch(base);
          assert.equal(
            response.status,
            200,
            "Within-capacity traffic must remain available",
          );
          await response.json();
        }
      }),
    );
    const steadyDuration = performance.now() - steadyStarted;
    assert.equal(app.locals.admission.stats().inFlight, 0);
    if (database.stats) {
      const stats = database.stats();
      assert.equal(stats.inFlight, 0);
      assert.equal(stats.waiting, 0);
      assert.ok(stats.total <= 2);
    }
    timings.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        scenario: label,
        requests: responses.length,
        concurrentBurst: 100,
        maxInFlight: 4,
        successful: responses.filter((status) => status !== 503).length,
        rejected: responses.filter((status) => status === 503).length,
        durationMs: Math.round(performance.now() - started),
        p95Ms: Math.round(timings[Math.floor(timings.length * 0.95)]),
        steadyRequests: 40,
        steadyRequestsPerSecond: Math.round(40000 / steadyDuration),
        recovered: true,
      }),
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function main() {
  await exercise(
    {
      listUsers: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return empty;
      },
      createUser: async (user) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { id: 1, ...user };
      },
    },
    { query: async () => ({ rows: [] }) },
    "HTTP admission",
  );
  if (!process.env.TEST_DATABASE_URL) {
    console.log(
      "PostgreSQL load scenario not run: set TEST_DATABASE_URL to a disposable test database.",
    );
    return;
  }
  const options = databaseConfig({
    ...process.env,
    DATABASE_URL: process.env.TEST_DATABASE_URL,
  });
  const admin = new Pool(options);
  const schema = `load_${randomBytes(8).toString("hex")}`;
  const database = createDatabase({
    config: {
      ...options,
      max: 2,
      options: `-c search_path=${schema}`,
      connectionTimeoutMillis: 1000,
    },
    maxQueue: 2,
    log: quiet,
  });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(database);
    await exercise(createRepository({ database }), database, "PostgreSQL");
  } finally {
    await database.end();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin.end();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
