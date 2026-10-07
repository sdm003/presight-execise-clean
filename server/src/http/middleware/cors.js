const { AppError } = require("../../shared/errors");

function cors(config) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    const allowed =
      !origin ||
      origin === `${req.protocol}://${req.get("host")}` ||
      origin === config.origin ||
      (!config.origin &&
        config.mode !== "production" &&
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
    res.vary("Origin");
    if (!allowed) return next(new AppError("Origin not allowed", 403));
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader(
        "Access-Control-Expose-Headers",
        "X-Request-ID, traceparent",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, traceparent, tracestate",
      );
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  };
}

module.exports = { cors };
