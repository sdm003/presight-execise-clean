const express = require("express");
const path = require("node:path");
const { pool } = require("../database/pool");
const users = require("../modules/users/repository");
const { mountUsers } = require("../modules/users/routes");
const { httpConfig } = require("../config");
const { AppError } = require("../shared/errors");
const { logger } = require("../observability/logger");
const { requestTracing } = require("../observability/tracing");
const { requestLog } = require("./middleware/request-log");
const { cors } = require("./middleware/cors");
const { admission } = require("./middleware/admission");
const { errorHandler } = require("./middleware/errors");

function createApp({
  repository = users,
  database = pool,
  log = logger,
  config = httpConfig(),
} = {}) {
  config = { ...httpConfig(), ...config };
  const app = express();
  app.disable("x-powered-by");
  app.locals.draining = false;
  app.use(requestTracing, requestLog(log), cors(config));
  app.get("/api/live", (_, res) => res.json({ ok: true }));
  const capacity = admission({
    maxInFlight: config.maxInFlight,
    isDraining: () => app.locals.draining,
  });
  app.locals.admission = capacity;
  app.use("/api", capacity);
  app.post("/api/users", (req, res, next) => {
    if (!req.is("application/json"))
      return next(new AppError("Content-Type must be application/json", 415));
    next();
  });
  app.use("/api/users", express.json({ limit: "32kb" }));
  mountUsers(app, repository, config);
  const ready = async (req, res) => {
    req.admission.hold();
    try {
      await database.query("SELECT 1");
      res.json({ ok: true });
    } finally {
      req.admission.complete();
    }
  };
  app.get("/api/health", ready);
  app.get("/api/ready", ready);
  app.use("/api", (_, res) => res.status(404).json({ error: "Not found" }));
  app.use(express.static(path.join(__dirname, "../../../client/dist")));
  app.use(errorHandler(log));
  return app;
}

module.exports = { createApp };
