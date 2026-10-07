const { randomUUID } = require("node:crypto");

function requestLog(log) {
  return (req, res, next) => {
    req.id = randomUUID();
    res.setHeader("X-Request-ID", req.id);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    const started = performance.now();
    let logged = false;
    const complete = () => {
      if (logged) return;
      logged = true;
      log.info(
        {
          requestId: req.id,
          method: req.method,
          route: req.route?.path || "unmatched",
          status: res.writableFinished ? res.statusCode : 499,
          durationMs: Math.round(performance.now() - started),
        },
        "http.request",
      );
    };
    res.once("finish", complete);
    res.once("close", complete);
    next();
  };
}

module.exports = { requestLog };
