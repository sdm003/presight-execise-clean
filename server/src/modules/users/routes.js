const { AppError } = require("../../shared/errors");
const { timingSafeEqual } = require("node:crypto");
const { createService } = require("./service");

function authorized(req, token) {
  if (!token) return false;
  const value = req.get("authorization") || "";
  const supplied = value.startsWith("Bearer ") ? value.slice(7) : "";
  const expected = Buffer.from(token);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function mountUsers(app, repository, { adminToken } = {}) {
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
  app.delete("/api/users/:id", async (req, res) => {
    req.admission.hold();
    try {
      if (!authorized(req, adminToken)) {
        res.setHeader("WWW-Authenticate", "Bearer");
        throw new AppError("Authorization required", 401);
      }
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1)
        throw new AppError("Invalid user id", 400);
      res.json(await service.deleteUser(id));
    } finally {
      req.admission.complete();
    }
  });
}

module.exports = { mountUsers };
