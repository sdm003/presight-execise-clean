const { AppError } = require("../../shared/errors");
const { createService } = require("./service");

function mountUsers(app, repository) {
  const service = createService(repository);
  app.get("/api/users", async (req, res) => {
    req.admission.hold();
    try {
      res.json(await service.listUsers(req.query));
    } finally {
      req.admission.complete();
    }
  });
  app.post("/api/users", async (req, res) => {
    req.admission.hold();
    try {
      if (!req.is("application/json"))
        throw new AppError("Content-Type must be application/json", 415);
      res.status(201).json(await service.createUser(req.body));
    } finally {
      req.admission.complete();
    }
  });
}

module.exports = { mountUsers };
