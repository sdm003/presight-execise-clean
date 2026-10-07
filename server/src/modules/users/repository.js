const { transaction } = require("../../database/transaction");
const { pool } = require("../../database/pool");
const { whereFor, positiveInteger, orderFor } = require("./query");

function createRepository({ database = pool } = {}) {
  async function listUsers(query) {
    const { clause, params } = whereFor(query);
    const page = positiveInteger(query.page, 1, 100000);
    const limit = positiveInteger(query.limit, 40, 100);
    const nationalityScope = whereFor({ ...query, nationality: undefined });
    // One snapshot keeps pagination and counts consistent with concurrent creations.
    return transaction(async (client) => {
      await client.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const { rows: totals } = await client.query(
        `SELECT COUNT(*)::integer count FROM users u ${clause}`,
        params,
      );
      const { rows } = await client.query(
        `SELECT u.*, COALESCE(
         (SELECT array_agg(h.hobby ORDER BY h.hobby) FROM hobbies h WHERE h.user_id = u.id),
         ARRAY[]::text[]) hobbies
       FROM (SELECT u.* FROM users u ${clause} ORDER BY ${orderFor(query)}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}) u
       ORDER BY ${orderFor(query)}`,
        [...params, limit, (page - 1) * limit],
      );
      const { rows: hobbies } = await client.query(
        `SELECT h.hobby value, COUNT(*)::integer count FROM users u JOIN hobbies h ON h.user_id = u.id ${clause}
       GROUP BY h.hobby ORDER BY count DESC, value ASC LIMIT 20`,
        params,
      );
      const { rows: nationalities } = await client.query(
        `SELECT all_values.value, COALESCE(scoped.count, 0)::integer count
       FROM (SELECT DISTINCT nationality value FROM users) all_values
       LEFT JOIN (SELECT u.nationality value, COUNT(*)::integer count FROM users u ${nationalityScope.clause} GROUP BY u.nationality) scoped USING (value)
       ORDER BY count DESC, value ASC LIMIT 20`,
        nationalityScope.params,
      );
      const total = totals[0].count;
      return {
        data: rows,
        pagination: { page, limit, total, hasMore: page * limit < total },
        facets: { hobbies, nationalities },
      };
    }, database);
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

  return { listUsers, createUser };
}

module.exports = { ...createRepository(), createRepository };
