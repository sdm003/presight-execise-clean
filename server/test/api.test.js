const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const app = require('../src/index');

test('database schema is available', () => {
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='users'").get().name, 'users');
});

test('users endpoint applies filters and returns metadata', async () => {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/users?search=Ava&nationalities=American&hobbies=Reading&limit=2`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.length, 2);
    assert.equal(body.pagination.limit, 2);
    assert.ok(body.pagination.total > 0);
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
