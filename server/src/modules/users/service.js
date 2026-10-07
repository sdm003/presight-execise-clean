const { AppError } = require("../../shared/errors");
const { validateUser } = require("./validation");
const { span } = require("../../observability/tracing");

function createService(repository) {
  return {
    listUsers: (query) =>
      span("users.service.list", () => repository.listUsers(query), {
        "code.function.name": "listUsers",
      }),
    createUser: (body) =>
      span(
        "users.service.create",
        () => repository.createUser(validateUser(body)),
        { "code.function.name": "createUser" },
      ),
    deleteUser: (id) =>
      span(
        "users.service.delete",
        async () => {
          const deleted = await repository.deleteUser(id);
          if (deleted === null) throw new AppError("User not found", 404);
          return { id: deleted };
        },
        { "code.function.name": "deleteUser" },
      ),
  };
}

module.exports = { createService };
