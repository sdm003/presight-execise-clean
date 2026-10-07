class AppError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
  }
}

class ValidationError extends AppError {
  constructor(message) {
    super(message, 400);
  }
}

class ConfigurationError extends Error {
  constructor(key) {
    super(`Invalid configuration: ${key}`);
    this.name = "ConfigurationError";
    this.key = key;
  }
}

const unavailableCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "57P01",
  "57P02",
  "57P03",
  "53300",
  "08000",
  "08003",
  "08006",
  "57014",
  "55P03",
]);

function isUnavailable(error) {
  return unavailableCodes.has(error?.code);
}

module.exports = {
  AppError,
  ValidationError,
  ConfigurationError,
  isUnavailable,
};
