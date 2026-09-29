const first = ['Ava', 'Liam', 'Mia', 'Noah', 'Zoe', 'Ethan', 'Emma', 'Leo', 'Nora', 'Owen'];
const last = ['Smith', 'Garcia', 'Chen', 'Patel', 'Brown', 'Kim', 'Martin', 'Wilson', 'Khan', 'Taylor'];
const nationalities = ['American', 'British', 'Canadian', 'French', 'German', 'Indian', 'Japanese', 'Mexican', 'Spanish', 'Swedish'];
const hobbies = ['Reading', 'Cycling', 'Cooking', 'Photography', 'Hiking', 'Music', 'Gaming', 'Travel', 'Painting', 'Gardening', 'Running', 'Chess'];

function seedDatabase(db) {
  db.exec('DELETE FROM hobbies; DELETE FROM users;');
  const user = db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)');
  const hobby = db.prepare('INSERT INTO hobbies VALUES (?, ?)');
  for (let id = 1; id <= 1000; id++) {
    user.run(id, `https://i.pravatar.cc/96?img=${(id % 70) + 1}`, first[id % first.length], last[(id * 7) % last.length], 18 + (id * 13) % 63, nationalities[id % nationalities.length]);
    const count = (id * 5) % 11;
    for (let n = 0; n < count; n++) hobby.run(id, hobbies[(id + n) % hobbies.length]);
  }
}

module.exports = { seedDatabase };
