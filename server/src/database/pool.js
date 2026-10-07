const { Pool } = require("pg");
const { context } = require("@opentelemetry/api");
const { databaseConfig } = require("../config");
const { AppError } = require("../shared/errors");
const { logger } = require("../observability/logger");
const { span } = require("../observability/tracing");

function createDatabase({
  config,
  maxQueue,
  factory = (options) => new Pool(options),
  log = logger,
} = {}) {
  let instance;
  let inFlight = 0;
  let closing = false;
  let capacity;
  let ending;
  function getPool() {
    if (!instance) {
      const { maxQueue: configuredQueue = 20, ...options } =
        config ?? databaseConfig();
      capacity = options.max + (maxQueue ?? configuredQueue);
      instance = factory(options);
      instance.on("error", (err) =>
        log.error({ err }, "database.idle_client_error"),
      );
    }
    return instance;
  }
  async function connect() {
    if (closing)
      throw new AppError("Service unavailable", 503, "DB_POOL_CLOSED");
    const source = getPool();
    if (inFlight >= capacity)
      throw new AppError("Service unavailable", 503, "DB_QUEUE_FULL");
    inFlight++;
    let client;
    try {
      client = await span("db.acquire", () => source.connect(), {
        "code.function.name": "connect",
      });
    } catch (error) {
      inFlight--;
      const unavailable = new AppError(
        "Service unavailable",
        503,
        "DB_ACQUIRE_FAILED",
      );
      unavailable.cause = error;
      throw unavailable;
    }
    let released = false;
    let connectionError;
    const onClientError = context.bind(context.active(), (error) => {
      connectionError ??= error;
      log.error({ err: error }, "database.leased_client_error");
    });
    // pg-pool only listens to client errors while the connection is idle.
    client.on?.("error", onClientError);
    const unavailable = () => {
      const error = new AppError("Service unavailable", 503);
      error.cause = connectionError;
      error.code = connectionError.code;
      return error;
    };
    return {
      query(sql, params) {
        const operation =
          typeof sql === "string"
            ? sql.trim().split(/\s+/, 1)[0].toUpperCase()
            : "QUERY";
        return span(
          "db.query",
          async () => {
            if (connectionError) throw unavailable();
            try {
              return await client.query(sql, params);
            } catch (error) {
              if (connectionError && (error === connectionError || !error.code))
                throw unavailable();
              throw error;
            }
          },
          {
            "db.system.name": "postgresql",
            "db.operation.name": operation,
            "code.function.name": "query",
          },
        );
      },
      release(discard) {
        if (released) return;
        released = true;
        try {
          client.release(connectionError ? true : discard);
        } finally {
          client.removeListener?.("error", onClientError);
          inFlight--;
        }
      },
    };
  }
  return {
    connect,
    async query(sql, params) {
      const client = await connect();
      let failed = false;
      try {
        return await client.query(sql, params);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        try {
          client.release();
        } catch (error) {
          if (!failed) throw error;
          log.error({ err: error }, "database.release_failed");
        }
      }
    },
    end() {
      closing = true;
      ending ??= instance ? instance.end() : Promise.resolve();
      return ending;
    },
    stats: () => ({
      inFlight,
      capacity: capacity ?? 0,
      waiting: instance?.waitingCount ?? 0,
      total: instance?.totalCount ?? 0,
      idle: instance?.idleCount ?? 0,
      closing,
    }),
  };
}

const pool = createDatabase();
module.exports = { createDatabase, pool };
