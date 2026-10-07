const {
  context,
  trace,
  SpanStatusCode,
  SpanKind,
} = require("@opentelemetry/api");
const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} = require("@opentelemetry/sdk-trace-base");
const {
  OTLPTraceExporter,
} = require("@opentelemetry/exporter-trace-otlp-http");
const { resourceFromAttributes } = require("@opentelemetry/resources");
const { W3CTraceContextPropagator } = require("@opentelemetry/core");
const { tracingConfig } = require("../config");

const propagator = new W3CTraceContextPropagator();
let initialized;

function initializeTracing({ env = process.env, exporter, sampleRatio } = {}) {
  if (initialized) return initialized;
  const config = tracingConfig(env);
  if (!config.enabled && !exporter)
    return { shutdown: async () => {}, forceFlush: async () => {} };
  const processors = [];
  if (exporter) processors.push(new SimpleSpanProcessor(exporter));
  else if (config.endpoint)
    processors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: config.endpoint, timeoutMillis: 3000 }),
        {
          maxQueueSize: 1024,
          maxExportBatchSize: 128,
          scheduledDelayMillis: 1000,
          exportTimeoutMillis: 3000,
        },
      ),
    );
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": "presight-api" }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(
        sampleRatio ?? (exporter ? 1 : config.sampleRatio),
      ),
    }),
    spanProcessors: processors,
  });
  provider.register({ propagator });
  initialized = {
    provider,
    forceFlush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
  return initialized;
}

function span(name, work, attributes = {}) {
  return trace
    .getTracer("presight-api")
    .startActiveSpan(name, { attributes }, async (current) => {
      try {
        return await work(current);
      } catch (error) {
        // Exception messages, SQL and payloads may contain private data.
        current.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        current.end();
      }
    });
}

function requestTracing(req, res, next) {
  const parent = propagator.extract(context.active(), req.headers, {
    keys: (carrier) => Object.keys(carrier),
    get: (carrier, key) => carrier[key],
  });
  const current = trace.getTracer("presight-api").startSpan(
    "HTTP request",
    {
      kind: SpanKind.SERVER,
      attributes: { "http.request.method": req.method },
    },
    parent,
  );
  const active = trace.setSpan(parent, current);
  propagator.inject(active, res, {
    set: (response, key, value) => response.setHeader(key, value),
  });
  let ended = false;
  const complete = () => {
    if (ended) return;
    ended = true;
    const route = req.route?.path || "unmatched";
    current.updateName(`${req.method} ${route}`);
    current.setAttributes({
      "http.route": route,
      "http.response.status_code": res.statusCode,
    });
    if (res.statusCode >= 500 || !res.writableFinished)
      current.setStatus({ code: SpanStatusCode.ERROR });
    current.end();
  };
  res.once("finish", complete);
  res.once("close", complete);
  context.with(active, next);
}

module.exports = { initializeTracing, span, requestTracing };
