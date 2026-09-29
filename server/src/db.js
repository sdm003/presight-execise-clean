const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { seedDatabase } = require('./seed-data');

const isVercel = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
const dataDir = path.join(__dirname, '..', 'data');
const dbPath = process.env.DATABASE_PATH || (isVercel ? ':memory:' : path.join(dataDir, 'users.sqlite'));
const bootstrap = isVercel;

if (!isVercel) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(dbPath);
if (!isVercel || bootstrap) {
  db.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      avatar TEXT NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
      age INTEGER NOT NULL, nationality TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hobbies (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      hobby TEXT NOT NULL, PRIMARY KEY(user_id, hobby)
    );
    CREATE INDEX IF NOT EXISTS hobbies_hobby ON hobbies(hobby);
  `);
}
if (bootstrap) seedDatabase(db);
if (isVercel) db.exec('PRAGMA query_only = ON; PRAGMA temp_store = MEMORY;');
module.exports = db;
