const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const db = require('../src/db');
const app = require('../src/index');
const { seedDatabase } = require('../src/seed-data');

test('database schema is available', () => {
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='users'").get().name, 'users');
});

test('seed data is diverse, deterministic, and complete', () => {
  const build = () => {
    const memory = new DatabaseSync(':memory:');
    memory.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, avatar TEXT, first_name TEXT, last_name TEXT, age INTEGER, nationality TEXT); CREATE TABLE hobbies(user_id INTEGER, hobby TEXT, PRIMARY KEY(user_id,hobby));');
    seedDatabase(memory);
    return memory;
  };
  const a = build();
  assert.equal(a.prepare('SELECT COUNT(*) c FROM users').get().c, 1000);
  assert.ok(a.prepare("SELECT COUNT(DISTINCT first_name || ' ' || last_name) c FROM users").get().c > 200);
  assert.equal(a.prepare('SELECT COUNT(*) c FROM users u WHERE NOT EXISTS (SELECT 1 FROM hobbies h WHERE h.user_id = u.id)').get().c, 0);
  const b = build();
  assert.deepEqual(a.prepare('SELECT first_name, last_name FROM users WHERE id = 42').get(), b.prepare('SELECT first_name, last_name FROM users WHERE id = 42').get());
});

test('users endpoint applies filters and returns metadata', async () => {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/users?nationalities=American&limit=2`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.data.length <= 2);
    assert.equal(body.pagination.limit, 2);
    assert.ok(body.data.every(user => user.nationality === 'American'));
    assert.ok(Array.isArray(body.facets.nationalities));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('invalid API routes return JSON errors', async () => {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/missing`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Not found' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
