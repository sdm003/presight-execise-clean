const { ValidationError } = require("../../shared/errors");

function validateUser(body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ValidationError("Body must be a user object");
  const user = {};
  for (const [key, max] of [
    ["avatar", 2048],
    ["first_name", 100],
    ["last_name", 100],
    ["nationality", 100],
  ]) {
    if (
      typeof body[key] !== "string" ||
      !body[key].trim() ||
      body[key].trim().length > max ||
      /[\u0000-\u001f\u007f]/u.test(body[key])
    )
      throw new ValidationError(
        `${key} must be a nonempty string of at most ${max} characters without control characters`,
      );
    user[key] = body[key].trim();
  }
  let avatar;
  try {
    avatar = new URL(user.avatar);
  } catch {
    throw new ValidationError("avatar must be an absolute HTTP(S) URL");
  }
  if (
    !["https:", "http:"].includes(avatar.protocol) ||
    avatar.username ||
    avatar.password
  )
    throw new ValidationError(
      "avatar must be an absolute HTTP(S) URL without credentials",
    );
  if (!Number.isInteger(body.age) || body.age < 0 || body.age > 120)
    throw new ValidationError("age must be an integer between 0 and 120");
  user.age = body.age;
  if (
    !Array.isArray(body.hobbies) ||
    body.hobbies.length > 10 ||
    body.hobbies.some(
      (hobby) =>
        typeof hobby !== "string" ||
        !hobby.trim() ||
        hobby.trim().length > 100 ||
        /[\u0000-\u001f\u007f]/u.test(hobby),
    )
  )
    throw new ValidationError(
      "hobbies must contain 0–10 nonempty strings of at most 100 characters without control characters",
    );
  user.hobbies = body.hobbies.map((hobby) => hobby.trim());
  if (new Set(user.hobbies).size !== user.hobbies.length)
    throw new ValidationError("hobbies must be distinct");
  return user;
}
module.exports = { validateUser };
