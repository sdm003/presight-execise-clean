import test from "node:test";
import assert from "node:assert/strict";
import { rowWindow, CARD_HEIGHT, GAP } from "../src/virtual.js";
import { validatePage } from "../src/users.js";
import {
  changeState,
  normalizeSearch,
  readState,
  stateParams,
  writeState,
} from "../src/state.js";

test("URL state normalizes search, deduplicates and limits filters, and round-trips", () => {
  const state = readState(
    "?search=%20Ava%20%20Chen%20&hobby=Reading,Reading,&nationality=French&sort=unknown&direction=invalid",
  );
  assert.deepEqual(state, {
    search: "Ava Chen",
    hobbies: ["Reading"],
    nationalities: ["French"],
    sort: "first_name",
    direction: "asc",
  });

  assert.equal(normalizeSearch(" ".repeat(20)), "");
  assert.equal(normalizeSearch("a".repeat(101)).length, 100);
  const many = new URLSearchParams();
  many.set(
    "hobby",
    Array.from({ length: 25 }, (_, i) => `Hobby ${i}`).join(","),
  );
  assert.equal(readState(many.toString()).hobbies.length, 20);
  const previous = globalThis.history;
  let url;
  try {
    globalThis.history = {
      replaceState: (_state, _title, next) => {
        url = next;
      },
    };
    writeState({ ...state, search: "A & B", sort: "age", direction: "desc" });
    assert.deepEqual(readState(url), {
      ...state,
      search: "A & B",
      sort: "age",
      direction: "desc",
    });
  } finally {
    if (previous === undefined) delete globalThis.history;
    else globalThis.history = previous;
  }
});

test("client URL and API serialization use comma-separated filter values", () => {
  const state = {
    ...readState(""),
    hobbies: ["Arts", "crafts", "A & B", "Reading"],
    nationalities: ["A", "B", "French"],
  };
  const params = stateParams(state);
  assert.equal(params.get("hobby"), state.hobbies.join(","));
  assert.equal(params.get("nationality"), state.nationalities.join(","));
  assert.equal(params.has("hobbies"), false);
  assert.equal(params.has("nationalities"), false);
  assert.deepEqual(readState(params.toString()), state);
});

test("equivalent filter updates preserve state identity and successive toggles compose", () => {
  const state = readState("");
  assert.equal(
    changeState(state, { search: "", hobbies: [], nationalities: [] }),
    state,
  );
  assert.equal(changeState(state, { sort: "first_name" }), state);
  const selected = changeState(state, { hobbies: ["Reading"] });
  assert.notEqual(selected, state);
  assert.equal(changeState(selected, { hobbies: ["Reading"] }), selected);
  const next = changeState(selected, {
    hobbies: [...selected.hobbies, "Cycling"],
  });
  assert.deepEqual(next.hobbies, ["Reading", "Cycling"]);
  assert.deepEqual(state.hobbies, []);
});

test("row virtualization bounds DOM, includes viewport and handles resize/short sets", () => {
  const stride = CARD_HEIGHT + GAP;
  for (const columns of [1, 2, 3, 4]) {
    const count = 1000;
    for (const scroll of [0, 350, 2000, 10000, 40000]) {
      const view = rowWindow(count, columns, scroll, 350, 800);
      assert.ok(view.start % columns === 0);
      assert.ok(view.end <= count);
      assert.ok(
        view.end - view.start <= (Math.ceil(800 / stride) + 10) * columns,
      );
      assert.equal(view.height, Math.ceil(count / columns) * stride - GAP);
      if (scroll >= 350 && scroll - 350 < view.height) {
        assert.ok(view.top <= scroll - 350);
        assert.ok(
          Math.ceil(view.end / columns) * stride >=
            Math.min(scroll + 800 - 350, view.height),
        );
      }
    }
  }
  assert.equal(rowWindow(0, 1, 0, 350, 800).height, 0);
  assert.deepEqual(rowWindow(2, 3, 0, 350, 800), {
    start: 0,
    end: 2,
    top: 0,
    height: 142,
  });
});

test("page validation rejects duplicates, wrong pages and malformed metadata", () => {
  const user = {
    id: 1,
    avatar: "",
    first_name: "A",
    last_name: "B",
    nationality: "C",
    age: 20,
    hobbies: [],
  };
  const body = {
    data: [user],
    pagination: { page: 1, limit: 40, total: 1, hasMore: false },
    facets: { hobbies: [], nationalities: [] },
  };
  assert.equal(validatePage(body, 1), body);
  assert.throws(() => validatePage(body, 2));
  assert.throws(() => validatePage(body, 1, new Set([1])), {
    code: "PAGE_OVERLAP",
  });
  assert.throws(
    () => validatePage({ ...body, data: [user, user] }, 1, new Set([1])),
    (error) => error.code !== "PAGE_OVERLAP",
  );
  assert.throws(() =>
    validatePage(
      { ...body, pagination: { ...body.pagination, hasMore: true } },
      1,
    ),
  );
  for (const malformed of [
    null,
    {},
    { ...body, data: [null] },
    { ...body, data: [{ ...user, id: -1 }] },
    { ...body, data: [{ ...user, id: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...body, data: [{ ...user, age: 121 }] },
    { ...body, data: [{ ...user, hobbies: [null] }] },
    { ...body, facets: { hobbies: [null], nationalities: [] } },
    {
      ...body,
      facets: { hobbies: [{ value: "Reading", count: -1 }], nationalities: [] },
    },
  ]) {
    assert.throws(() => validatePage(malformed, 1), {
      message: "Invalid directory response. Please try again.",
    });
  }
});

test("page validation accepts full and terminal partial pages", () => {
  const user = (id) => ({
    id,
    avatar: "",
    first_name: `First ${id}`,
    last_name: "Last",
    nationality: "French",
    age: 30,
    hobbies: ["Reading"],
  });
  const facets = {
    hobbies: [{ value: "Reading", count: 40 }],
    nationalities: [],
  };
  const full = {
    data: Array.from({ length: 40 }, (_, index) => user(index + 1)),
    pagination: { page: 1, limit: 40, total: 41, hasMore: true },
    facets,
  };
  assert.equal(validatePage(full, 1).data.length, 40);

  const terminal = {
    data: [user(41)],
    pagination: { page: 2, limit: 40, total: 41, hasMore: false },
    facets,
  };
  assert.equal(
    validatePage(terminal, 2, new Set(full.data.map((item) => item.id))).data
      .length,
    1,
  );
  assert.throws(() =>
    validatePage(
      { ...terminal, data: [] },
      2,
      new Set(full.data.map((item) => item.id)),
    ),
  );
});
