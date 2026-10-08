LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE;

-- Serialize the empty-database check with API writes as well as other migrations.
WITH catalog AS (
  SELECT
    ARRAY['Ava', 'Oliver', 'Emma', 'Louis', 'Mia', 'Luca', 'Yui', 'Mateo', 'Sofia', 'Noah',
          'Arjun', 'Helena', 'Min', 'Zofia', 'Lars', 'Aigerim', 'Amir', 'Leila', 'Theo', 'Nora',
          'Ethan', 'Isla', 'Hugo', 'Elena', 'Felix'] first_names,
    ARRAY['Smith', 'Wilson', 'Martin', 'Dubois', 'Mueller', 'Rossi', 'Tanaka', 'Garcia',
          'Lopez', 'Taylor', 'Patel', 'Silva', 'Kim', 'Kowalski', 'Andersen', 'Sadykov',
          'Hassan', 'Bennett', 'Chen', 'Brooks', 'Reed', 'Morgan', 'Park', 'Rivera',
          'Clarke', 'Santos', 'Novak', 'Jensen', 'Singh', 'Ahmed', 'Costa', 'Meyer',
          'Baker', 'Cooper', 'Gray', 'Evans', 'Young', 'Walker', 'Hill', 'Scott'] last_names,
    ARRAY['American', 'British', 'Canadian', 'French', 'German', 'Italian', 'Japanese', 'Mexican',
          'Spanish', 'Australian', 'Indian', 'Brazilian', 'Korean', 'Polish', 'Danish', 'Kazakh',
          'Egyptian', 'Moroccan', 'Turkish', 'Swedish', 'Norwegian', 'Finnish', 'Portuguese', 'Dutch',
          'Belgian', 'Swiss', 'Austrian', 'Greek', 'Irish', 'Argentinian', 'Chilean', 'New Zealander'] nationalities,
    ARRAY['Reading', 'Cycling', 'Cooking', 'Photography', 'Hiking', 'Swimming', 'Gardening', 'Painting',
          'Running', 'Travel', 'Music', 'Chess', 'Yoga', 'Dancing', 'Fishing', 'Climbing',
          'Sailing', 'Surfing', 'Skiing', 'Writing', 'Pottery', 'Knitting', 'Woodworking', 'Baking',
          'Tennis', 'Basketball', 'Football', 'Volunteering', 'Astronomy', 'Birdwatching', 'Camping', 'Piano'] hobbies
), demo AS (
  SELECT
    'https://randomuser.me/api/portraits/' ||
      CASE WHEN i % 2 = 0 THEN 'women/' ELSE 'men/' END ||
      ((i / 2) % 100)::text || '.jpg' avatar,
    c.first_names[i % 25 + 1] first_name,
    c.last_names[i / 25 + 1] last_name,
    18 + (i * 17) % 63 age,
    c.nationalities[(i * 7) % 32 + 1] nationality,
    ARRAY(SELECT c.hobbies[(i * 7 + j * 3) % 32 + 1]
          FROM generate_series(0, (i % 11) - 1) j) hobbies
  FROM catalog c CROSS JOIN generate_series(0, 999) i
  WHERE NOT EXISTS (SELECT 1 FROM users)
), inserted AS (
  INSERT INTO users (avatar, first_name, last_name, age, nationality)
  SELECT avatar, first_name, last_name, age, nationality FROM demo
  RETURNING id, first_name, last_name
)
INSERT INTO hobbies (user_id, hobby)
SELECT u.id, unnest(d.hobbies)
FROM inserted u JOIN demo d USING (first_name, last_name);
