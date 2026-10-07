const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { EventEmitter, once } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { InMemorySpanExporter } = require("@opentelemetry/sdk-trace-base");
const { SpanStatusCode } = require("@opentelemetry/api");
const { httpConfig, databaseConfig, tracingConfig } = require("../src/config");
const {
  AppError,
  ConfigurationError,
  ValidationError,
} = require("../src/shared/errors");
const { validateUser } = require("../src/modules/users/validation");
const { transaction } = require("../src/database/transaction");
const { createDatabase } = require("../src/database/pool");
const { initializeTracing, span } = require("../src/observability/tracing");
const { createApp } = require("../src/index");
const { start } = require("../src/runtime/lifecycle");
const repositoryModule = require("../src/modules/users/repository");
const { admission } = require("../src/http/middleware/admission");

const quiet = { info() {}, error() {}, fatal() {} };
const config = {
  mode: "production",
  origin: "https://directory.example",
  port: 0,
  shutdownTimeout: 500,
  maxInFlight: 64,
  requestTimeout: 30000,
  headersTimeout: 10000,
  keepAliveTimeout: 5000,
};
const valid = {
  avatar: "https://example.com/a.png",
  first_name: "Ava",
  last_name: "Chen",
  age: 25,
  nationality: "American",
  hobbies: [],
};
const databaseUrl = "postgresql://localhost/directory";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

function runtime() {
  const result = new EventEmitter();
  result.codes = [];
  result.exit = (code) => result.codes.push(code);
  return result;
}

test("configuration validates bounds without exposing input or secret values", () => {
  assert.equal(databaseConfig({ DATABASE_URL: databaseUrl }).max, 5);
  assert.equal(
    databaseConfig({ DATABASE_URL: databaseUrl }).statement_timeout,
    15000,
  );
  assert.deepEqual(
    databaseConfig({ DATABASE_URL: databaseUrl, PG_SSL: "true" }).ssl,
    { rejectUnauthorized: true },
  );
  assert.equal(httpConfig({}).port, 3001);
  assert.equal(httpConfig({}).maxInFlight, 64);
  assert.equal(tracingConfig({}).enabled, false);
  assert.equal(tracingConfig({}).sampleRatio, 0.1);
  for (const [key, values] of Object.entries({
    DATABASE_URL: [
      "",
      "mysql://localhost/x",
      "postgresql://localhost/x?sslmode=no-verify",
      "postgresql://localhost/x?sslmode=require",
    ],
    PG_POOL_MAX: ["0", "-1", "1.5", "abc", "101", ""],
    PG_MAX_QUEUE: ["0", "-1", "1.5", "abc", "10001", ""],
    PG_SSL: ["1", "TRUE", ""],
    PG_CONNECT_TIMEOUT_MS: ["0", "120001"],
    PG_STATEMENT_TIMEOUT_MS: ["0", "300001"],
  })) {
    for (const value of values) {
      assert.throws(
        () => databaseConfig({ DATABASE_URL: databaseUrl, [key]: value }),
        (error) =>
          error instanceof ConfigurationError &&
          error.message === `Invalid configuration: ${key}`,
      );
    }
  }
  for (const [key, values] of Object.entries({
    OTEL_ENABLED: ["1", "TRUE", ""],
    OTEL_SAMPLE_RATIO: ["-0.1", "1.1", "abc", "Infinity"],
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: [
      "notaurl",
      "ftp://collector.example/v1/traces",
      "http://user:pass@collector.example/v1/traces",
    ],
  })) {
    for (const value of values) {
      assert.throws(
        () => tracingConfig({ [key]: value }),
        (error) =>
          error instanceof ConfigurationError &&
          error.message === `Invalid configuration: ${key}`,
      );
    }
  }
  for (const [key, value] of [
    ["PORT", "65536"],
    ["PORT", "0"],
    ["SHUTDOWN_TIMEOUT_MS", "0"],
    ["NODE_ENV", "anything"],
    ["CLIENT_ORIGIN", "https://example.com/path"],
    ["CLIENT_ORIGIN", "http://user:pass@example.com"],
  ])
    assert.throws(() => httpConfig({ [key]: value }), ConfigurationError);
  assert.throws(() => validateUser({}), ValidationError);
});

test("repository module exposes default methods and factory", () => {
  assert.equal(typeof repositoryModule.listUsers, "function");
  assert.equal(typeof repositoryModule.createUser, "function");
  assert.equal(typeof repositoryModule.createRepository, "function");
});

