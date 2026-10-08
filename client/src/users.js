export function validatePage(body, page, seen = new Set()) {
  const validFacets = (items) =>
    Array.isArray(items) &&
    items.every(
      (item) =>
        !!item &&
        typeof item.value === "string" &&
        Number.isInteger(item.count) &&
        item.count >= 0,
    );
  const ids = new Set();
  if (
    !body ||
    !Array.isArray(body.data) ||
    !body.data.every((user) => {
      if (
        !user ||
        !Number.isSafeInteger(user.id) ||
        user.id <= 0 ||
        ids.has(user.id) ||
        !["avatar", "first_name", "last_name", "nationality"].every(
          (key) => typeof user[key] === "string",
        ) ||
        !Number.isInteger(user.age) ||
        user.age < 0 ||
        user.age > 120 ||
        !Array.isArray(user.hobbies) ||
        !user.hobbies.every((hobby) => typeof hobby === "string")
      )
        return false;
      ids.add(user.id);
      return true;
    }) ||
    body.pagination?.page !== page ||
    !Number.isSafeInteger(body.pagination?.total) ||
    body.pagination.total < 0 ||
    body.pagination.limit !== 40 ||
    body.data.length > 40 ||
    body.data.length !==
      Math.min(40, Math.max(0, body.pagination.total - (page - 1) * 40)) ||
    body.pagination.hasMore !== page * 40 < body.pagination.total ||
    !validFacets(body.facets?.hobbies) ||
    !validFacets(body.facets?.nationalities)
  )
    throw Object.assign(
      Error("Invalid directory response. Please try again."),
      {
        code: "INVALID_RESPONSE",
      },
    );
  if (body.data.some((user) => seen.has(user.id)))
    throw Object.assign(Error("Directory changed. Please try again."), {
      code: "PAGE_OVERLAP",
    });
  return body;
}
