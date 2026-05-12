import fs from "node:fs";
import path from "node:path";
import type { CategorySummary, RecipeInput, RecipeRecord, RecipeUpdate, UpsertStats } from "./types.js";
import { normalizeText, resolveRuntimePath } from "./utils.js";
import BetterSqlite3 from "better-sqlite3";

let _db: BetterSqlite3.Database | null = null;

export function getDbPath(): string {
  return resolveRuntimePath("data", "recipes.sqlite");
}

export function getImagesDir(): string {
  return resolveRuntimePath("data", "images");
}

export function openDatabase(databasePath?: string): BetterSqlite3.Database {
  const dbPath = databasePath ?? getDbPath();
  if (_db) {
    try { _db.prepare("SELECT 1").get(); return _db; } catch { _db = null; }
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const database = new BetterSqlite3(dbPath);
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_code TEXT NOT NULL,
      category_name TEXT NOT NULL,
      category_label TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      ingredients_text TEXT NOT NULL,
      preparation_text TEXT NOT NULL,
      image_path TEXT,
      source_pdf TEXT NOT NULL,
      source_page INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(category_label, recipe_name)
    );
    CREATE INDEX IF NOT EXISTS idx_recipes_category ON recipes(category_label);
    CREATE INDEX IF NOT EXISTS idx_recipes_code ON recipes(category_code);
    CREATE INDEX IF NOT EXISTS idx_recipes_name ON recipes(recipe_name);
  `);
  _db = database;
  return database;
}

export function closeDatabase(): void {
  if (_db) {
    try { _db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
    try { _db.close(); } catch {}
    _db = null;
  }
}

export function upsertRecipes(database: BetterSqlite3.Database, recipes: RecipeInput[]): UpsertStats {
  type ExistingRow = {
    id: number;
    category_code: string;
    category_label: string;
    recipe_name: string;
    ingredients_text: string;
    preparation_text: string;
    image_path: string | null;
  };

  const allExisting = database
    .prepare(`SELECT id, category_code, category_label, recipe_name, ingredients_text, preparation_text, image_path FROM recipes`)
    .all() as ExistingRow[];

  const byExact = new Map<string, ExistingRow>();
  const byCodeAndNorm = new Map<string, ExistingRow>();
  const byContent = new Map<string, ExistingRow>();

  for (const row of allExisting) {
    byExact.set(`${row.category_label}\0${row.recipe_name}`, row);
    const codeNormKey = `${row.category_code}\0${normalizeText(row.recipe_name)}`;
    if (!byCodeAndNorm.has(codeNormKey)) byCodeAndNorm.set(codeNormKey, row);
    const ck = contentFingerprint(row.ingredients_text, row.preparation_text);
    if (!byContent.has(ck)) byContent.set(ck, row);
  }

  const insertStatement = database.prepare(`
    INSERT OR IGNORE INTO recipes (
      category_code, category_name, category_label, recipe_name,
      ingredients_text, preparation_text, image_path, source_pdf, source_page, updated_at
    ) VALUES (
      @categoryCode, @categoryName, @categoryLabel, @recipeName,
      @ingredientsText, @preparationText, @imagePath, @sourcePdf, @sourcePage, CURRENT_TIMESTAMP
    )
  `);

  const updateByKeyStatement = database.prepare(`
    UPDATE recipes SET
      category_code = @categoryCode,
      category_name = @categoryName,
      ingredients_text = @ingredientsText,
      preparation_text = @preparationText,
      image_path = @imagePath,
      source_pdf = @sourcePdf,
      source_page = @sourcePage,
      updated_at = CURRENT_TIMESTAMP
    WHERE category_label = @categoryLabel AND recipe_name = @recipeName
  `);

  const updateByIdStatement = database.prepare(`
    UPDATE recipes SET
      category_code = @categoryCode,
      category_name = @categoryName,
      category_label = @categoryLabel,
      recipe_name = @recipeName,
      ingredients_text = @ingredientsText,
      preparation_text = @preparationText,
      image_path = @imagePath,
      source_pdf = @sourcePdf,
      source_page = @sourcePage,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `);

  const stats: UpsertStats = { inserted: 0, updated: 0, skipped: 0, total: 0 };

  const transaction = database.transaction((entries: RecipeInput[]) => {
    for (const recipe of entries) {
      const ingredientsText = recipe.ingredientsLines.join("\n");
      const preparationText = recipe.preparationLines.join("\n");
      const incomingContent = contentFingerprint(ingredientsText, preparationText);

      const exactKey = `${recipe.categoryLabel}\0${recipe.recipeName}`;
      const exactMatch = byExact.get(exactKey);
      if (exactMatch) {
        const sameContent = exactMatch.ingredients_text === ingredientsText && exactMatch.preparation_text === preparationText;
        if (sameContent && !shouldUpdateImage(exactMatch.image_path, recipe.imagePath ?? null)) {
          stats.skipped++;
        } else {
          const imagePath = pickBestImage(exactMatch.image_path, recipe.imagePath ?? null);
          updateByKeyStatement.run({ ...recipe, ingredientsText, preparationText, imagePath });
          exactMatch.ingredients_text = ingredientsText;
          exactMatch.preparation_text = preparationText;
          exactMatch.image_path = imagePath;
          if (sameContent) stats.skipped++; else stats.updated++;
        }
        continue;
      }

      const codeNormKey = `${recipe.categoryCode}\0${normalizeText(recipe.recipeName)}`;
      const codeMatch = byCodeAndNorm.get(codeNormKey);
      if (codeMatch) {
        const sameContent = codeMatch.ingredients_text === ingredientsText && codeMatch.preparation_text === preparationText;
        const sameMeta = codeMatch.category_label === recipe.categoryLabel && codeMatch.recipe_name === recipe.recipeName;
        if (sameContent && sameMeta && !shouldUpdateImage(codeMatch.image_path, recipe.imagePath ?? null)) {
          stats.skipped++;
        } else {
          const imagePath = pickBestImage(codeMatch.image_path, recipe.imagePath ?? null);
          updateByIdStatement.run({ ...recipe, ingredientsText, preparationText, imagePath, id: codeMatch.id });
          byExact.delete(`${codeMatch.category_label}\0${codeMatch.recipe_name}`);
          codeMatch.category_label = recipe.categoryLabel;
          codeMatch.recipe_name = recipe.recipeName;
          codeMatch.ingredients_text = ingredientsText;
          codeMatch.preparation_text = preparationText;
          codeMatch.image_path = imagePath;
          byExact.set(exactKey, codeMatch);
          if (sameContent && sameMeta) stats.skipped++; else stats.updated++;
        }
        continue;
      }

      const contentMatch = byContent.get(incomingContent);
      if (contentMatch) {
        if (shouldUpdateImage(contentMatch.image_path, recipe.imagePath ?? null)) {
          const imagePath = recipe.imagePath ?? null;
          updateByIdStatement.run({
            ...recipe,
            categoryCode: contentMatch.category_code,
            categoryLabel: contentMatch.category_label,
            recipeName: contentMatch.recipe_name,
            ingredientsText: contentMatch.ingredients_text,
            preparationText: contentMatch.preparation_text,
            imagePath,
            id: contentMatch.id,
          });
          contentMatch.image_path = imagePath;
          stats.updated++;
        } else {
          stats.skipped++;
        }
        continue;
      }

      insertStatement.run({ ...recipe, ingredientsText, preparationText, imagePath: recipe.imagePath ?? null });
      const newRow: ExistingRow = {
        id: -1,
        category_code: recipe.categoryCode,
        category_label: recipe.categoryLabel,
        recipe_name: recipe.recipeName,
        ingredients_text: ingredientsText,
        preparation_text: preparationText,
        image_path: recipe.imagePath ?? null,
      };
      byExact.set(exactKey, newRow);
      byCodeAndNorm.set(codeNormKey, newRow);
      byContent.set(incomingContent, newRow);
      stats.inserted++;
    }
  });

  transaction(recipes);
  stats.total = stats.inserted + stats.updated;
  return stats;
}

function contentFingerprint(ingredients: string, preparation: string): string {
  const norm = (s: string) => normalizeText(s).replace(/\s+/g, " ").trim();
  return `${norm(ingredients)}\0${norm(preparation)}`;
}

function shouldUpdateImage(stored: string | null, incoming: string | null): boolean {
  return incoming !== null && incoming !== stored;
}

function pickBestImage(stored: string | null, incoming: string | null): string | null {
  if (incoming !== null) return incoming;
  return stored;
}

export function updateRecipe(database: BetterSqlite3.Database, id: number, updates: RecipeUpdate): void {
  const setClauses: string[] = [];
  const params: Record<string, unknown> = { id };

  if (updates.recipeName !== undefined) { setClauses.push("recipe_name = @recipeName"); params.recipeName = updates.recipeName; }
  if (updates.categoryCode !== undefined) { setClauses.push("category_code = @categoryCode"); params.categoryCode = updates.categoryCode; }
  if (updates.categoryName !== undefined) { setClauses.push("category_name = @categoryName"); params.categoryName = updates.categoryName; }
  if (updates.categoryLabel !== undefined) { setClauses.push("category_label = @categoryLabel"); params.categoryLabel = updates.categoryLabel; }
  if (updates.ingredientsLines !== undefined) { setClauses.push("ingredients_text = @ingredientsText"); params.ingredientsText = updates.ingredientsLines.join("\n"); }
  if (updates.preparationLines !== undefined) { setClauses.push("preparation_text = @preparationText"); params.preparationText = updates.preparationLines.join("\n"); }
  if (updates.imagePath !== undefined) { setClauses.push("image_path = @imagePath"); params.imagePath = updates.imagePath; }

  if (setClauses.length === 0) return;
  setClauses.push("updated_at = CURRENT_TIMESTAMP");
  database.prepare(`UPDATE recipes SET ${setClauses.join(", ")} WHERE id = @id`).run(params);
}

export function deleteRecipe(database: BetterSqlite3.Database, id: number): void {
  database.prepare("DELETE FROM recipes WHERE id = @id").run({ id });
}

export function getCategories(database: BetterSqlite3.Database): CategorySummary[] {
  return database
    .prepare(`
      SELECT category_label as categoryLabel, category_name as categoryName, COUNT(*) as totalRecipes
      FROM recipes GROUP BY category_label, category_name
      ORDER BY category_code, category_name
    `)
    .all() as CategorySummary[];
}

export function getRecipesByCategory(database: BetterSqlite3.Database, categoryLabel: string): RecipeRecord[] {
  return database
    .prepare(`
      SELECT id, category_code as categoryCode, category_name as categoryName,
        category_label as categoryLabel, recipe_name as recipeName,
        ingredients_text as ingredientsText, preparation_text as preparationText,
        image_path as imagePath, source_pdf as sourcePdf, source_page as sourcePage
      FROM recipes WHERE category_label = ? ORDER BY recipe_name
    `)
    .all(categoryLabel)
    .map((row: any) => ({
      ...row,
      ingredientsLines: String(row.ingredientsText).split("\n").filter(Boolean),
      preparationLines: String(row.preparationText).split("\n").filter(Boolean),
    })) as RecipeRecord[];
}

export function getRecipeById(database: BetterSqlite3.Database, id: number): RecipeRecord | null {
  const row = database
    .prepare(`
      SELECT id, category_code as categoryCode, category_name as categoryName,
        category_label as categoryLabel, recipe_name as recipeName,
        ingredients_text as ingredientsText, preparation_text as preparationText,
        image_path as imagePath, source_pdf as sourcePdf, source_page as sourcePage
      FROM recipes WHERE id = ?
    `)
    .get(id) as any;
  if (!row) return null;
  return {
    ...row,
    ingredientsLines: String(row.ingredientsText).split("\n").filter(Boolean),
    preparationLines: String(row.preparationText).split("\n").filter(Boolean),
  } as RecipeRecord;
}

export function listStoredRecipes(database: BetterSqlite3.Database): RecipeRecord[] {
  return database
    .prepare(`
      SELECT id, category_code as categoryCode, category_name as categoryName,
        category_label as categoryLabel, recipe_name as recipeName,
        ingredients_text as ingredientsText, preparation_text as preparationText,
        image_path as imagePath, source_pdf as sourcePdf, source_page as sourcePage
      FROM recipes ORDER BY category_code, category_name, recipe_name
    `)
    .all()
    .map((row: any) => ({
      ...row,
      ingredientsLines: String(row.ingredientsText).split("\n").filter(Boolean),
      preparationLines: String(row.preparationText).split("\n").filter(Boolean),
    })) as RecipeRecord[];
}

export function searchRecipes(database: BetterSqlite3.Database, query: string): RecipeRecord[] {
  const pattern = `%${query}%`;
  return database
    .prepare(`
      SELECT id, category_code as categoryCode, category_name as categoryName,
        category_label as categoryLabel, recipe_name as recipeName,
        ingredients_text as ingredientsText, preparation_text as preparationText,
        image_path as imagePath, source_pdf as sourcePdf, source_page as sourcePage
      FROM recipes
      WHERE recipe_name LIKE @pattern OR category_name LIKE @pattern OR ingredients_text LIKE @pattern
      ORDER BY category_code, category_name, recipe_name
    `)
    .all({ pattern })
    .map((row: any) => ({
      ...row,
      ingredientsLines: String(row.ingredientsText).split("\n").filter(Boolean),
      preparationLines: String(row.preparationText).split("\n").filter(Boolean),
    })) as RecipeRecord[];
}