test("database pool wrapper is lazy, bounded, and preserves primary failures", async () => {
  const pending = [];
  let factoryCalls = 0;
  const releaseLog = [];
  const raw = {
    totalCount: 3,
    idleCount: 1,
    waitingCount: 0,
    on() {},
    connect() {
      const gate = deferred();
      pending.push(gate);
      raw.waitingCount = Math.max(0, pending.length - 1);
      return gate.promise;
    },
    async end() {},
  };
  const database = createDatabase({
    config: { max: 1, connectionTimeoutMillis: 25 },
    maxQueue: 1,
    log: quiet,
    factory(options) {
      factoryCalls++;
      assert.equal(options.max, 1);
      return raw;
    },
  });

  assert.deepEqual(database.stats(), {
    inFlight: 0,
    waiting: 0,
    idle: 0,
    total: 0,
    capacity: 0,
    closing: false,
  });

  const first = database.connect();
  const second = database.connect();
  await assert.rejects(
    database.connect(),
    (error) => error instanceof AppError && error.status === 503,
  );
  assert.equal(factoryCalls, 1);
  assert.deepEqual(database.stats(), {
    inFlight: 2,
    waiting: 1,
    idle: 1,
    total: 3,
    capacity: 2,
    closing: false,
  });

  pending[0].resolve({
    query: async () => ({ rows: [{ ok: 1 }] }),
    release(discard) {
      releaseLog.push(discard);
      raw.waitingCount = 0;
    },
  });
  const leased = await first;
  leased.release();
  assert.equal(database.stats().inFlight, 1);

  pending[1].resolve({
    query: async () => ({ rows: [] }),
    release(discard) {
      releaseLog.push(discard);
    },
  });
  const queued = await second;
  queued.release();
  assert.deepEqual(releaseLog, [undefined, undefined]);
  assert.equal(database.stats().inFlight, 0);

  let flakyFactoryCalls = 0;
  const flaky = createDatabase({
    config: { max: 1, connectionTimeoutMillis: 25 },
    maxQueue: 0,
    log: quiet,
    factory() {
      flakyFactoryCalls++;
      if (flakyFactoryCalls === 1) throw Error("factory failed");
      return {
        on() {},
        connect: async () => ({
          query: async () => ({ rows: [] }),
          release() {},
        }),
        async end() {},
      };
    },
  });
  await assert.rejects(flaky.connect(), /factory failed/);
  const recovered = await flaky.connect();
  recovered.release();
  assert.equal(flakyFactoryCalls, 2);

  const timeout = createDatabase({
    config: { max: 1, connectionTimeoutMillis: 25 },
    maxQueue: 0,
    log: quiet,
    factory: () => ({
      on() {},
      connect: async () => {
        throw Object.assign(Error("connect timeout"), { code: "ETIMEDOUT" });
      },
      async end() {},
    }),
  });
  await assert.rejects(
    timeout.connect(),
    (error) =>
      error instanceof AppError &&
      error.status === 503 &&
      error.cause?.code === "ETIMEDOUT",
  );
  assert.equal(timeout.stats().inFlight, 0);

  const releaseErrors = [];
  const queryFailure = Error("primary");
  const failingQuery = createDatabase({
    config: { max: 1, connectionTimeoutMillis: 25 },
    maxQueue: 0,
    log: {
      ...quiet,
      error: (fields) => releaseErrors.push(fields.err.message),
    },
    factory: () => ({
      on() {},
      connect: async () => ({
        query: async () => {
          throw queryFailure;
        },
        release() {
          throw Error("secondary release");
        },
      }),
      async end() {},
    }),
  });
  await assert.rejects(
    failingQuery.query("SELECT 1"),
    (error) => error === queryFailure,
  );
  assert.deepEqual(releaseErrors, ["secondary release"]);

  const successfulRelease = createDatabase({
    config: { max: 1, connectionTimeoutMillis: 25 },
    maxQueue: 0,
    log: quiet,
    factory: () => ({
      on() {},
      connect: async () => ({
        query: async () => ({ rows: [{ value: 1 }] }),
        release() {
          throw Error("release exploded");
        },
      }),
      async end() {},
    }),
  });
  await assert.rejects(successfulRelease.query("SELECT 1"), /release exploded/);

  let endCalls = 0;
  const closing = createDatabase({
    config: { max: 1, connectionTimeoutMillis: 25 },
    maxQueue: 0,
    log: quiet,
    factory: () => ({
      on() {},
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release() {},
      }),
      end: async () => {
        endCalls++;
      },
    }),
  });
  await closing.query("SELECT 1");
  await closing.end();
  await assert.rejects(
    closing.query("SELECT 1"),
    (error) => error instanceof AppError && error.status === 503,
  );
  assert.equal(endCalls, 1);
  assert.equal(closing.stats().closing, true);
});

test("database pool stats mirror raw pool counters after initialization", async () => {
  const raw = {
    totalCount: 4,
    idleCount: 2,
    waitingCount: 1,
    on() {},
    connect: async () => ({
      query: async () => ({ rows: [] }),
      release() {},
    }),
    async end() {},
  };
  const database = createDatabase({
    config: { max: 3, maxQueue: 2, connectionTimeoutMillis: 25 },
    log: quiet,
    factory: () => raw,
  });
  await database.query("SELECT 1");
  assert.deepEqual(database.stats(), {
    inFlight: 0,
    waiting: 1,
    idle: 2,
    total: 4,
    capacity: 5,
    closing: false,
  });
});

