import { Router } from "express";
import type { Request, Response } from "express";
import fs from "node:fs";
import multer from "multer";
import { openDatabase, upsertRecipes, getImagesDir } from "../core/database.js";
import { extractRecipesFromPdfs, ensureExtractionPaths } from "../core/extractor.js";
import { resolveRuntimePath } from "../core/utils.js";

export const extractRouter = Router();

const uploadsDir = resolveRuntimePath("data", "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf")) {
      cb(null, true);
    } else {
      cb(new Error("Apenas arquivos PDF são aceitos"));
    }
  },
});

// ── POST /api/extract — upload PDFs ──────────────────────────────────────────

extractRouter.post("/extract", upload.array("pdfs", 20), async (req: Request, res: Response) => {
  const files = req.files as Express.Multer.File[] | undefined;
  try {
    if (!files || files.length === 0) {
      res.status(400).json({ error: "Nenhum PDF enviado" });
      return;
    }

    const db = openDatabase();
    const imagesDir = getImagesDir();
    ensureExtractionPaths(imagesDir);

    const pdfPaths = files.map((f) => f.path);
    const startPage = Math.max(1, parseInt(req.body?.startPage ?? "1", 10) || 1);
    console.log(`[extract] ${files.length} files uploaded, startPage=${startPage}`);
    for (const f of files) console.log(`[extract]   file: ${f.originalname} -> ${f.path} (${f.size} bytes)`);

    const progressLog: string[] = [];
    const recipes = await extractRecipesFromPdfs({
      pdfPaths,
      imagesDir,
      startPage,
      onProgress: (msg) => {
        console.log("[extract]", msg);
        progressLog.push(msg);
      },
    });
    const stats = upsertRecipes(db, recipes);
    console.log(`[extract] Done: ${recipes.length} recipes found, ${stats.inserted} inserted, ${stats.updated} updated`);

    res.json({ success: true, stats, recipesFound: recipes.length });
  } catch (error: any) {
    console.error("[extract]", error);
    res.status(500).json({ error: error.message ?? "Erro interno na extração" });
  } finally {
    if (files) {
      for (const f of files) {
        try { fs.unlinkSync(f.path); } catch {}
      }
    }
  }
});

// ── POST /api/extract-paths — import from local file paths ────────────────────

extractRouter.post("/extract-paths", async (req: Request, res: Response) => {
  try {
    const { pdfPaths, startPage = 1 } = req.body as { pdfPaths: unknown; startPage?: unknown };
    if (!Array.isArray(pdfPaths) || pdfPaths.length === 0 || !pdfPaths.every((p) => typeof p === "string")) {
      res.status(400).json({ error: "pdfPaths deve ser um array de strings" });
      return;
    }

    const validStart = Math.max(1, parseInt(String(startPage), 10) || 1);

    for (const p of pdfPaths) {
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
        res.status(400).json({ error: `Arquivo não encontrado ou inválido: ${p}` });
        return;
      }
    }

    const db = openDatabase();
    const imagesDir = getImagesDir();
    ensureExtractionPaths(imagesDir);

    const recipes = await extractRecipesFromPdfs({
      pdfPaths: pdfPaths as string[],
      imagesDir,
      startPage: validStart,
      onProgress: (msg) => console.log("[extract-paths]", msg),
    });
    const stats = upsertRecipes(db, recipes);
    console.log(`[extract-paths] Done: ${recipes.length} recipes found`);

    res.json({ success: true, stats, recipesFound: recipes.length });
  } catch (error: any) {
    console.error("[extract-paths]", error);
    res.status(500).json({ error: error.message ?? "Erro interno na extração" });
  }
});
