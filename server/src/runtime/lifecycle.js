const { pool } = require("../database/pool");
const { httpConfig } = require("../config");
const { logger } = require("../observability/logger");

async function start(
  app,
  {
    database = pool,
    config = httpConfig(),
    log = logger,
    runtime = process,
    telemetry = { shutdown: async () => {} },
  } = {},
) {
  let server;
  try {
    await database.query("SELECT 1");
    server = await new Promise((resolve, reject) => {
      const listening = app.listen(config.port);
      listening.once("error", reject);
      listening.once("listening", () => {
        listening.removeListener("error", reject);
        resolve(listening);
      });
    });
  } catch (error) {
    try {
      await database.end();
    } catch (err) {
      log.error({ err }, "startup.cleanup_failed");
    }
    try {
      await telemetry.shutdown();
    } catch (err) {
      log.error({ err }, "startup.telemetry_failed");
    }
    throw error;
  }
  server.requestTimeout = config.requestTimeout ?? 30000;
  server.headersTimeout = config.headersTimeout ?? 10000;
  server.keepAliveTimeout = config.keepAliveTimeout ?? 5000;
  server.maxRequestsPerSocket = 1000;
  let shuttingDown;
  let exitCode = 0;
  const handlers = {
    SIGTERM: () => shutdown("SIGTERM"),
    SIGINT: () => shutdown("SIGINT"),
    unhandledRejection: (err) => shutdown("unhandledRejection", err, 1),
    uncaughtException: (err) => shutdown("uncaughtException", err, 1),
  };
  function shutdown(reason, error, code = 0) {
    exitCode = Math.max(exitCode, code);
    if (error) log.fatal({ err: error }, "process.fatal");
    if (shuttingDown) return shuttingDown;
    if (app.locals) app.locals.draining = true;
    log.info({ reason }, "shutdown.started");
    shuttingDown = new Promise((resolve) => {
      let finished = false;
      function complete(code) {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        for (const [event, handler] of Object.entries(handlers))
          runtime.removeListener(event, handler);
        log.info({ exitCode: code }, "shutdown.completed");
        runtime.exit(code);
        resolve();
      }
      const deadline = setTimeout(() => {
        server.closeAllConnections();
        log.fatal({}, "shutdown.timeout");
        complete(1);
      }, config.shutdownTimeout);
      server.close(async () => {
        try {
          await database.end();
        } catch (err) {
          exitCode = 1;
          log.error({ err }, "shutdown.database_failed");
        }
        try {
          await telemetry.shutdown();
        } catch (err) {
          exitCode = 1;
          log.error({ err }, "shutdown.telemetry_failed");
        }
        complete(exitCode);
      });
    });
    return shuttingDown;
  }
  for (const [event, handler] of Object.entries(handlers))
    runtime.on(event, handler);
  server.on("request", (_, res) => {
    res.once("finish", () => {
      // Active keepalive requests can become idle after server.close's initial sweep.
      if (shuttingDown) setImmediate(() => server.closeIdleConnections());
    });
  });
  server.on("error", (err) => shutdown("server.error", err, 1));
  log.info({ port: server.address().port }, "startup.listening");
  return { server, shutdown };
}

module.exports = { start };