test("admission middleware exposes stats and releases after held work completes", async () => {
  const gate = deferred();
  const started = deferred();
  const capacity = admission({ maxInFlight: 1, isDraining: () => false });
  const app = createApp({
    config: { mode: "test", origin: "", maxInFlight: 1 },
    log: quiet,
    database: { query: async () => ({ rows: [{ ok: 1 }] }) },
    repository: {
      listUsers: async () => {
        started.resolve();
        await gate.promise;
        return {
          data: [],
          pagination: { page: 1, limit: 40, total: 0, hasMore: false },
          facets: { hobbies: [], nationalities: [] },
        };
      },
    },
  });
  assert.deepEqual(capacity.stats(), { inFlight: 0, capacity: 1 });
  assert.deepEqual(app.locals.admission.stats(), { inFlight: 0, capacity: 1 });
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/users`;
    const pending = fetch(base);
    await started.promise;
    assert.deepEqual(app.locals.admission.stats(), {
      inFlight: 1,
      capacity: 1,
    });
    const blocked = await fetch(base);
    assert.equal(blocked.status, 503);
    gate.resolve();
    assert.equal((await pending).status, 200);
    assert.deepEqual(app.locals.admission.stats(), {
      inFlight: 0,
      capacity: 1,
    });
  } finally {
    gate.resolve();
    await closeServer(server);
  }
});

test("admission middleware holds tokens until both work and response termination", () => {
  const middleware = admission({ maxInFlight: 1, isDraining: () => false });
  const response = new EventEmitter();
  response.setHeader = () => {};
  response.status = () => response;
  response.json = () => response;
  middleware({}, response, () => {});
  assert.deepEqual(middleware.stats(), { inFlight: 1, capacity: 1 });
  response.emit("finish");
  assert.deepEqual(middleware.stats(), { inFlight: 0, capacity: 1 });

  const heldResponse = new EventEmitter();
  heldResponse.setHeader = () => {};
  heldResponse.status = () => heldResponse;
  heldResponse.json = () => heldResponse;
  const heldRequest = {};
  middleware(heldRequest, heldResponse, () => {});
  heldRequest.admission.hold();
  heldRequest.admission.complete();
  assert.deepEqual(middleware.stats(), { inFlight: 1, capacity: 1 });
  heldResponse.emit("finish");
  assert.deepEqual(middleware.stats(), { inFlight: 0, capacity: 1 });

  const abortedResponse = new EventEmitter();
  abortedResponse.setHeader = () => {};
  abortedResponse.status = () => abortedResponse;
  abortedResponse.json = () => abortedResponse;
  const abortedRequest = {};
  middleware(abortedRequest, abortedResponse, () => {});
  abortedRequest.admission.hold();
  abortedResponse.emit("close");
  assert.deepEqual(middleware.stats(), { inFlight: 1, capacity: 1 });
  abortedRequest.admission.complete();
  assert.deepEqual(middleware.stats(), { inFlight: 0, capacity: 1 });
});

test("HTTP boundaries, repository contracts, readiness, errors, CORS and safe logs", async () => {
  const records = [];
  let failure;
  let databaseFailure;
  let writes = 0;
  let databaseReads = 0;
  const result = {
    data: [],
    pagination: { page: 1, limit: 40, total: 0, hasMore: false },
    facets: { hobbies: [], nationalities: [] },
  };
  const app = createApp({
    config: { mode: "production", origin: config.origin },
    log: {
      info: (fields) => records.push(fields),
      error: (fields) =>
        records.push({
          requestId: fields.requestId,
          failed: true,
          err: fields.err,
        }),
      fatal() {},
    },
    database: {
      query: async () => {
        databaseReads++;
        if (databaseFailure) throw databaseFailure;
        return { rows: [{ ok: 1 }] };
      },
    },
    repository: {
      listUsers: async () => {
        if (failure) throw failure;
        return result;
      },
      createUser: async (user) => {
        writes++;
        if (failure) throw failure;
        return { id: 1, ...user };
      },
    },
  });
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (body, headers = { "Content-Type": "application/json" }) =>
      fetch(`${base}/api/users`, { method: "POST", headers, body });

    const live = await fetch(`${base}/api/live`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { ok: true });
    assert.equal(databaseReads, 0);

    const healthy = await fetch(`${base}/api/health`);
    assert.deepEqual(await healthy.json(), { ok: true });
    const ready = await fetch(`${base}/api/ready`);
    assert.deepEqual(await ready.json(), { ok: true });
    assert.equal(databaseReads, 2);

    const list = await fetch(`${base}/api/users?******`, {
      headers: { "X-Request-ID": "untrusted-do-not-log" },
    });
    assert.deepEqual(await list.json(), result);
    const requestId = list.headers.get("x-request-id");
    assert.match(requestId, /^[0-9a-f-]{36}$/);
    assert.equal(list.headers.get("x-powered-by"), null);
    assert.equal(list.headers.get("x-content-type-options"), "nosniff");
    assert.equal(list.headers.get("x-frame-options"), "DENY");
    assert.equal(list.headers.get("referrer-policy"), "no-referrer");
    assert.ok(
      records.some(
        (entry) =>
          entry.requestId === requestId &&
          entry.method === "GET" &&
          entry.route === "/api/users" &&
          entry.status === 200,
      ),
    );

    const created = await post(JSON.stringify(valid));
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { id: 1, ...valid });

    for (const [body, headers, status, message] of [
      ["{}", undefined, 400, "avatar"],
      ["{broken", undefined, 400, "Invalid JSON"],
      [
        JSON.stringify({ secret: "x".repeat(33000) }),
        undefined,
        413,
        "too large",
      ],
      [
        JSON.stringify(valid),
        { "Content-Type": "text/plain" },
        415,
        "Content-Type",
      ],
      [
        JSON.stringify(valid),
        { "Content-Type": "application/json; charset=not-real" },
        415,
        "Unsupported body encoding",
      ],
    ]) {
      const response = await post(body, headers);
      assert.equal(response.status, status);
      assert.ok((await response.json()).error.includes(message));
    }
    assert.equal(writes, 1);

    failure = new TypeError("do-not-log SQL credentials");
    const failedCreate = await post(JSON.stringify(valid));
    assert.equal(failedCreate.status, 500);
    assert.deepEqual(await failedCreate.json(), {
      error: "Internal server error",
    });

    failure = new AppError("do-not-log operational error", 500);
    const internal = await fetch(`${base}/api/users`);
    assert.equal(internal.status, 500);
    assert.deepEqual(await internal.json(), { error: "Internal server error" });

    failure = new AppError("hidden overload detail", 503);
    const unavailable = await fetch(`${base}/api/users`);
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get("retry-after"), "1");
    assert.deepEqual(await unavailable.json(), {
      error: "Service unavailable",
    });

    failure = Object.assign(Error("do-not-log"), { code: "ECONNREFUSED" });
    const failedList = await fetch(`${base}/api/users`);
    assert.equal(failedList.status, 503);
    assert.equal(failedList.headers.get("retry-after"), "1");
    assert.deepEqual(await failedList.json(), { error: "Service unavailable" });

    databaseFailure = failure;
    const unhealthy = await fetch(`${base}/api/health`);
    assert.equal(unhealthy.status, 503);
    assert.deepEqual(await unhealthy.json(), { error: "Service unavailable" });

    for (const method of ["OPTIONS", "POST"]) {
      const denied = await fetch(`${base}/api/users`, {
        method,
        headers: {
          Origin: "https://other.example",
          "Content-Type": "application/json",
        },
        ...(method === "POST" ? { body: JSON.stringify(valid) } : {}),
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.headers.get("access-control-allow-origin"), null);
    }

    const allowed = await fetch(`${base}/api/users`, {
      method: "OPTIONS",
      headers: { Origin: config.origin },
    });
    assert.equal(allowed.status, 204);
    assert.equal(
      allowed.headers.get("access-control-allow-origin"),
      config.origin,
    );
    const exposed = allowed.headers
      .get("access-control-expose-headers")
      .split(/\s*,\s*/);
    assert.ok(exposed.includes("X-Request-ID"));
    assert.ok(exposed.includes("traceparent"));
    assert.match(allowed.headers.get("vary"), /Origin/);

    const missing = await fetch(`${base}/api/secret-do-not-log`);
    assert.equal(missing.status, 404);
    assert.ok(!JSON.stringify(records).includes("do-not-log"));
    assert.ok(!JSON.stringify(records).includes("untrusted"));
    assert.notEqual(missing.headers.get("x-request-id"), requestId);
  } finally {
    await closeServer(server);
  }
});

test("CORS permits same-origin writes and only configured or development cross origins", async () => {
  for (const settings of [
    { mode: "production", origin: "" },
    { mode: "production", origin: config.origin },
    { mode: "development", origin: "" },
  ]) {
    let writes = 0;
    const app = createApp({
      config: settings,
      log: quiet,
      repository: {
        listUsers: async () => ({
          data: [],
          pagination: { page: 1, limit: 40, total: 0, hasMore: false },
          facets: { hobbies: [], nationalities: [] },
        }),
        createUser: async (user) => ({ id: ++writes, ...user }),
      },
      database: { query: async () => ({ rows: [{ ok: 1 }] }) },
    });
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const origins = [
        [base, true],
        [config.origin, settings.origin === config.origin],
        ["http://localhost:5173", settings.mode === "development"],
        ["https://other.example", false],
        [base.replace("http:", "https:"), settings.mode === "development"],
        ["http://127.0.0.1:1", settings.mode === "development"],
        ["null", false],
        [`${base}/path`, false],
      ];
      let expectedWrites = 0;
      for (const [origin, allowed] of origins) {
        for (const method of ["POST", "OPTIONS"]) {
          const response = await fetch(`${base}/api/users`, {
            method,
            headers: {
              Origin: origin,
              "Content-Type": "application/json",
              "X-Forwarded-Host": "other.example",
              "X-Forwarded-Proto": "https",
              "Sec-Fetch-Site": "same-origin",
            },
            ...(method === "POST" ? { body: JSON.stringify(valid) } : {}),
          });
          assert.equal(
            response.status,
            allowed ? (method === "POST" ? 201 : 204) : 403,
            `${settings.mode}, ${settings.origin}, ${method}, ${origin}`,
          );
          assert.equal(
            response.headers.get("access-control-allow-origin"),
            allowed ? origin : null,
          );
          if (allowed && method === "POST") expectedWrites++;
          assert.equal(writes, expectedWrites);
        }
      }
    } finally {
      await closeServer(server);
    }
  }
});

test("admission rejects before body parse and draining exempts only liveness", async () => {
  const firstList = deferred();
  const listed = deferred();
  let writes = 0;
  const app = createApp({
    config: { mode: "test", origin: "", maxInFlight: 1 },
    log: quiet,
    database: { query: async () => ({ rows: [{ ok: 1 }] }) },
    repository: {
      listUsers: async () => {
        listed.resolve();
        await firstList.promise;
        return {
          data: [],
          pagination: { page: 1, limit: 40, total: 0, hasMore: false },
          facets: { hobbies: [], nationalities: [] },
        };
      },
      createUser: async (body) => {
        writes++;
        return { id: writes, ...body };
      },
    },
  });
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const inFlight = fetch(`${base}/api/users`);
    await listed.promise;

    const rejected = await fetch(`${base}/api/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ giant: "x".repeat(33000) }),
    });
    assert.equal(rejected.status, 503);
    assert.equal(rejected.headers.get("retry-after"), "1");
    assert.deepEqual(await rejected.json(), { error: "Service unavailable" });
    assert.equal(writes, 0);

    app.locals.draining = true;
    const live = await fetch(`${base}/api/live`);
    assert.equal(live.status, 200);
    const ready = await fetch(`${base}/api/ready`);
    assert.equal(ready.status, 503);
    const drainingUsers = await fetch(`${base}/api/users`);
    assert.equal(drainingUsers.status, 503);
    app.locals.draining = false;

    firstList.resolve();
    assert.equal((await inFlight).status, 200);
    const recovered = await fetch(`${base}/api/users`);
    assert.equal(recovered.status, 200);
  } finally {
    firstList.resolve();
    await closeServer(server);
  }
});

