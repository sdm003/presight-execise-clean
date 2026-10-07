const { validateUser } = require("./validation");
const { span } = require("../../observability/tracing");

function createService(repository) {
  return {
    listUsers: (query) => span("users.list", () => repository.listUsers(query)),
    createUser: (body) =>
      span("users.create", () => repository.createUser(validateUser(body))),
  };
}

module.exports = { createService };
