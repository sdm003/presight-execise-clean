const first = ['Ava', 'Liam', 'Mia', 'Noah', 'Zoe', 'Ethan', 'Emma', 'Leo', 'Nora', 'Owen', 'Isla', 'Kai', 'Aria', 'Milo', 'Luna', 'Finn', 'Ruby', 'Jude', 'Iris', 'Theo'];
const last = ['Smith', 'Garcia', 'Chen', 'Patel', 'Brown', 'Kim', 'Martin', 'Wilson', 'Khan', 'Taylor', 'Nguyen', 'Rossi', 'Silva', 'Haddad', 'Novak', 'Okafor', 'Duval', 'Meyer', 'Costa', 'Abadi'];
const nationalities = ['American', 'British', 'Canadian', 'French', 'German', 'Indian', 'Japanese', 'Mexican', 'Spanish', 'Swedish'];
const hobbies = ['Reading', 'Cycling', 'Cooking', 'Photography', 'Hiking', 'Music', 'Gaming', 'Travel', 'Painting', 'Gardening', 'Running', 'Chess'];

const rand = seed => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

function seedDatabase(db) {
  db.exec('DELETE FROM hobbies; DELETE FROM users;');
  const insertUser = db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)');
  const insertHobby = db.prepare('INSERT INTO hobbies VALUES (?, ?)');
  const pick = rand(20240517);
  db.exec('BEGIN');
  try {
    for (let id = 1; id <= 1000; id++) {
      const firstName = first[Math.floor(pick() * first.length)];
      const lastName = last[Math.floor(pick() * last.length)];
      const age = 18 + Math.floor(pick() * 63);
      const nationality = nationalities[Math.floor(pick() * nationalities.length)];
      insertUser.run(id, `https://i.pravatar.cc/96?img=${(id % 70) + 1}`, firstName, lastName, age, nationality);
      const chosen = new Set();
      const count = 1 + Math.floor(pick() * 6);
      while (chosen.size < count) chosen.add(hobbies[Math.floor(pick() * hobbies.length)]);
      for (const hobby of chosen) insertHobby.run(id, hobby);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { seedDatabase };
