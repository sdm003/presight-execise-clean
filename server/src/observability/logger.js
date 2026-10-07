const pino = require("pino");
const { AsyncLocalStorage } = require("node:async_hooks");
const { trace, context, isSpanContextValid } = require("@opentelemetry/api");
const requestContext = new AsyncLocalStorage();

// Do not serialize raw Error objects: database messages can contain SQL/data/URLs.
function safeError(error) {
  return {
    type: [
      "AppError",
      "ValidationError",
      "ConfigurationError",
      "TypeError",
      "ReferenceError",
      "SyntaxError",
    ].includes(error?.name)
      ? error.name
      : "Error",
    ...(typeof error?.code === "string" && /^[A-Z0-9_]{2,20}$/.test(error.code)
      ? { code: error.code }
      : {}),
    ...(typeof error?.cause?.code === "string" &&
    /^[A-Z0-9_]{2,20}$/.test(error.cause.code)
      ? { causeCode: error.cause.code }
      : {}),
    ...(error?.name === "ConfigurationError" &&
    [
      "DATABASE_URL",
      "PG_POOL_MAX",
      "PG_SSL",
      "PG_CONNECT_TIMEOUT_MS",
      "PG_STATEMENT_TIMEOUT_MS",
      "PORT",
      "NODE_ENV",
      "CLIENT_ORIGIN",
      "SHUTDOWN_TIMEOUT_MS",
      "HTTP_MAX_IN_FLIGHT",
      "HTTP_REQUEST_TIMEOUT_MS",
      "HTTP_HEADERS_TIMEOUT_MS",
      "HTTP_KEEP_ALIVE_TIMEOUT_MS",
      "PG_MAX_QUEUE",
      "PG_LOCK_TIMEOUT_MS",
      "PG_IDLE_TRANSACTION_TIMEOUT_MS",
      "OTEL_ENABLED",
      "OTEL_SAMPLE_RATIO",
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    ].includes(error.key)
      ? { key: error.key }
      : {}),
  };
}

const logger = pino({
  base: undefined,
  mixin() {
    const span = trace.getSpan(context.active())?.spanContext();
    return {
      ...requestContext.getStore(),
      ...(span && isSpanContextValid(span)
        ? { traceId: span.traceId, spanId: span.spanId }
        : {}),
    };
  },
  serializers: { err: safeError },
  redact: ["password", "authorization", "cookie", "DATABASE_URL"],
});

module.exports = { logger, requestContext };
