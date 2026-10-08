// Uses an existing Chrome installation and Node's native CDP WebSocket support.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import express from "express";
import { createServer } from "vite";
import { randomUUID } from "node:crypto";

const binary = process.env.BROWSER_BIN;
assert.ok(binary, "Set BROWSER_BIN to an existing Chrome/Chromium executable");
// Test-only API responses; never loaded into the application's database.
const hobbies = ["Reading", "Cycling", "Cooking", "Photography", "Hiking"];
const fixtures = Array.from({ length: 1000 }, (_, i) => ({
  id: i + 1,
  avatar: `https://i.pravatar.cc/96?img=${(i % 70) + 1}`,
  first_name: ["Ava", "Zoe", "Mia", "Noah"][i % 4],
  last_name: `Person ${i + 1}`,
  age: 18 + (i % 63),
  nationality: ["American", "British", "Canadian", "French"][i % 4],
  hobbies: hobbies.slice(0, i % 6),
}));
const requests = [];
let failPage = 0;
let malformedPage = 0;
let firstPageDelay = 0;
const app = express();
app.get("/api/users", async (req, res) => {
  const q = req.query;
  assert.equal(q.hobbies, undefined, "API must use repeated hobby keys");
  assert.equal(
    q.nationalities,
    undefined,
    "API must use repeated nationality keys",
  );
  const values = (value) =>
    value === undefined ? [] : Array.isArray(value) ? value : [value];
  const nationalities = values(q.nationality);
  const selectedHobbies = values(q.hobby);
  const page = Number(q.page);
  const requestId = randomUUID();
  res.setHeader("X-Request-ID", requestId);
  res.setHeader(
    "traceparent",
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  );
  requests.push({ ...q, page, requestId });
  if (failPage === page) {
    failPage = 0;
    return res.status(503).json({ error: "Test page failure" });
  }
  if (q.search === "Ava") await delay(900);
  if (page === 1 && firstPageDelay) {
    const wait = firstPageDelay;
    firstPageDelay = 0;
    await delay(wait);
  }
  const list = fixtures.filter(
    (user) =>
      `${user.first_name} ${user.last_name}`
        .toLowerCase()
        .includes(String(q.search || "").toLowerCase()) &&
      (!nationalities.length || nationalities.includes(user.nationality)) &&
      selectedHobbies.every((hobby) => user.hobbies.includes(hobby)),
  );
  const key = q.sort || "first_name";
  list.sort((a, b) => {
    const order =
      typeof a[key] === "number"
        ? a[key] - b[key]
        : a[key].localeCompare(b[key]);
    return (q.direction === "desc" ? -order : order) || a.id - b.id;
  });
  const facet = (values) =>
    [...new Set(values)].map((value) => ({
      value,
      count: values.filter((v) => v === value).length,
    }));
  const data = list.slice((page - 1) * 40, page * 40);
  if (malformedPage === page) {
    malformedPage = 0;
    data[1] = data[0];
  }
  res.json({
    data,
    pagination: {
      page,
      limit: 40,
      total: list.length,
      hasMore: page * 40 < list.length,
    },
    facets: {
      hobbies: facet(list.flatMap((user) => user.hobbies)),
      nationalities: facet(list.map((user) => user.nationality)),
    },
  });
});
app.use(express.static(path.resolve("dist")));
const server = app.listen(0);
const development = process.argv.includes("--dev");
const verboseDiagnostics =
  development || process.env.VITE_DEBUG_LOGS === "true";
