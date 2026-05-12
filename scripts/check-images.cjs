const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database('data/recipes.sqlite');
const total = db.prepare('SELECT COUNT(*) as n FROM recipes').get().n;
const withImg = db.prepare("SELECT COUNT(*) as n FROM recipes WHERE image_path IS NOT NULL AND image_path != ''").get().n;
const withoutImg = db.prepare("SELECT COUNT(*) as n FROM recipes WHERE image_path IS NULL OR image_path = ''").get().n;
const sample = db.prepare("SELECT id, recipe_name, image_path FROM recipes WHERE image_path IS NOT NULL AND image_path != '' LIMIT 5").all();
const sampleNull = db.prepare("SELECT id, recipe_name, image_path FROM recipes WHERE image_path IS NULL OR image_path = '' LIMIT 5").all();

console.log('=== BANCO DE DADOS ===');
console.log('Total de receitas:', total);
console.log('Com image_path:', withImg);
console.log('Sem image_path:', withoutImg);
console.log('\nAmostras COM image_path:', JSON.stringify(sample, null, 2));
console.log('\nAmostras SEM image_path:', JSON.stringify(sampleNull, null, 2));

// Check if image files actually exist on disk
console.log('\n=== ARQUIVOS EM DISCO ===');
const imgDir = path.join('data', 'images');
if (fs.existsSync(imgDir)) {
  const files = fs.readdirSync(imgDir);
  console.log('Imagens em data/images:', files.length);
  console.log('Primeiras 5:', files.slice(0, 5));
} else {
  console.log('Pasta data/images NAO existe!');
}

const uploadsDir = path.join('data', 'uploads');
if (fs.existsSync(uploadsDir)) {
  const files = fs.readdirSync(uploadsDir);
  console.log('Imagens em data/uploads:', files.length);
} else {
  console.log('Pasta data/uploads nao existe.');
}

// Verify image paths point to existing files
if (sample.length > 0) {
  console.log('\n=== VERIFICACAO DE CAMINHOS ===');
  for (const r of sample) {
    const imgPath = r.image_path;
    const fullPath = path.join('data', 'images', path.basename(imgPath || ''));
    const exists = imgPath && fs.existsSync(imgPath);
    const existsBasename = imgPath && fs.existsSync(fullPath);
    console.log(`"${r.recipe_name}" => image_path="${imgPath}" | existe(direto)=${exists} | existe(basename)=${existsBasename}`);
  }
}

db.close();
