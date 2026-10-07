const { ConfigurationError } = require("../shared/errors");

function integer(env, key, fallback, max) {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new ConfigurationError(key);
  return value;
}

function httpConfig(env = process.env) {
  const mode = env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(mode))
    throw new ConfigurationError("NODE_ENV");
  let origin = "";
  if (env.CLIENT_ORIGIN) {
    let url;
    try {
      url = new URL(env.CLIENT_ORIGIN);
    } catch {
      throw new ConfigurationError("CLIENT_ORIGIN");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.origin !== env.CLIENT_ORIGIN ||
      url.username ||
      url.password
    )
      throw new ConfigurationError("CLIENT_ORIGIN");
    origin = url.origin;
  }
  return {
    mode,
    origin,
    port: integer(env, "PORT", 3001, 65535),
    shutdownTimeout: integer(env, "SHUTDOWN_TIMEOUT_MS", 10000, 120000),
    maxInFlight: integer(env, "HTTP_MAX_IN_FLIGHT", 64, 10000),
    requestTimeout: integer(env, "HTTP_REQUEST_TIMEOUT_MS", 30000, 120000),
    headersTimeout: integer(env, "HTTP_HEADERS_TIMEOUT_MS", 10000, 120000),
    keepAliveTimeout: integer(env, "HTTP_KEEP_ALIVE_TIMEOUT_MS", 5000, 60000),
  };
}

function databaseConfig(env = process.env) {
  let url;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    throw new ConfigurationError("DATABASE_URL");
  }
  // URL TLS flags must never override certificate verification.
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    (url.searchParams.has("sslmode") &&
      url.searchParams.get("sslmode") !== "verify-full") ||
    ["ssl", "sslrootcert", "sslcert", "sslkey"].some((key) =>
      url.searchParams.has(key),
    )
  )
    throw new ConfigurationError("DATABASE_URL");
  if (env.PG_SSL !== undefined && !["true", "false"].includes(env.PG_SSL))
    throw new ConfigurationError("PG_SSL");
  return {
    connectionString: env.DATABASE_URL,
    max: integer(env, "PG_POOL_MAX", 5, 100),
    maxQueue: integer(env, "PG_MAX_QUEUE", 20, 10000),
    connectionTimeoutMillis: integer(
      env,
      "PG_CONNECT_TIMEOUT_MS",
      10000,
      120000,
    ),
    statement_timeout: integer(env, "PG_STATEMENT_TIMEOUT_MS", 15000, 300000),
    lock_timeout: integer(env, "PG_LOCK_TIMEOUT_MS", 3000, 120000),
    idle_in_transaction_session_timeout: integer(
      env,
      "PG_IDLE_TRANSACTION_TIMEOUT_MS",
      10000,
      120000,
    ),
    idleTimeoutMillis: 10000,
    ...(env.PG_SSL === "true" ? { ssl: { rejectUnauthorized: true } } : {}),
  };
}

function tracingConfig(env = process.env) {
  if (
    env.OTEL_ENABLED !== undefined &&
    !["true", "false"].includes(env.OTEL_ENABLED)
  )
    throw new ConfigurationError("OTEL_ENABLED");
  const sampleRatio = Number(env.OTEL_SAMPLE_RATIO ?? 0.1);
  if (!Number.isFinite(sampleRatio) || sampleRatio < 0 || sampleRatio > 1)
    throw new ConfigurationError("OTEL_SAMPLE_RATIO");
  let endpoint;
  if (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) {
    try {
      endpoint = new URL(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
    } catch {
      throw new ConfigurationError("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
    }
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password
    )
      throw new ConfigurationError("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
  }
  return {
    enabled: env.OTEL_ENABLED === "true",
    sampleRatio,
    endpoint: endpoint?.href,
  };
}

module.exports = { httpConfig, databaseConfig, tracingConfig, integer };
