function admission({ maxInFlight, isDraining }) {
  let inFlight = 0;
  const middleware = (req, res, next) => {
    if (isDraining() || inFlight >= maxInFlight) {
      res.setHeader("Retry-After", "1");
      return res.status(503).json({ error: "Service unavailable" });
    }
    inFlight++;
    let held = false;
    let workComplete = false;
    let responseComplete = false;
    let released = false;
    const complete = () => {
      if (released) return;
      released = true;
      inFlight--;
    };
    req.admission = {
      hold: () => {
        held = true;
      },
      complete: () => {
        workComplete = true;
        if (responseComplete) complete();
      },
    };
    const releaseResponse = () => {
      responseComplete = true;
      if (!held || workComplete) complete();
    };
    res.once("finish", releaseResponse);
    res.once("close", releaseResponse);
    next();
  };
  middleware.stats = () => ({ inFlight, capacity: maxInFlight });
  return middleware;
}

module.exports = { admission };
