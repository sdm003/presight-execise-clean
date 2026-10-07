const test = require("node:test");
const assert = require("node:assert/strict");
const { validateUser } = require("../src/modules/users/validation");
const {
  whereFor,
  orderFor,
  positiveInteger,
} = require("../src/modules/users/query");
const { createService } = require("../src/modules/users/service");
const { createApp } = require("../src/index");

const quiet = { info() {}, error() {}, fatal() {} };
const user = {
  avatar: "https://example.com/avatar.png",
  first_name: " Ava ",
  last_name: "Chen",
  age: 25,
  nationality: "American",
  hobbies: ["Reading", "Cycling"],
};

test("creation accepts the 0 and 10 distinct hobby boundaries", () => {
  for (const hobbies of [
    [],
    Array.from({ length: 10 }, (_, i) => `Hobby ${i + 1}`),
  ])
    assert.deepEqual(validateUser({ ...user, hobbies }).hobbies, hobbies);
});

test("creation validates all six fields and URL protocol", () => {
  assert.equal(validateUser(user).first_name, "Ava");
  assert.deepEqual(validateUser({ ...user, hobbies: [] }).hobbies, []);
  for (const body of [
    null,
    [],
    {},
    { ...user, first_name: "" },
    { ...user, last_name: 1 },
    { ...user, age: "25" },
    { ...user, age: 121 },
    { ...user, age: -1 },
    { ...user, age: 0.5 },
    { ...user, avatar: "javascript:alert(1)" },
    { ...user, avatar: "/relative" },
    { ...user, avatar: "******example.com/" },
    { ...user, avatar: "x".repeat(2049) },
    { ...user, hobbies: Array(11).fill("Reading") },
    { ...user, hobbies: ["Reading", " Reading "] },
    { ...user, hobbies: [""] },
    { ...user, hobbies: [3] },
    { ...user, hobbies: ["x".repeat(101)] },
    { ...user, first_name: "A\nB" },
  ])
    assert.throws(() => validateUser(body));
});

test("creation trims string fields while preserving numeric age", () => {
  assert.deepEqual(validateUser({ ...user, nationality: " American " }), {
    avatar: "https://example.com/avatar.png",
    first_name: "Ava",
    last_name: "Chen",
    age: 25,
    nationality: "American",
    hobbies: ["Reading", "Cycling"],
  });
});

test("filters parameterize literal search and hobby AND / nationality OR", () => {
  const query = whereFor({
    search: "  A_%\\   B ",
    hobby: ["Reading", "Cycling", "Reading"],
    nationality: ["American", "British"],
  });
  assert.deepEqual(query.params, [
    "%A\\_\\%\\\\ B%",
    ["American", "British"],
    "Reading",
    "Cycling",
  ]);
  assert.match(query.clause, /ILIKE \$1/);
  assert.match(query.clause, /ANY\(\$2::text\[\]\)/);
  assert.equal((query.clause.match(/EXISTS/g) || []).length, 2);
  assert.match(query.clause, /AND/);
  assert.deepEqual(whereFor({ search: " \n " }), { clause: "", params: [] });
});

test("filters deduplicate repeated values and cap each list to 20 entries", () => {
  const hobbies = Array.from(
    { length: 25 },
    (_, index) => `Hobby ${index % 22}`,
  );
  const nationalities = Array.from(
    { length: 25 },
    (_, index) => `Nation ${index % 22}`,
  );
  const query = whereFor({
    hobby: hobbies,
    nationality: nationalities,
  });
  assert.equal(query.params[0].length, 20);
  assert.equal(query.params.slice(1).length, 20);
});

test("filter values preserve commas and trim single and repeated strings", () => {
  assert.deepEqual(
    whereFor({ nationality: [" A,B ", "A,B", ""], hobby: "Arts, crafts" })
      .params,
    [["A,B"], "Arts, crafts"],
  );
  for (const value of [null, 12, {}, ["Reading", 12]])
    assert.throws(() => whereFor({ hobby: value }), {
      name: "ValidationError",
    });
  assert.equal(
    validateUser({ ...user, nationality: "A,B", hobbies: ["Arts, crafts"] })
      .nationality,
    "A,B",
  );
});

test("HTTP repeated filter keys reach parameterized queries without CSV splitting", async () => {
  const app = createApp({
    log: quiet,
    repository: { listUsers: async (query) => whereFor(query) },
  });
  const server = app.listen(0);
  try {
    const params = new URLSearchParams();
    for (const value of ["Reading", "Arts, crafts", " Reading "])
      params.append("hobby", value);
    for (const value of ["A,B", "French", "French"])
      params.append("nationality", value);
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/users?${params}`,
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.params, [
      ["A,B", "French"],
      "Reading",
      "Arts, crafts",
    ]);
    assert.equal((result.clause.match(/EXISTS/g) || []).length, 2);
    assert.match(result.clause, /ANY/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("DELETE users removes a valid user id", async () => {
  let deletedId;
  const app = createApp({
    log: quiet,
    repository: {
      listUsers: async () => ({
        data: [],
        pagination: { page: 1, limit: 40, total: 0, hasMore: false },
        facets: { hobbies: [], nationalities: [] },
      }),
      createUser: async () => ({ id: 1 }),
      deleteUser: async (id) => {
        deletedId = id;
        return id;
      },
    },
  });
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/api/users/42`;
  try {
    const response = await fetch(url, { method: "DELETE" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: 42 });
    assert.equal(deletedId, 42);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("sort allowlist and pagination limits", () => {
  assert.equal(orderFor({ sort: "constructor" }), "u.first_name ASC, u.id ASC");
  assert.equal(
    orderFor({ sort: "age", direction: "desc" }),
    "u.age DESC, u.id ASC",
  );
  assert.equal(
    orderFor({ sort: "age; DROP TABLE users" }),
    "u.first_name ASC, u.id ASC",
  );
  assert.equal(positiveInteger("999", 40, 100), 100);
  assert.equal(positiveInteger("-1", 40, 100), 40);
});

test("service validates create input before repository and passes list query through", async () => {
  let listedWith;
  let createdWith;
  const service = createService({
    listUsers: async (query) => {
      listedWith = query;
      return { ok: true };
    },
    createUser: async (record) => {
      createdWith = record;
      return { id: 1, ...record };
    },
  });

  const query = { search: "Ava", page: "2" };
  assert.deepEqual(await service.listUsers(query), { ok: true });
  assert.equal(listedWith, query);

  const created = await service.createUser(user);
  assert.equal(created.id, 1);
  assert.equal(createdWith.first_name, "Ava");
  assert.deepEqual(createdWith.hobbies, ["Reading", "Cycling"]);

  await assert.rejects(service.createUser({}), /avatar/);
});

test("POST invalid data and malformed JSON return explicit 400 without database", async () => {
  let databaseReads = 0;
  let writes = 0;
  const app = createApp({
    config: { mode: "test", origin: "" },
    log: quiet,
    database: {
      query: async () => {
        databaseReads++;
        return { rows: [{ ok: 1 }] };
      },
    },
    repository: {
      listUsers: async () => ({
        data: [],
        pagination: { page: 1, limit: 40, total: 0, hasMore: false },
        facets: { hobbies: [], nationalities: [] },
      }),
      createUser: async (body) => {
        writes++;
        return { id: 1, ...body };
      },
    },
  });
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/api`;
    for (const body of ["{}", "{broken"]) {
      const response = await fetch(`${base}/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      assert.equal(response.status, 400);
      assert.ok((await response.json()).error);
    }
    const missing = await fetch(`${base}/missing`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "Not found" });
    assert.equal(databaseReads, 0);
    assert.equal(writes, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
