const { initializeTracing } = require("./observability/tracing");
const telemetry = initializeTracing();
const { createApp } = require("./http/app");
const { logger } = require("./observability/logger");
const { start } = require("./runtime/lifecycle");

const app = createApp();
module.exports = app;
module.exports.createApp = createApp;

if (require.main === module)
  start(app, { telemetry }).catch((err) => {
    logger.fatal({ err }, "startup.failed");
    process.exitCode = 1;
  });