test("aborted clients keep admission slots until the repository finishes", async () => {
  const hold = deferred();
  const started = deferred();
  const app = createApp({
    config: { mode: "test", origin: "", maxInFlight: 1 },
    log: quiet,
    database: { query: async () => ({ rows: [{ ok: 1 }] }) },
    repository: {
      listUsers: async () => {
        started.resolve();
        await hold.promise;
        return {
          data: [],
          pagination: { page: 1, limit: 40, total: 0, hasMore: false },
          facets: { hobbies: [], nationalities: [] },
        };
      },
    },
  });
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/users`;
    let request;
    const aborted = new Promise((resolve) => {
      request = http.get(url, () => resolve());
      request.on("error", () => resolve());
    });
    await started.promise;
    request.destroy();
    await aborted;

    const saturated = await fetch(url);
    assert.equal(saturated.status, 503);

    hold.resolve();
    await delay(20);
    const recovered = await fetch(url);
    assert.equal(recovered.status, 200);
  } finally {
    hold.resolve();
    await closeServer(server);
  }
});

test("tracing extracts traceparent, sanitizes spans and exports request and database metadata", async () => {
  const noop = initializeTracing({ env: { OTEL_ENABLED: "false" } });
  assert.equal(noop.provider, undefined);

  const exporter = new InMemorySpanExporter();
  const telemetry = initializeTracing({
    exporter,
    env: { OTEL_ENABLED: "true" },
    sampleRatio: 1,
  });
  const database = createDatabase({
    config: { max: 1, connectionTimeoutMillis: 25 },
    maxQueue: 0,
    log: quiet,
    factory: () => ({
      on() {},
      connect: async () => ({
        query: async () => ({ rows: [{ ok: 1 }] }),
        release() {},
      }),
      async end() {},
    }),
  });
  const app = createApp({
    config: { mode: "test", origin: config.origin },
    log: quiet,
    database: { query: async () => ({ rows: [{ ok: 1 }] }) },
    repository: {
      listUsers: async () => ({
        data: [],
        pagination: { page: 1, limit: 40, total: 0, hasMore: false },
        facets: { hobbies: [], nationalities: [] },
      }),
      createUser: async (body) => ({ id: 1, ...body }),
    },
  });
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const parent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const [first, second] = await Promise.all([
      fetch(`${base}/api/users?secret=do-not-log`, {
        headers: { Origin: config.origin, traceparent: parent },
      }),
      fetch(`${base}/api/users`),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.match(
      first.headers.get("traceparent"),
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/,
    );
    const exposed = first.headers
      .get("access-control-expose-headers")
      .split(/\s*,\s*/);
    assert.ok(exposed.includes("X-Request-ID"));
    assert.ok(exposed.includes("traceparent"));

    await database.query("SELECT 1", ["do-not-log"]);
    await assert.rejects(
      span("users.list", async () => {
        throw Error("do-not-log");
      }),
    );
    await telemetry.forceFlush();

    const spans = exporter.getFinishedSpans();
    const requestSpan = spans.find(
      (entry) =>
        entry.name === "GET /api/users" &&
        entry.parentSpanContext?.spanId === "00f067aa0ba902b7",
    );
    assert.equal(requestSpan.parentSpanContext.spanId, "00f067aa0ba902b7");
    assert.equal(requestSpan.attributes["http.request.method"], "GET");
    assert.equal(requestSpan.attributes["http.route"], "/api/users");
    assert.equal(requestSpan.attributes["http.response.status_code"], 200);
    assert.ok(
      spans.some(
        (entry) =>
          entry.name === "db.query" &&
          entry.attributes["db.operation.name"] === "SELECT",
      ),
    );
    const errorSpan = spans.find(
      (entry) =>
        entry.name === "users.list" &&
        entry.status.code === SpanStatusCode.ERROR,
    );
    assert.equal(errorSpan.status.code, SpanStatusCode.ERROR);
    const requestTraceIds = spans
      .filter((entry) => entry.name === "GET /api/users")
      .map((entry) => entry.spanContext().traceId);
    assert.equal(new Set(requestTraceIds).size, requestTraceIds.length);
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
  } finally {
    await closeServer(server);
    await database.end();
    await telemetry.shutdown();
  }
});

test("transactions preserve primary failure, rollback and discard broken clients", async () => {
  for (const failAt of [
    "BEGIN",
    "work",
    "COMMIT",
    "ROLLBACK",
    "release",
    "none",
  ]) {
    const primary = Error("primary");
    const calls = [];
    let released;
    const source = {
      connect: async () => ({
        query: async (sql) => {
          calls.push(sql);
          if (sql === failAt && failAt !== "ROLLBACK") throw primary;
          if (failAt === "ROLLBACK" && sql === "ROLLBACK")
            throw Error("secondary");
        },
        release: (discard) => {
          released = discard;
          if (failAt === "release") throw Error("release");
        },
      }),
    };
    const run = transaction(async () => {
      if (["work", "ROLLBACK"].includes(failAt)) throw primary;
      return 42;
    }, source);
    if (failAt === "none") assert.equal(await run, 42);
    else if (failAt === "release") await assert.rejects(run, /release/);
    else await assert.rejects(run, (error) => error === primary);
    assert.deepEqual(
      calls,
      failAt === "BEGIN"
        ? ["BEGIN"]
        : ["work", "ROLLBACK"].includes(failAt)
          ? ["BEGIN", "ROLLBACK"]
          : failAt === "COMMIT"
            ? ["BEGIN", "COMMIT", "ROLLBACK"]
            : ["BEGIN", "COMMIT"],
    );
    assert.equal(released, ["BEGIN", "ROLLBACK"].includes(failAt));
  }

  const primary = Error("work");
  await assert.rejects(
    transaction(
      async () => {
        throw primary;
      },
      {
        connect: async () => ({
          query: async () => {},
          release: () => {
            throw Error("secondary release");
          },
        }),
      },
    ),
    (error) => error === primary,
  );

  let released = false;
  const connectError = Error("connect");
  await assert.rejects(
    transaction(() => {}, {
      connect: async () => {
        throw connectError;
      },
    }),
    (error) => error === connectError,
  );

  const networkError = Object.assign(Error("network"), { code: "ECONNRESET" });
  await assert.rejects(
    transaction(
      () => {
        throw networkError;
      },
      {
        connect: async () => ({
          query: async () => {},
          release: (discard) => {
            released = discard;
          },
        }),
      },
    ),
    (error) => error === networkError,
  );
  assert.equal(released, true);

  let caught = false;
  try {
    await transaction(
      () => {
        throw null;
      },
      {
        connect: async () => ({
          query: async () => {},
          release: () => {
            throw Error("secondary release");
          },
        }),
      },
    );
  } catch (error) {
    caught = true;
    assert.equal(error, null);
  }
  assert.equal(caught, true);
});

test("startup failures close the pool and do not register process handlers", async () => {
  const app = createApp({ config, log: quiet });
  const blocker = app.listen(0);
  const process = runtime();
  let ended = 0;
  try {
    await assert.rejects(
      start(app, {
        config: { ...config, port: blocker.address().port },
        runtime: process,
        log: quiet,
        database: {
          query: async () => {},
          end: async () => {
            ended++;
          },
        },
      }),
      { code: "EADDRINUSE" },
    );
    assert.equal(ended, 1);
    assert.equal(process.eventNames().length, 0);
    await assert.rejects(
      start(app, {
        config,
        runtime: process,
        log: quiet,
        database: {
          query: async () => {
            throw Error("database");
          },
          end: async () => {
            ended++;
          },
        },
      }),
      /database/,
    );
    assert.equal(ended, 2);
  } finally {
    await closeServer(blocker);
  }
});

test("startup failure still shuts down telemetry when database cleanup fails", async () => {
  const app = createApp({ config, log: quiet });
  const process = runtime();
  let telemetryShutdowns = 0;
  await assert.rejects(
    start(app, {
      config,
      runtime: process,
      log: quiet,
      telemetry: {
        shutdown: async () => {
          telemetryShutdowns++;
        },
      },
      database: {
        query: async () => {
          throw Error("database");
        },
        end: async () => {
          throw Error("cleanup failed");
        },
      },
    }),
    /database/,
  );
  assert.equal(telemetryShutdowns, 1);
  assert.equal(process.eventNames().length, 0);
});

test("shutdown drains active requests, runs once and upgrades fatal exit code", async () => {
  let finishRequest;
  let requestArrived;
  const arrived = new Promise((resolve) => {
    requestArrived = resolve;
  });
  let telemetryShutdowns = 0;
  const app = createApp({
    config,
    log: quiet,
    repository: {
      listUsers: () =>
        new Promise((resolve) => {
          finishRequest = () =>
            resolve({
              data: [],
              pagination: { page: 1, limit: 40, total: 0, hasMore: false },
              facets: { hobbies: [], nationalities: [] },
            });
          requestArrived();
        }),
    },
    database: { query: async () => ({ rows: [{ ok: 1 }] }) },
  });
  let ended = 0;
  const process = runtime();
  const running = await start(app, {
    config,
    log: quiet,
    runtime: process,
    telemetry: {
      shutdown: async () => {
        telemetryShutdowns++;
      },
    },
    database: {
      query: async () => {},
      end: async () => {
        ended++;
      },
    },
  });
  const response = fetch(
    `http://127.0.0.1:${running.server.address().port}/api/users`,
  );
  await arrived;
  const stopped = running.shutdown("SIGTERM");
  assert.equal(ended, 0);
  assert.equal(running.shutdown("fatal", Error("fatal"), 1), stopped);
  finishRequest();
  assert.equal((await response).status, 200);
  await stopped;
  assert.equal(ended, 1);
  assert.equal(telemetryShutdowns, 1);
  assert.deepEqual(process.codes, [1]);
  assert.equal(process.eventNames().length, 0);
});

