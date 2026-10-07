const { pool } = require("./database/pool");
const { migrate } = require("./database/migrate");
const { logger } = require("./observability/logger");

async function setup() {
  try {
    await migrate(pool);
    logger.info({}, "database.schema_ready");
  } finally {
    await pool.end().catch((err) => {
      logger.error({ err }, "database.cleanup_failed");
      process.exitCode = 1;
    });
  }
}
if (require.main === module)
  setup().catch((err) => {
    logger.fatal({ err }, "database.setup_failed");
    process.exitCode = 1;
  });
module.exports = { setup };
