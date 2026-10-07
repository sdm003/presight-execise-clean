CREATE INDEX IF NOT EXISTS users_first_name_id ON users(first_name, id);
CREATE INDEX IF NOT EXISTS users_last_name_id ON users(last_name, id);
CREATE INDEX IF NOT EXISTS users_age_id ON users(age, id);
CREATE INDEX IF NOT EXISTS users_nationality_id ON users(nationality, id);
CREATE INDEX IF NOT EXISTS hobbies_hobby_user_id ON hobbies(hobby, user_id);
DROP INDEX IF EXISTS hobbies_hobby;