test("shutdown marks draining and still shuts down telemetry after database end failure", async () => {
  const requestGate = deferred();
  const requestStarted = deferred();
  let telemetryShutdowns = 0;
  const process = runtime();
  const app = createApp({
    config,
    log: quiet,
    database: { query: async () => ({ rows: [{ ok: 1 }] }) },
    repository: {
      listUsers: async () => {
        requestStarted.resolve();
        await requestGate.promise;
        return {
          data: [],
          pagination: { page: 1, limit: 40, total: 0, hasMore: false },
          facets: { hobbies: [], nationalities: [] },
        };
      },
    },
  });
  const running = await start(app, {
    config,
    log: quiet,
    runtime: process,
    telemetry: {
      shutdown: async () => {
        telemetryShutdowns++;
      },
    },
    database: {
      query: async () => {},
      end: async () => {
        throw Error("end failed");
      },
    },
  });
  try {
    const pending = fetch(
      `http://127.0.0.1:${running.server.address().port}/api/users`,
    );
    await requestStarted.promise;
    const stopping = running.shutdown("SIGTERM");
    assert.equal(app.locals.draining, true);
    requestGate.resolve();
    assert.equal((await pending).status, 200);
    await stopping;
    assert.equal(telemetryShutdowns, 1);
    assert.deepEqual(process.codes, [1]);
  } finally {
    requestGate.resolve();
  }
});

