/**
 * Migrates image_path values in the DB from v2.0 absolute paths to v3.0 paths.
 * Only updates records where the image file actually exists in v3.0 data/images.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'recipes.sqlite');
const IMAGES_DIR = path.join(ROOT, 'data', 'images');

const db = new Database(DB_PATH);

const all = db.prepare("SELECT id, recipe_name, image_path FROM recipes WHERE image_path IS NOT NULL AND image_path != ''").all();

let updated = 0;
let notFound = 0;
let alreadyOk = 0;

const updateStmt = db.prepare("UPDATE recipes SET image_path = ? WHERE id = ?");

db.transaction(() => {
  for (const row of all) {
    const oldPath = row.image_path;
    const basename = path.basename(oldPath);
    const newPath = path.join(IMAGES_DIR, basename);

    // Already pointing to v3.0
    if (path.resolve(oldPath).toLowerCase().startsWith(path.resolve(IMAGES_DIR).toLowerCase())) {
      alreadyOk++;
      continue;
    }

    if (fs.existsSync(newPath)) {
      updateStmt.run(newPath, row.id);
      updated++;
    } else {
      console.log(`NAO ENCONTRADO em v3.0: "${row.recipe_name}" => ${basename}`);
      notFound++;
    }
  }
})();

console.log(`\n=== RESULTADO ===`);
console.log(`Atualizados: ${updated}`);
console.log(`Já OK (v3.0): ${alreadyOk}`);
console.log(`Não encontrados em data/images: ${notFound}`);

const withImg = db.prepare("SELECT COUNT(*) as n FROM recipes WHERE image_path IS NOT NULL AND image_path != ''").get().n;
const withoutImg = db.prepare("SELECT COUNT(*) as n FROM recipes WHERE image_path IS NULL OR image_path = ''").get().n;
console.log(`\nBanco após migração: ${withImg} com imagem, ${withoutImg} sem imagem`);

db.close();
console.log('\nMigracao concluida!');
