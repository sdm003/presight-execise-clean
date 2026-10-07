const { pool } = require("./pool");
const { logger } = require("../observability/logger");
const { isUnavailable } = require("../shared/errors");
const { span } = require("../observability/tracing");

function transaction(work, source = pool) {
  return span("db.transaction", async () => {
    const client = await source.connect();
    let failed = false;
    let discard = false;
    let began = false;
    try {
      await client.query("BEGIN");
      began = true;
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      failed = true;
      discard = !began || isUnavailable(error);
      if (began) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          discard = true;
          logger.error({ err: rollbackError }, "database.rollback_failed");
        }
      }
      throw error;
    } finally {
      try {
        client.release(discard);
      } catch (releaseError) {
        if (!failed) throw releaseError;
        logger.error({ err: releaseError }, "database.release_failed");
      }
    }
  });
}

module.exports = { transaction };
