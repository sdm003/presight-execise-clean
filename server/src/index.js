const express = require("express");
const path = require("node:path");
const db = require("./db");

const app = express();
const port = Number(process.env.PORT || 3001);
app.use(express.static(path.join(__dirname, "../../client/dist")));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigin =
    process.env.CLIENT_ORIGIN ||
    (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      ? origin
      : "");
  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
const sortFields = {
  first_name: "u.first_name",
  last_name: "u.last_name",
  age: "u.age",
  nationality: "u.nationality",
};
const csv = (value) =>
  (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item || "").split(","))
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);

function whereFor(query) {
  const text = String(query.search || "")
    .trim()
    .slice(0, 100);
  const nationalities = csv(query.nationalities);
  const selectedHobbies = csv(query.hobbies);
  const clauses = [];
  const params = [];
  if (text) {
    clauses.push("(u.first_name || ' ' || u.last_name) LIKE ?");
    params.push(`%${text}%`);
  }
  if (nationalities.length) {
    clauses.push(
      `u.nationality IN (${nationalities.map(() => "?").join(",")})`,
    );
    params.push(...nationalities);
  }
  selectedHobbies.forEach((value) => {
    clauses.push(
      "EXISTS (SELECT 1 FROM hobbies hx WHERE hx.user_id = u.id AND hx.hobby = ?)",
    );
    params.push(value);
  });
  return {
    clause: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function positiveInteger(value, fallback, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, max)
    : fallback;
}

function getUsers(req, res) {
  const { clause, params } = whereFor(req.query);
  const page = positiveInteger(req.query.page, 1, 100000);
  const limit = positiveInteger(req.query.limit, 40, 100);
  const field = sortFields[req.query.sort] || sortFields.first_name;
  const direction =
    String(req.query.direction).toLowerCase() === "desc" ? "DESC" : "ASC";
  const total = db
    .prepare(`SELECT COUNT(*) count FROM users u ${clause}`)
    .get(...params).count;
  const rows = db
    .prepare(
      `
    SELECT u.*, COALESCE(json_group_array(h.hobby) FILTER (WHERE h.hobby IS NOT NULL), '[]') hobbies
    FROM users u LEFT JOIN hobbies h ON h.user_id = u.id ${clause}
    GROUP BY u.id ORDER BY ${field} ${direction}, u.id ASC LIMIT ? OFFSET ?
  `,
    )
    .all(...params, limit, (page - 1) * limit)
    .map((row) => ({ ...row, hobbies: JSON.parse(row.hobbies) }));
  const hobbyCounts = db
    .prepare(
      `SELECT h.hobby value, COUNT(*) count FROM users u JOIN hobbies h ON h.user_id = u.id ${clause} GROUP BY h.hobby ORDER BY count DESC, value ASC LIMIT 20`,
    )
    .all(...params);
  const nationalityFilter = { ...req.query, nationalities: "" };
  const nationalityScope = whereFor(nationalityFilter);
  const nationalityCounts = db
    .prepare(
      `SELECT u.nationality value, COUNT(*) count FROM users u ${nationalityScope.clause} GROUP BY u.nationality`,
    )
    .all(...nationalityScope.params);
  const countsByNationality = new Map(
    nationalityCounts.map((item) => [item.value, item.count]),
  );
  const allNationalities = db
    .prepare("SELECT DISTINCT nationality value FROM users")
    .all()
    .map((item) => ({
      value: item.value,
      count: countsByNationality.get(item.value) || 0,
    }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, 20);
  res.json({
    data: rows,
    pagination: { page, limit, total, hasMore: page * limit < total },
    facets: { hobbies: hobbyCounts, nationalities: allNationalities },
  });
}

app.get("/api/users", getUsers);

app.get("/api/health", (_, res) => res.json({ ok: true }));

app.use("/api", (_, res) => res.status(404).json({ error: "Not found" }));
app.use((error, _, res, next) => {
  if (res.headersSent) return next(error);
  console.error(error);
  res.status(500).json({ error: "Internal server error" });
});

if (require.main === module) {
  app.listen(port, () => console.log(`API listening on ${port}`));
}

module.exports = app;
