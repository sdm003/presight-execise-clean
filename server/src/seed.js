const db = require('./db');
const { seedDatabase } = require('./seed-data');

seedDatabase(db);
console.log('Seeded 1,000 users');
