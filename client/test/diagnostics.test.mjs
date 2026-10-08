import test from "node:test";
import assert from "node:assert/strict";
import { clientLog, installErrorReporting } from "../src/diagnostics.js";

test("production diagnostics report safe correlated errors without routine or abort noise", () => {
  const records = [];
  const original = { error: console.error, debug: console.debug };
  console.error = (event, record) => records.push({ event, record });
  console.debug = () =>
    assert.fail("Routine diagnostics must be disabled in production");
  try {
    for (const outcome of ["success", "cancelled", "stale"])
      clientLog("users.request.completed", { outcome }, Error("private"));
    clientLog("users.request.retry", { page: 2 });
    assert.equal(records.length, 0);
    const requestId = "09e49802-cda8-4ee5-9fa0-ba516f032f24";
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    clientLog(
      "users.request.completed",
      {
        outcome: "error",
        page: 2,
        status: 503,
        started: performance.now(),
        requestId,
        traceparent: `00-${traceId}-00f067aa0ba902b7-01`,
        search: "private",
        body: { first_name: "private" },
        url: "/api/users?search=private",
      },
      Object.assign(Error("private password"), { code: "HTTP_ERROR" }),
    );
    const { event, record } = records[0];
    assert.equal(event, "client.users.request.completed");
    assert.equal(record.requestId, requestId);
    assert.equal(record.traceId, traceId);
    assert.equal(record.method, "GET");
    assert.equal(record.route, "/api/users");
    assert.equal(record.page, 2);
    assert.equal(record.status, 503);
    assert.equal(record.errorType, "Error");
    assert.equal(record.errorCode, "HTTP_ERROR");
    assert.ok(record.durationMs >= 0);
    clientLog(
      "users.request.completed",
      {
        outcome: "error",
        status: -1,
        page: -1,
        requestId: "private",
        traceparent: "private",
      },
      {
        name: "private",
        code: "private",
        message: "private",
        stack: "private",
      },
    );
    assert.deepEqual(records[1].record, {
      method: "GET",
      route: "/api/users",
      outcome: "error",
      errorType: "Error",
    });
    assert.ok(!JSON.stringify(records).includes("private"));
  } finally {
    Object.assign(console, original);
  }
});

test("global error reporting handles non-Error rejections and cleans up listeners", () => {
  const records = [];
  const original = console.error;
  console.error = (event, record) => records.push({ event, record });
  const target = new EventTarget();
  const remove = installErrorReporting(target);
  try {
    const error = Object.assign(new Event("error", { cancelable: true }), {
      error: new TypeError("private"),
    });
    target.dispatchEvent(error);
    target.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), {
        reason: "private",
      }),
    );
    assert.deepEqual(records, [
      { event: "client.ui.error", record: { errorType: "TypeError" } },
      {
        event: "client.ui.unhandled_rejection",
        record: { errorType: "Error" },
      },
    ]);
    assert.equal(error.defaultPrevented, false);
    remove();
    remove();
    target.dispatchEvent(error);
    assert.equal(records.length, 2);
  } finally {
    remove();
    console.error = original;
  }
});
