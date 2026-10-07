const { AppError, isUnavailable } = require("../../shared/errors");

function errorHandler(log, database) {
  return (error, req, res, next) => {
    if (res.headersSent) return next(error);
    let status = 500;
    let message = "Internal server error";
    if (error instanceof AppError) {
      status = error.status;
      if (status < 500) message = error.message;
    } else if (error.type === "entity.parse.failed") {
      status = 400;
      message = "Invalid JSON body";
    } else if (error.type === "entity.too.large") {
      status = 413;
      message = "Request body too large";
    } else if (
      error.type === "charset.unsupported" ||
      error.type === "encoding.unsupported"
    ) {
      status = 415;
      message = "Unsupported body encoding";
    } else if (isUnavailable(error)) status = 503;
    if (status === 503) {
      message = "Service unavailable";
      res.setHeader("Retry-After", "1");
    }
    if (status >= 500)
      log.error(
        {
          err: error,
          requestId: req.id,
          method: req.method,
          route: req.route?.path || "unmatched",
          status,
          pool: database?.stats?.(),
        },
        "http.failed",
      );
    res.status(status).json({ error: message });
  };
}

module.exports = { errorHandler };