test("shutdown has a deadline even when pool cleanup hangs", async () => {
  const process = runtime();
  const running = await start(createApp({ config, log: quiet }), {
    config: { ...config, shutdownTimeout: 30 },
    log: quiet,
    runtime: process,
    database: { query: async () => {}, end: () => new Promise(() => {}) },
  });
  await running.shutdown("SIGTERM");
  assert.deepEqual(process.codes, [1]);
});

test("shutdown deadline destroys hanging requests and exits nonzero only once", async () => {
  let arrived;
  const requestStarted = new Promise((resolve) => {
    arrived = resolve;
  });
  const process = runtime();
  const running = await start(
    createApp({
      config,
      log: quiet,
      database: { query: async () => ({ rows: [{ ok: 1 }] }) },
      repository: {
        listUsers: () => {
          arrived();
          return new Promise(() => {});
        },
      },
    }),
    {
      config: { ...config, shutdownTimeout: 30 },
      log: quiet,
      runtime: process,
      database: { query: async () => {}, end: async () => {} },
    },
  );
  const failedRequest = assert.rejects(
    fetch(`http://127.0.0.1:${running.server.address().port}/api/users`),
  );
  await requestStarted;
  await running.shutdown("SIGTERM");
  await failedRequest;
  assert.deepEqual(process.codes, [1]);
});

