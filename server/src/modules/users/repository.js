const { transaction } = require("../../database/transaction");
const { pool } = require("../../database/pool");
const { whereFor, positiveInteger, orderFor } = require("./query");
const { span } = require("../../observability/tracing");

function createRepository({ database = pool } = {}) {
  async function listUsers(query) {
    const page = positiveInteger(query.page, 1, 100000);
    const limit = positiveInteger(query.limit, 40, 100);
    const nationalityScope = whereFor({ ...query, nationality: undefined });
    const nationalityFilter = whereFor(
      { nationality: query.nationality },
      nationalityScope.params.length,
    );
    const params = [...nationalityScope.params, ...nationalityFilter.params];
    // One SQL statement shares a snapshot without holding a multi-command transaction.
    return span(
      "users.repository.list",
      async () => {
        const {
          rows: [result],
        } = await database.query(
          `SELECT result.* FROM (WITH nationality_scope AS (
           SELECT u.id, u.nationality FROM users u ${nationalityScope.clause}
         ), filtered AS (
           SELECT u.* FROM nationality_scope u ${nationalityFilter.clause}
         ), page_users AS (
           SELECT u.*, COALESCE(
             (SELECT array_agg(h.hobby ORDER BY h.hobby) FROM hobbies h WHERE h.user_id = u.id),
             ARRAY[]::text[]) hobbies
           FROM users u JOIN filtered f ON f.id = u.id
           ORDER BY ${orderFor(query)}
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}
         ), hobby_facets AS (
           SELECT h.hobby value, COUNT(*)::integer count
           FROM filtered f JOIN hobbies h ON h.user_id = f.id
           GROUP BY h.hobby ORDER BY count DESC, value ASC LIMIT 20
         ), nationality_facets AS (
           SELECT all_values.value, COALESCE(scoped.count, 0)::integer count
           FROM (SELECT DISTINCT nationality value FROM users) all_values
           LEFT JOIN (
             SELECT nationality value, COUNT(*)::integer count FROM nationality_scope GROUP BY nationality
           ) scoped USING (value)
           ORDER BY count DESC, value ASC LIMIT 20
         )
         SELECT (SELECT COUNT(*)::integer FROM filtered) total,
           COALESCE((SELECT json_agg(u ORDER BY ${orderFor(query)}) FROM page_users u), '[]'::json) data,
           COALESCE((SELECT json_agg(h ORDER BY h.count DESC, h.value ASC) FROM hobby_facets h), '[]'::json) hobbies,
           COALESCE((SELECT json_agg(n ORDER BY n.count DESC, n.value ASC) FROM nationality_facets n), '[]'::json) nationalities) result`,
          [...params, limit, (page - 1) * limit],
        );
        const { total } = result;
        return {
          data: result.data,
          pagination: { page, limit, total, hasMore: page * limit < total },
          facets: {
            hobbies: result.hobbies,
            nationalities: result.nationalities,
          },
        };
      },
      { "code.function.name": "listUsers" },
    );
  }

  const createUser = (user) =>
    transaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO users (avatar, first_name, last_name, age, nationality)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [
          user.avatar,
          user.first_name,
          user.last_name,
          user.age,
          user.nationality,
        ],
      );
      if (user.hobbies.length)
        await client.query(
          "INSERT INTO hobbies (user_id, hobby) SELECT $1, unnest($2::text[])",
          [rows[0].id, user.hobbies],
        );
      return { ...rows[0], hobbies: user.hobbies };
    }, database);

  const deleteUser = (id) =>
    transaction(async (client) => {
      const { rows } = await client.query(
        "DELETE FROM users WHERE id = $1 RETURNING id",
        [id],
      );
      return rows[0] ? rows[0].id : null;
    }, database);

  return { listUsers, createUser, deleteUser };
}

module.exports = { ...createRepository(), createRepository };
