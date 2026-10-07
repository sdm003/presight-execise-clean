const { AppError } = require("../../shared/errors");
const { validateUser } = require("./validation");
const { span } = require("../../observability/tracing");

function createService(repository) {
  return {
    listUsers: (query) => span("users.list", () => repository.listUsers(query)),
    createUser: (body) =>
      span("users.create", () => repository.createUser(validateUser(body))),
    deleteUser: (id) =>
      span("users.delete", async () => {
        const deleted = await repository.deleteUser(id);
        if (deleted === null) throw new AppError("User not found", 404);
        return { id: deleted };
      }),
  };
}

module.exports = { createService };
