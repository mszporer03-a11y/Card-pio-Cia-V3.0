import { Router } from "express";
import type { Request, Response } from "express";
import path from "node:path";
import fs from "node:fs";
import multer from "multer";
import {
  openDatabase,
  getRecipeById,
  getRecipesByCategory,
  listStoredRecipes,
  searchRecipes,
  updateRecipe,
  deleteRecipe,
  getImagesDir,
} from "../core/database.js";
import type { RecipeUpdate } from "../core/types.js";

export const recipesRouter = Router();

const ALLOWED_IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

function parseId(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : null;
}

const imgUpload = multer({
  dest: getImagesDir(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_IMG_EXT.has(ext)) cb(null, true);
    else cb(new Error("Tipo de imagem não suportado"));
  },
});

// ── GET /api/recipes — list or search ────────────────────────────────────────

recipesRouter.get("/recipes", (req: Request, res: Response) => {
  try {
    const db       = openDatabase();
    const query    = req.query.q as string | undefined;
    const category = req.query.category as string | undefined;
    let recipes;
    if (query)         recipes = searchRecipes(db, query);
    else if (category) recipes = getRecipesByCategory(db, category);
    else               recipes = listStoredRecipes(db);
    res.json(recipes);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/recipes/count — count ────────────────────────────────────────────

recipesRouter.get("/recipes/count", (_req: Request, res: Response) => {
  try {
    const db  = openDatabase();
    const row = db.prepare("SELECT COUNT(*) as total FROM recipes").get() as { total: number } | undefined;
    res.json({ total: row?.total ?? 0 });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/recipes/:id ──────────────────────────────────────────────────────

recipesRouter.get("/recipes/:id", (req: Request, res: Response) => {
  try {
    const id = parseId(req.params.id);
    if (!id) { res.status(400).json({ error: "ID inválido" }); return; }
    const db     = openDatabase();
    const recipe = getRecipeById(db, id);
    if (!recipe) { res.status(404).json({ error: "Receita não encontrada" }); return; }
    res.json(recipe);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/recipes — create ────────────────────────────────────────────────

recipesRouter.post("/recipes", (req: Request, res: Response) => {
  try {
    const b = req.body;
    if (!b || typeof b.recipeName !== "string" || !b.recipeName.trim()) {
      res.status(400).json({ error: "Nome da receita é obrigatório" });
      return;
    }

    const recipeName     = b.recipeName.trim();
    const categoryLabel  = (typeof b.categoryLabel === "string" && b.categoryLabel.trim()) ? b.categoryLabel.trim() : "Sem categoria";
    const parts          = categoryLabel.match(/^([\d.]+)\s*-\s*(.+)$/);
    const categoryCode   = parts ? parts[1] : categoryLabel;
    const categoryName   = parts ? parts[2]!.trim() : categoryLabel;
    const ingredientsLines = Array.isArray(b.ingredientsLines) ? b.ingredientsLines.filter((l: unknown) => typeof l === "string") : [];
    const preparationLines = Array.isArray(b.preparationLines) ? b.preparationLines.filter((l: unknown) => typeof l === "string") : [];

    const db = openDatabase();
    const info = db.prepare(`
      INSERT INTO recipes (
        category_code, category_name, category_label, recipe_name,
        ingredients_text, preparation_text, image_path, source_pdf, source_page, updated_at
      ) VALUES (
        @categoryCode, @categoryName, @categoryLabel, @recipeName,
        @ingredientsText, @preparationText, @imagePath, @sourcePdf, @sourcePage, CURRENT_TIMESTAMP
      )
    `).run({
      categoryCode,
      categoryName,
      categoryLabel,
      recipeName,
      ingredientsText: ingredientsLines.join("\n"),
      preparationText: preparationLines.join("\n"),
      imagePath: null,
      sourcePdf: "",
      sourcePage: 0,
    });

    const newId  = Number(info.lastInsertRowid || 0);
    const created = getRecipeById(db, newId);
    res.json(created);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── PUT /api/recipes/:id — update ─────────────────────────────────────────────

recipesRouter.put("/recipes/:id", (req: Request, res: Response) => {
  try {
    const id = parseId(req.params.id);
    if (!id) { res.status(400).json({ error: "ID inválido" }); return; }
    const db       = openDatabase();
    const existing = getRecipeById(db, id);
    if (!existing) { res.status(404).json({ error: "Receita não encontrada" }); return; }

    const updates: RecipeUpdate = {};
    const b = req.body;
    if (typeof b.recipeName === "string" && b.recipeName.trim())    updates.recipeName = b.recipeName.trim();
    if (typeof b.categoryCode === "string")                          updates.categoryCode = b.categoryCode.trim();
    if (typeof b.categoryName === "string")                          updates.categoryName = b.categoryName.trim();
    if (typeof b.categoryLabel === "string")                         updates.categoryLabel = b.categoryLabel.trim();
    if (Array.isArray(b.ingredientsLines))                           updates.ingredientsLines = b.ingredientsLines.filter((l: unknown) => typeof l === "string");
    if (Array.isArray(b.preparationLines))                           updates.preparationLines = b.preparationLines.filter((l: unknown) => typeof l === "string");

    updateRecipe(db, id, updates);
    const updated = getRecipeById(db, id);
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── DELETE /api/recipes/:id ───────────────────────────────────────────────────

recipesRouter.delete("/recipes/:id", (req: Request, res: Response) => {
  try {
    const id = parseId(req.params.id);
    if (!id) { res.status(400).json({ error: "ID inválido" }); return; }
    const db       = openDatabase();
    const existing = getRecipeById(db, id);
    if (!existing) { res.status(404).json({ error: "Receita não encontrada" }); return; }
    deleteRecipe(db, id);
    if (existing.imagePath) {
      try { fs.unlinkSync(path.join(getImagesDir(), path.basename(existing.imagePath))); } catch {}
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/recipes/:id/image — upload image ────────────────────────────────

recipesRouter.post("/recipes/:id/image", imgUpload.single("image"), (req: Request, res: Response) => {
  try {
    const id = parseId(req.params.id);
    if (!id) { res.status(400).json({ error: "ID inválido" }); return; }
    const db       = openDatabase();
    const existing = getRecipeById(db, id);
    if (!existing) { res.status(404).json({ error: "Receita não encontrada" }); return; }
    const file = req.file;
    if (!file) { res.status(400).json({ error: "Nenhuma imagem enviada" }); return; }

    const ext     = path.extname(file.originalname).toLowerCase() || ".png";
    const safeName = `recipe-${id}-${Date.now()}${ext}`;
    const newPath  = path.join(getImagesDir(), safeName);
    fs.renameSync(file.path, newPath);

    if (existing.imagePath) {
      const oldFull = path.join(getImagesDir(), path.basename(existing.imagePath));
      if (oldFull !== newPath) { try { fs.unlinkSync(oldFull); } catch {} }
    }

    updateRecipe(db, id, { imagePath: safeName });
    res.json({ success: true, imagePath: safeName });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/recipe-image/:id — serve image ───────────────────────────────────

recipesRouter.get("/recipe-image/:id", (req: Request, res: Response) => {
  try {
    const id = parseId(req.params.id);
    if (!id) { res.status(400).json({ error: "ID inválido" }); return; }
    const db     = openDatabase();
    const recipe = getRecipeById(db, id);
    if (!recipe || !recipe.imagePath) { res.status(404).json({ error: "Imagem não encontrada" }); return; }

    // Always resolve via imagesDir + basename — safe against path traversal and portable across machines
    const basename = path.basename(recipe.imagePath);
    if (!basename || basename.includes("..")) {
      res.status(403).json({ error: "Acesso negado" }); return;
    }
    const resolved = path.join(path.resolve(getImagesDir()), basename);
    if (!fs.existsSync(resolved)) { res.status(404).json({ error: "Arquivo de imagem não encontrado" }); return; }

    const ext  = path.extname(resolved).toLowerCase().replace(".", "");
    const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" } as Record<string, string>)[ext] ?? "application/octet-stream";
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(resolved);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
