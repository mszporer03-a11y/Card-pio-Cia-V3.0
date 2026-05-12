/**
 * Test full image extraction on PDF files.
 * Usage: node scripts/test-extract.mjs "file1.pdf" "file2.pdf" ...
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../.test-images");
fs.mkdirSync(outDir, { recursive: true });

const { extractRecipesFromPdfs } = await import("../dist/core/extractor.js");

const pdfPaths = process.argv.slice(2);
if (!pdfPaths.length) {
  console.error("Usage: node scripts/test-extract.mjs file1.pdf ...");
  process.exit(1);
}

console.log(`\nTesting extraction on ${pdfPaths.length} PDF(s)...`);
console.log(`Images output dir: ${outDir}\n`);

let totalRecipes = 0, withImage = 0, withoutImage = 0;

const recipes = await extractRecipesFromPdfs({
  pdfPaths,
  imagesDir: outDir,
  startPage: 1,
  onProgress: (msg) => process.stdout.write(`\r${msg.slice(0, 80).padEnd(80)}`),
});

console.log("\n");
console.log("─".repeat(80));
console.log(`Total recipes extracted: ${recipes.length}`);

for (const r of recipes) {
  totalRecipes++;
  if (r.imagePath) {
    withImage++;
    const fullPath = path.join(outDir, path.basename(r.imagePath));
    const exists = fs.existsSync(fullPath);
    if (!exists) console.log(`  ⚠ Image missing on disk: ${r.imagePath} (${r.recipeName})`);
  } else {
    withoutImage++;
  }
}

console.log(`  With image:    ${withImage}`);
console.log(`  Without image: ${withoutImage}`);

// Show first few recipes with and without images
const withImgSample = recipes.filter(r => r.imagePath).slice(0, 5);
const noImgSample = recipes.filter(r => !r.imagePath).slice(0, 5);

if (withImgSample.length) {
  console.log("\nSample recipes WITH images:");
  for (const r of withImgSample) console.log(`  ✅ ${r.recipeName} -> ${r.imagePath}`);
}
if (noImgSample.length) {
  console.log("\nSample recipes WITHOUT images:");
  for (const r of noImgSample) console.log(`  ❌ ${r.recipeName}`);
}

const imageFiles = fs.readdirSync(outDir).filter(f => f.endsWith(".png"));
console.log(`\nImage files saved to ${outDir}: ${imageFiles.length}`);
console.log("─".repeat(80));