let vite;
const profile = path.resolve(`.browser-profile-${process.pid}`);
const chrome = spawn(
  binary,
  [
    "--headless",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-extensions",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let socket;
try {
  if (development) {
    vite = await createServer({
      server: {
        host: "127.0.0.1",
        port: 0,
        proxy: { "/api": `http://127.0.0.1:${server.address().port}` },
      },
    });
    await vite.listen();
  }
  const base = `http://127.0.0.1:${(vite?.httpServer || server).address().port}`;
  const endpoint = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(Error("Chrome debugger startup timed out")),
      15000,
    );
    chrome.stderr.on("data", (data) => {
      output += data;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    chrome.once("error", reject);
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let serial = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      if (message.error) reject(Error(message.error.message));
      else resolve(message.result);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(
        () => reject(Error(`CDP timed out: ${method}`)),
        10000,
      );
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const { targetId } = await send("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const cdp = (method, params) => send(method, params, sessionId);
  const evaluate = async (expression) => {
    const result = await cdp("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (expression) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await delay(100);
    }
    throw Error(
      `Browser condition timed out: ${expression}\n${JSON.stringify(await evaluate(`({ status: document.querySelector('.sentinel')?.textContent, cards: document.querySelectorAll('[data-user-id]').length, scrollY, height: innerHeight, error: document.querySelector('[role=alert]')?.textContent })`))}`,
    );
  };
  const input = (value) =>
    evaluate(`{
    const input = document.querySelector('input[aria-label="Search names"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }`);
  await cdp("Network.enable");
  await cdp("Page.enable");
  await cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.clientDiagnostics = [];
      for (const level of ['debug', 'error']) {
        const original = console[level].bind(console);
        console[level] = (...args) => {
          if (typeof args[0] === 'string' && args[0].startsWith('client.'))
            clientDiagnostics.push({ level, event: args[0], record: args[1] });
          original(...args);
        };
      }
      window.gridMetrics = { reads: 0, mutations: 0, renders: 0 };
      const gridSnapshots = new WeakMap();
      window.fetchMetrics = { starts: 0, aborts: 0, active: 0 };
      const fetchPage = window.fetch;
      window.fetch = async (...args) => {
        if (!String(args[0]).includes('/api/users?')) return fetchPage(...args);
        fetchMetrics.starts++;
        fetchMetrics.active++;
        args[1]?.signal?.addEventListener('abort', () => { fetchMetrics.aborts++; }, { once: true });
        try { return await fetchPage(...args); }
        finally { fetchMetrics.active--; }
      };
      const bounds = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function(...args) {
        if (this.classList.contains('virtual-cards')) window.gridMetrics.reads++;
        return bounds.apply(this, args);
      };
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        renderers: new Map(),
        inject(renderer) { this.renderers.set(1, renderer); return 1; },
        onCommitFiberRoot: (_id, root) => {
          const walk = (fiber) => {
            if (!fiber) return;
            if (fiber.memoizedProps?.users && fiber.memoizedProps?.sentinel)
              window.directoryUsers = fiber.memoizedProps.users;
            if (fiber.memoizedProps?.users) {
              const previous = gridSnapshots.get(fiber) || (fiber.alternate && gridSnapshots.get(fiber.alternate));
              if (previous && (fiber.flags & 1) &&
                  (fiber.memoizedProps !== previous.props || fiber.memoizedState !== previous.hooks))
                window.gridMetrics.renders++;
              const snapshot = { props: fiber.memoizedProps, hooks: fiber.memoizedState };
              gridSnapshots.set(fiber, snapshot);
              if (fiber.alternate) gridSnapshots.set(fiber.alternate, snapshot);
            }
            walk(fiber.child);
            walk(fiber.sibling);
          };
          walk(root.current);
        },
        onCommitFiberUnmount: () => {},
      };
    `,
  });
  await cdp("Network.setBlockedURLs", { urls: ["*pravatar.cc*"] });
  const resize = (width, height) =>
    cdp("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  await resize(1200, 900);
  await cdp("Page.navigate", {
    url: `${base}/?sort=age&direction=desc`,
  });
  await until(
    `document.querySelector('.sentinel')?.textContent.includes('of 1000')`,
  );
  const initialLogs = await evaluate(`clientDiagnostics`);
  const completed = initialLogs.find(
    (entry) =>
      entry.event === "client.users.request.completed" &&
      entry.record.outcome === "success",
  );
  if (verboseDiagnostics) {
    assert.ok(completed, "Debug mode logs successful API operations");
    assert.ok(
      requests.some(
        (request) => request.requestId === completed.record.requestId,
      ),
    );
    assert.equal(completed.record.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
    assert.equal(completed.level, "debug");
    assert.equal(completed.record.status, 200);
    assert.ok(completed.record.durationMs >= 0);
    if (development)
      assert.ok(
        initialLogs.some(
          (entry) =>
            entry.record.outcome === "cancelled" && entry.level === "debug",
        ),
        "StrictMode cancellations are diagnostic events, not errors",
      );
  } else {
    assert.equal(
      initialLogs.length,
      0,
      "Production omits routine request logs",
    );
  }
  if (development) {
    assert.ok(
      await evaluate(`fetchMetrics.aborts >= 1`),
      "StrictMode cleans up the first mount request",
    );
    assert.equal(
      await evaluate(`fetchMetrics.active`),
      0,
      "StrictMode leaves no request hanging",
    );
  }
  assert.equal(await evaluate(`document.querySelector('select').value`), "age");
  assert.ok(
    await evaluate(`document.querySelectorAll('[data-user-id]').length < 40`),
  );
  assert.equal(
    await evaluate(
      `Math.round(document.querySelector('.card').getBoundingClientRect().height)`,
    ),
    142,
  );
  assert.equal(
    await evaluate(
      `document.querySelector('.virtual-window').style.gridTemplateColumns`,
    ),
    "repeat(3, minmax(0px, 1fr))",
  );
  await delay(200);
  await evaluate(`{
    window.gridObserver = new MutationObserver(records => { gridMetrics.mutations += records.length; });
    gridObserver.observe(document.querySelector('.virtual-cards'), { childList: true, subtree: true, attributes: true });
    gridMetrics.reads = gridMetrics.mutations = gridMetrics.renders = 0;
  }`);
  await input("Z");
  await input("Zo");
  await input("");
  await delay(100);
  assert.deepEqual(
    await evaluate(`gridMetrics`),
    { reads: 0, mutations: 0, renders: 0 },
    "raw keystrokes do not rerender or measure the result grid",
  );
  for (let i = 1; i <= 8; i++) {
    await evaluate(
      `scrollTo(0, ${i}); dispatchEvent(new Event('scroll')); dispatchEvent(new Event('scroll'));`,
    );
    await delay(25);
  }
  assert.deepEqual(
    await evaluate(`gridMetrics`),
    { reads: 0, mutations: 0, renders: 0 },
    "scroll pixels inside the same row window do not rerender or read layout",
  );
  await evaluate(`gridObserver.disconnect(); scrollTo(0, 0)`);

  const beforeNoop = requests.length;
  await evaluate(
    `document.querySelector('#sort').dispatchEvent(new Event('change', { bubbles: true }))`,
  );
  await delay(350);
  assert.equal(requests.length, beforeNoop, "same sort value does not refetch");

  // Scroll through all pages and check that only the visible rows remain mounted.
  for (let i = 0; i < 35; i++) {
    await evaluate(`scrollTo(0, document.body.scrollHeight)`);
    await delay(180);
    const count = await evaluate(
      `document.querySelectorAll('[data-user-id]').length`,
    );
    assert.ok(
      count > 0 && count <= 54,
      `bounded DOM at scroll step ${i}: ${count}`,
    );
    if (
      (
        await evaluate(`document.querySelector('.sentinel').textContent`)
      ).includes("1000 of 1000")
    )
      break;
  }
  await until(
    `document.querySelector('.sentinel').textContent.includes('1000 of 1000')`,
  );
  assert.ok(
    await evaluate(`gridMetrics.renders > 0 && gridMetrics.reads > 0`),
    "instrumentation detects real result-grid renders and layout measurements",
  );
  await evaluate(`scrollTo(0, document.body.scrollHeight)`);
  await delay(250);
  const lastVisible = await evaluate(
    `[...document.querySelectorAll('[data-user-id]')].map(n => Number(n.dataset.userId))`,
  );
  const sorted = [...fixtures].sort((a, b) => b.age - a.age || a.id - b.id);
  assert.ok(
    lastVisible.includes(sorted.at(-1).id),
    "last sorted user is visible at the end",
  );
  await resize(390, 700);
  await delay(250);
  assert.equal(
    await evaluate(
      `document.querySelector('.virtual-window').style.gridTemplateColumns`,
    ),
    "repeat(1, minmax(0px, 1fr))",
  );
  assert.ok(
    await evaluate(`document.querySelectorAll('[data-user-id]').length <= 15`),
  );
  assert.equal(
    await evaluate(`getComputedStyle(document.querySelector('aside')).display`),
    "none",
  );
  await evaluate(`document.querySelector('.filter-toggle').click()`);
  assert.equal(
    await evaluate(
      `document.querySelector('.filter-toggle').getAttribute('aria-expanded')`,
    ),
    "true",
  );
  assert.notEqual(
    await evaluate(`getComputedStyle(document.querySelector('aside')).display`),
    "none",
  );
  await evaluate(`document.querySelector('.filter-toggle').click()`);

  // A delayed old search must not replace the next filter's results.
  await input("Ava");
  await delay(380);
  assert.ok(requests.some((q) => q.search === "Ava"));
  await input("Zoe");
  await until(
    `document.querySelector('.results').getAttribute('aria-busy') === 'false' && [...document.querySelectorAll('.card h2')].every(n => n.textContent.trim().startsWith('Zoe')) && document.querySelectorAll('.card h2').length > 0`,
  );
  await delay(1000);
  assert.ok(
    await evaluate(
      `[...document.querySelectorAll('.card h2')].every(n => n.textContent.trim().startsWith('Zoe'))`,
    ),
  );
  assert.ok(
    await evaluate(
      `scrollY < document.querySelector('.results').getBoundingClientRect().top + scrollY + 100`,
    ),
  );
  const beforeWhitespace = requests.length;
  await input("   Zoe   ");
  await delay(450);
  assert.equal(
    requests.length,
    beforeWhitespace,
    "normalized whitespace does not request",
  );
  await evaluate(
    `document.querySelector('input[aria-label="Search names"]').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))`,
  );
  await input("Av");
  await delay(400);
  assert.equal(
    requests.length,
    beforeWhitespace,
    "IME composition does not request intermediate text",
  );
  await input("Zoe");
  await evaluate(
    `document.querySelector('input[aria-label="Search names"]').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))`,
  );
  await delay(400);
  assert.equal(
    requests.length,
    beforeWhitespace,
    "composition ending at the applied value does not refetch",
  );

  const sharedUrl = await evaluate(`location.href`);
  await cdp("Page.navigate", { url: sharedUrl });
  await until(
    `document.querySelector('input[aria-label="Search names"]')?.value === 'Zoe' && document.querySelector('.results')?.getAttribute('aria-busy') === 'false'`,
  );
  assert.equal(
    await evaluate(`document.querySelector('#sort').value`),
    "age",
    "shared URL restores sort and search",
  );
  await input("nobody-has-this-name");
  await until(
    `document.querySelector('.message')?.textContent.includes('No people')`,
  );
  assert.equal(
    await evaluate(`document.querySelectorAll('[data-user-id]').length`),
    0,
  );

  failPage = 2;
  await input("");
  await until(
    `document.querySelector('.sentinel').textContent.includes('40 of 1000')`,
  );
  await evaluate(`scrollTo(0, document.body.scrollHeight)`);
  await until(`document.querySelector('[role=alert]')`);
  const failedRequest = await evaluate(`clientDiagnostics.find(entry =>
    entry.event === 'client.users.request.completed' && entry.record.status === 503
  )`);
  assert.equal(failedRequest.level, "error");
  assert.equal(failedRequest.record.page, 2);
  assert.equal(failedRequest.record.errorCode, "HTTP_ERROR");
  assert.ok(
    requests.some(
      (request) => request.requestId === failedRequest.record.requestId,
    ),
  );
  const beforeRetry = requests.length;
  await evaluate(`document.querySelector('[role=alert] button').click()`);
  await until(
    `document.querySelector('.sentinel').textContent.includes('80 of 1000')`,
  );
  assert.equal(requests[beforeRetry].page, 2, "retry resumes failed page");
  if (verboseDiagnostics)
    assert.ok(
      await evaluate(`clientDiagnostics.some(entry =>
      entry.event === 'client.users.request.retry' && entry.record.page === 2
    )`),
    );
  assert.equal(
    new Set(
      await evaluate(
        `[...document.querySelectorAll('[data-user-id]')].map(n => n.dataset.userId)`,
      ),
    ).size,
    await evaluate(`document.querySelectorAll('[data-user-id]').length`),
  );
  await resize(1200, 900);
  await delay(250);
  assert.ok(
    await evaluate(`document.documentElement.scrollWidth <= innerWidth`),
    "desktop has no horizontal overflow",
  );

  // Control only the observer for these cases so every pagination transition is asserted.
  await cdp("Page.enable");
  await cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.IntersectionObserver = class {
      constructor(callback) { window.loadNext = () => callback([{ isIntersecting: true }]); }
      observe() {}
      disconnect() {}
    };`,
  });
  await resize(1200, 3000);
  await cdp("Page.navigate", {
    url: `${base}/?sort=age&direction=desc`,
  });
  await until(
    `document.querySelector('.sentinel')?.textContent === '40 of 1000' && document.querySelectorAll('[data-user-id]').length === 40`,
  );
  const visibleIds = () =>
    evaluate(
      `[...document.querySelectorAll('[data-user-id]')].map(n => Number(n.dataset.userId))`,
    );
  const currentIds = () =>
    [...fixtures]
      .sort((a, b) => b.age - a.age || a.id - b.id)
      .map((user) => user.id);
  assert.deepEqual(await visibleIds(), currentIds().slice(0, 40));
  const oldIds = await visibleIds();
  fixtures.push({ ...fixtures[0], id: 1001, age: 120 });
  firstPageDelay = 700;
  const beforeInsert = requests.length;
  await evaluate(`loadNext(); loadNext()`);
  await until(
    `document.querySelector('.sentinel').textContent === 'Loading people…'`,
  );
  assert.deepEqual(
    await visibleIds(),
    oldIds,
    "restart keeps existing results while its first page loads",
  );
  await until(
    `document.querySelector('.sentinel').textContent === '40 of 1001'`,
  );
  assert.deepEqual(
    requests.slice(beforeInsert).map((q) => q.page),
    [2, 1],
    "insertion before the offset restarts once; synchronous loads cannot overlap",
  );
  assert.deepEqual(await visibleIds(), currentIds().slice(0, 40));
  await evaluate(`loadNext()`);
  await until(
    `document.querySelector('.sentinel').textContent === '80 of 1001'`,
  );
  await evaluate(`scrollTo(0, document.body.scrollHeight)`);
  await delay(200);
  assert.deepEqual(
    await visibleIds(),
    currentIds()
      .slice(0, 80)
      .slice(-(await visibleIds()).length),
  );
  assert.equal(requests.at(-1).page, 2, "pagination continues after restart");

  // A sort-key edit can shift OFFSET pages without changing the total.
  fixtures.find((user) => user.id === currentIds().at(-1)).age = 120;
  const beforeEdit = requests.length;
  await evaluate(`loadNext()`);
  await until(
    `document.querySelector('.sentinel').textContent === '40 of 1001'`,
  );
  await evaluate(`scrollTo(0, 0)`);
  await delay(200);
  assert.deepEqual(
    requests.slice(beforeEdit).map((q) => q.page),
    [3, 1],
    "same-total overlap also restarts",
  );
  assert.deepEqual(await visibleIds(), currentIds().slice(0, 40));

  // Even an insertion after the offset changes the snapshot without overlapping IDs.
  fixtures.push({ ...fixtures[0], id: 1002, age: 0 });
  const beforeTotal = requests.length;
  await evaluate(`loadNext()`);
  await until(
    `document.querySelector('.sentinel').textContent === '40 of 1002'`,
  );
  assert.deepEqual(
    requests.slice(beforeTotal).map((q) => q.page),
    [2, 1],
    "total change restarts even without overlapping IDs",
  );
  assert.deepEqual(await visibleIds(), currentIds().slice(0, 40));

  fixtures.push({ ...fixtures[0], id: 1003, age: 120 });
  malformedPage = 1;
  const beforeMalformed = requests.length;
  await evaluate(`loadNext()`);
  await until(`document.querySelector('[role=alert]')`);
  await delay(400);
  assert.deepEqual(
    requests.slice(beforeMalformed).map((q) => q.page),
    [2, 1],
    "malformed reset page fails without an infinite restart loop",
  );
  assert.ok(
    await evaluate(`clientDiagnostics.some(entry =>
    entry.event === 'client.users.request.completed' && entry.level === 'error' &&
    entry.record.errorCode === 'INVALID_RESPONSE' && entry.record.status === 200
  )`),
  );
  if (verboseDiagnostics)
    assert.ok(
      await evaluate(`clientDiagnostics.some(entry =>
      entry.event === 'client.users.page.restart' && entry.level === 'debug'
    )`),
    );
  await evaluate(`document.querySelector('[role=alert] button').click()`);
  await until(
    `document.querySelector('.sentinel').textContent === '40 of 1003'`,
  );
  assert.equal(requests.at(-1).page, 1, "failed restart retries page one");
  assert.deepEqual(await visibleIds(), currentIds().slice(0, 40));

  // Changing query during the restart must abort the whole request chain.
  fixtures.push({ ...fixtures[0], id: 1004, age: 120 });
  firstPageDelay = 900;
  await evaluate(`loadNext()`);
  await until(
    `document.querySelector('.sentinel').textContent === 'Loading people…'`,
  );
  await input("Zoe");
  await until(
    `document.querySelector('.results').getAttribute('aria-busy') === 'false' && document.querySelectorAll('.card h2').length > 0 && [...document.querySelectorAll('.card h2')].every(n => n.textContent.trim().startsWith('Zoe'))`,
  );
  await delay(1000);
  assert.ok(
    await evaluate(
      `[...document.querySelectorAll('.card h2')].every(n => n.textContent.trim().startsWith('Zoe'))`,
    ),
    "stale restart cannot overwrite new query",
  );
  await evaluate(`{
    const labels = [...document.querySelectorAll('fieldset')].find(n => n.querySelector('legend').textContent.startsWith('Hobbies')).querySelectorAll('label');
    for (const hobby of ['Reading', 'Cycling'])
      [...labels].find(n => n.querySelector('span').textContent === hobby).querySelector('input').click();
  }`);
  await until(
    `document.querySelector('.results').getAttribute('aria-busy') === 'false' && new URLSearchParams(location.search).getAll('hobby').length === 2`,
  );
  assert.deepEqual(
    await evaluate(`new URLSearchParams(location.search).getAll('hobby')`),
    ["Reading", "Cycling"],
    "successive synchronous filter toggles preserve both selections",
  );
  await input("pending-draft");
  await evaluate(`document.querySelector('.toolbar .clear').click()`);
  await until(
    `document.querySelector('.sentinel').textContent === '40 of 1004'`,
  );
  await delay(400);
  assert.equal(
    await evaluate(
      `document.querySelector('input[aria-label="Search names"]').value`,
    ),
    "",
    "clear all cancels pending raw search",
  );
  assert.ok(!requests.some((q) => q.search === "pending-draft"));
  // Force a render error in a newly mounted card, then recover with a fresh app.
  await input("");
  await until(
    `document.querySelector('.sentinel').textContent === '40 of 1004'`,
  );
  await resize(390, 700);
  await evaluate(`scrollTo(0, document.body.scrollHeight)`);
  await delay(250);
  await evaluate(`{
    const user = directoryUsers[0];
    Object.defineProperty(user, 'first_name', { configurable: true, get() { throw Error('Test UI render failure'); } });
    scrollTo(0, 0);
  }`);
  await until(
    `document.querySelector('[role=alert] h1')?.textContent.includes("couldn't be displayed")`,
  );
  assert.ok(
    await evaluate(`clientDiagnostics.some(entry =>
    entry.event === 'client.ui.render.failed' && entry.level === 'error'
  )`),
  );
  await evaluate(`document.querySelector('[role=alert] button').click()`);
  await until(
    `document.querySelector('.sentinel')?.textContent === '40 of 1004'`,
  );
  assert.equal(
    await evaluate(`document.querySelector('[role=alert]')`),
    null,
    "UI error boundary resets and refetches clean data",
  );
  await evaluate(`{
    window.dispatchEvent(new ErrorEvent('error', { error: new TypeError('private') }));
    window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', {
      promise: Promise.resolve(), reason: Error('private')
    }));
  }`);
  const diagnostics = await evaluate(`clientDiagnostics`);
  for (const event of ["client.ui.error", "client.ui.unhandled_rejection"])
    assert.ok(
      diagnostics.some(
        (entry) => entry.event === event && entry.level === "error",
      ),
    );
  assert.ok(!JSON.stringify(diagnostics).includes("private"));
  assert.ok(!JSON.stringify(diagnostics).includes("Test UI render failure"));
  assert.ok(
    !diagnostics.some(
      (entry) =>
        entry.level === "error" &&
        ["cancelled", "stale"].includes(entry.record.outcome),
    ),
  );
  console.log(
    `Browser checks passed (${development ? "development StrictMode" : "production"}): bounded virtualization, full scroll, resize, mobile filters, grid render/layout isolation, IME, URL restore, stale search, whitespace, no-op filters, empty results, page retry and dataset-change restarts.`,
  );
} finally {
  socket?.close();
  chrome.kill();
  await new Promise((resolve) =>
    chrome.exitCode !== null ? resolve() : chrome.once("exit", resolve),
  );
  await new Promise((resolve) => server.close(resolve));
  await vite?.close();
  await rm(profile, { recursive: true, force: true });
}
