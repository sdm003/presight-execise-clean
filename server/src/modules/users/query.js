const { ValidationError } = require("../../shared/errors");

const sortFields = {
  first_name: "u.first_name",
  last_name: "u.last_name",
  age: "u.age",
  nationality: "u.nationality",
};
function parseFilterValues(value) {
  const values =
    value === undefined ? [] : Array.isArray(value) ? value : [value];
  if (values.some((item) => typeof item !== "string"))
    throw new ValidationError("Filter values must be strings");
  return [
    ...new Set(
      values
        .flatMap((item) => item.split(","))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);
}

function whereFor(query, parameterOffset = 0) {
  const text = String(query.search || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  const nationalities = parseFilterValues(query.nationality);
  const clauses = [];
  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${parameterOffset + params.length}`;
  };
  if (text)
    clauses.push(
      `(u.first_name || ' ' || u.last_name) ILIKE ${bind(`%${text.replace(/[\\%_]/g, "\\$&")}%`)} ESCAPE '\\'`,
    );
  if (nationalities.length)
    clauses.push(`u.nationality = ANY(${bind(nationalities)}::text[])`);
  for (const hobby of parseFilterValues(query.hobby))
    clauses.push(
      `EXISTS (SELECT 1 FROM hobbies hx WHERE hx.user_id = u.id AND hx.hobby = ${bind(hobby)})`,
    );
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

function orderFor(query) {
  const field = Object.hasOwn(sortFields, query.sort)
    ? sortFields[query.sort]
    : sortFields.first_name;
  return `${field} ${String(query.direction).toLowerCase() === "desc" ? "DESC" : "ASC"}, u.id ASC`;
}
module.exports = { whereFor, positiveInteger, orderFor };