test("CLI configuration failures identify the key without leaking secret values", () => {
  for (const entry of ["setup", "index"]) {
    const child = spawnSync(process.execPath, [`server/src/${entry}.js`], {
      cwd: path.join(__dirname, "../.."),
      env: {
        ...process.env,
        DATABASE_URL: "invalid",
        NODE_ENV: "test",
        PORT: "3001",
        CLIENT_ORIGIN: "",
        SHUTDOWN_TIMEOUT_MS: "10000",
      },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(child.status, 1, child.stderr);
    const record = JSON.parse(child.stdout.trim());
    assert.equal(record.err.type, "ConfigurationError");
    assert.equal(record.err.key, "DATABASE_URL");
    assert.ok(!child.stdout.includes("do-not-log"));
    assert.equal(child.stderr, "");
  }
});

test("real process SIGTERM and fatal errors terminate cleanly with sanitized logs", async () => {
  for (const mode of ["signal", "rejection", "exception"]) {
    const script = `
      const { createApp } = require('./server/src/index');
      const { start } = require('./server/src/runtime/lifecycle');
      const { logger } = require('./server/src/observability/logger');
      logger.error({ err: Object.assign(Error('do-not-log SQL password'), {
        code: 'ECONNREFUSED', detail: 'do-not-log'
      }), password: 'do-not-log', authorization: 'do-not-log' }, 'test.redaction');
      start(createApp(), {
        config: { port: 0, shutdownTimeout: 500 },
        database: { query: async () => {}, end: async () => {} }
      }).then(() => {
        console.log('READY');
        process.stdin.once('data', () => {
          if (${JSON.stringify(mode)} === 'exception')
            throw Error('do-not-log');
          Promise.reject(Error('do-not-log'));
        });
      });
    `;
    const child = spawn(process.execPath, ["-e", script], {
      cwd: path.join(__dirname, "../.."),
      env: { ...process.env, NODE_ENV: "test", PORT: "3001" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      await new Promise((resolve, reject) => {
        child.stdout.on("data", () => {
          if (output.includes("READY")) resolve();
        });
        child.once("error", reject);
        child.once("exit", () => {
          if (!output.includes("READY")) reject(Error(stderr));
        });
      });
      const exited = once(child, "exit");
      if (mode === "signal") child.kill("SIGTERM");
      else child.stdin.write("fail");
      const [code, signal] = await exited;
      assert.equal(signal, null);
      assert.equal(code, mode === "signal" ? 0 : 1);
      assert.ok(output.includes("shutdown.completed"));
      assert.ok(output.includes("ECONNREFUSED"));
      assert.ok(output.includes("[Redacted]"));
      assert.ok(!output.includes("do-not-log"));
      assert.equal(stderr, "");
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  }
});

test("importing app and setup has no database or process handler side effects", () => {
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const assert = require('node:assert/strict');
    require('pg').Pool = class {
      constructor() { throw Error('Pool must not be constructed on import'); }
    };
    const events = ['SIGTERM', 'SIGINT', 'unhandledRejection', 'uncaughtException'];
    const before = events.map(name => process.listenerCount(name));
    require('./server/src/index');
    require('./server/src/setup');
    assert.deepEqual(events.map(name => process.listenerCount(name)), before);
  `,
    ],
    {
      cwd: path.join(__dirname, "../.."),
      env: {
        ...process.env,
        DATABASE_URL: "invalid",
        NODE_ENV: "test",
        PORT: "3001",
        CLIENT_ORIGIN: "",
        SHUTDOWN_TIMEOUT_MS: "10000",
      },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
});
