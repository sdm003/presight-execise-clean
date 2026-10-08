const debug =
  import.meta.env?.DEV || import.meta.env?.VITE_DEBUG_LOGS === "true";

export function clientLog(event, details = {}, error) {
  const level =
    event.startsWith("ui.") || details.outcome === "error" ? "error" : "debug";
  if (level === "debug" && !debug) return;
  const record = {};
  if (event.startsWith("users.")) {
    record.method = "GET";
    record.route = "/api/users";
  }
  if (["success", "error", "cancelled", "stale"].includes(details.outcome))
    record.outcome = details.outcome;
  if (Number.isSafeInteger(details.page) && details.page > 0)
    record.page = details.page;
  if (
    Number.isInteger(details.status) &&
    details.status >= 100 &&
    details.status <= 599
  )
    record.status = details.status;
  if (Number.isFinite(details.started))
    record.durationMs = Math.max(
      0,
      Math.round(performance.now() - details.started),
    );
  if (
    typeof details.requestId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      details.requestId,
    )
  )
    record.requestId = details.requestId;
  const trace =
    typeof details.traceparent === "string"
      ? /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/.exec(details.traceparent)
      : null;
  if (trace && !/^0+$/.test(trace[1]) && !/^0+$/.test(trace[2]))
    record.traceId = trace[1];
  if (error) {
    record.errorType = [
      "Error",
      "TypeError",
      "SyntaxError",
      "ReferenceError",
      "RangeError",
      "URIError",
      "EvalError",
      "AbortError",
    ].includes(error.name)
      ? error.name
      : "Error";
    if (["HTTP_ERROR", "INVALID_RESPONSE", "PAGE_OVERLAP"].includes(error.code))
      record.errorCode = error.code;
  }
  console[level](`client.${event}`, record);
}

export function installErrorReporting(target = window) {
  const onError = (event) => clientLog("ui.error", {}, event.error);
  const onRejection = (event) =>
    clientLog("ui.unhandled_rejection", {}, event.reason);
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
