const db = require('better-sqlite3')('data/recipes.sqlite');
const path = require('path');
const stmt = db.prepare('UPDATE recipes SET image_path = ? WHERE id = ?');
const all = db.prepare("SELECT id, image_path FROM recipes WHERE image_path IS NOT NULL AND image_path != ''").all();
let updated = 0;
db.transaction(() => {
  for (const row of all) {
    const bn = path.basename(row.image_path);
    if (bn !== row.image_path) { stmt.run(bn, row.id); updated++; }
  }
})();
const sample = db.prepare("SELECT recipe_name, image_path FROM recipes WHERE image_path IS NOT NULL LIMIT 3").all();
console.log('Atualizados:', updated);
console.log('Amostra:', JSON.stringify(sample, null, 2));
db.close();
