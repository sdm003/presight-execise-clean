export const api =
  import.meta.env.VITE_API_URL ||
  (import.meta.env.DEV ? "http://localhost:3001" : "");
export const validSorts = ["first_name", "last_name", "age", "nationality"];
export const normalizeSearch = (value) =>
  value.replace(/\s+/g, " ").trim().slice(0, 100);

export const readState = () => {
  const q = new URLSearchParams(location.search);
  const sort = q.get("sort");
  return {
    search: normalizeSearch(q.get("search") || ""),
    hobbies: [...new Set(q.getAll("hobby").filter(Boolean))].slice(0, 20),
    nationalities: [...new Set(q.getAll("nationality").filter(Boolean))].slice(
      0,
      20,
    ),
    sort: validSorts.includes(sort) ? sort : "first_name",
    direction: q.get("direction") === "desc" ? "desc" : "asc",
  };
};

export const writeState = (state) => {
  const q = new URLSearchParams();
  if (state.search) q.set("search", state.search);
  state.hobbies.forEach((v) => q.append("hobby", v));
  state.nationalities.forEach((v) => q.append("nationality", v));
  q.set("sort", state.sort);
  q.set("direction", state.direction);
  history.replaceState(null, "", `?${q.toString().replace(/\+/g, "%20")}`);
};
