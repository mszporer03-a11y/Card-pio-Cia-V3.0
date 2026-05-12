import { Router } from "express";
import type { Request, Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { openDatabase, getRecipeById } from "../core/database.js";
import { getPlanningCategories, generateWeeklyPlan } from "../core/planner.js";
import { writeWeeklyPlanExcel } from "../export/excel.js";
import { writeRecipeBookPdf } from "../export/recipeBookPdf.js";
import { writeRecipeBookPptx } from "../export/recipeBookPptx.js";
import { resolveRuntimePath } from "../core/utils.js";
import type { PlanSelection, PlannedDay, PlannedRow, WeeklyPlan } from "../core/types.js";

export const planRouter = Router();

const outputDir  = resolveRuntimePath("output");
const excelPath  = path.join(outputDir, "cardapio-semanal.xlsx");
const pdfPath    = path.join(outputDir, "livro-receitas.pdf");
const pptxPath   = path.join(outputDir, "livro-receitas.pptx");

// ── GET /api/categories ───────────────────────────────────────────────────────

planRouter.get("/categories", (req: Request, res: Response) => {
  try {
    const db          = openDatabase();
    const consolidate = req.query.consolidate === "true";
    const categories  = getPlanningCategories(db, consolidate);
    res.json(categories);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/plan ────────────────────────────────────────────────────────────

planRouter.post("/plan", async (req: Request, res: Response) => {
  try {
    const db   = openDatabase();
    const body = req.body ?? {};

    const selection: PlanSelection = typeof body.selection === "object" && body.selection !== null ? body.selection : {};
    const title          = typeof body.title === "string" && body.title.trim() ? body.title.trim() : undefined;
    const consolidate    = body.consolidate !== false;
    const allowRepetition = body.allowRepetition === true;
    const mandatoryRecipeIds = Array.isArray(body.mandatoryRecipeIds)
      ? (body.mandatoryRecipeIds as unknown[]).filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0)
      : [];

    const hasSelection = Object.values(selection).some((v) => typeof v === "number" && v > 0);
    if (!hasSelection && mandatoryRecipeIds.length === 0) {
      res.status(400).json({ error: "Selecione pelo menos uma categoria ou receita obrigatória" });
      return;
    }

    const plan = await generateWeeklyPlan({
      database: db,
      selection,
      excelPath,
      pdfPath,
      pptxPath,
      title,
      consolidateSimilarCategories: consolidate,
      allowRepetition,
      mandatoryRecipeIds,
    });

    res.json({
      success:      true,
      title:        plan.title,
      totalRows:    plan.rows.length,
      totalRecipes: plan.recipes.length,
      excelUrl:     "/output/cardapio-semanal.xlsx",
      pdfUrl:       "/output/livro-receitas.pdf",
      pptxUrl:      "/output/livro-receitas.pptx",
      plan: { title: plan.title, rows: plan.rows },
    });
  } catch (error: any) {
    console.error("[plan]", error);
    res.status(500).json({ error: error.message ?? "Erro ao gerar cardápio" });
  }
});

// ── POST /api/plan/export ─────────────────────────────────────────────────────
// Re-generates files from a client-edited plan (recipe IDs are re-hydrated from DB).

planRouter.post("/plan/export", async (req: Request, res: Response) => {
  try {
    const rawPlan = req.body?.plan;
    if (!rawPlan || !Array.isArray(rawPlan.rows) || typeof rawPlan.title !== "string") {
      res.status(400).json({ error: "Plano inválido" });
      return;
    }

    const db = openDatabase();

    // Re-hydrate recipe objects from DB so any edits made since generation are picked up.
    const rows: PlannedRow[] = (rawPlan.rows as any[]).map((row: any, i: number) => ({
      sequence:      typeof row.sequence === "number" ? row.sequence : i + 1,
      categoryLabel: String(row.categoryLabel ?? ""),
      categoryName:  String(row.categoryName ?? row.categoryLabel ?? ""),
      days: Array.isArray(row.days)
        ? (row.days as any[]).map((day): PlannedDay | null => {
            if (!day || typeof day.recipeId !== "number" || day.recipeId < 1) return null;
            const recipe = getRecipeById(db, day.recipeId);
            if (!recipe) return null;
            return { recipeId: recipe.id, recipeName: recipe.recipeName, recipe };
          })
        : (Array(7).fill(null) as null[]),
    }));

    const recipes = rows
      .flatMap((r) => r.days)
      .filter((d): d is PlannedDay => d !== null)
      .map((d) => d.recipe);

    const plan: WeeklyPlan = { title: String(rawPlan.title), rows, recipes };

    fs.mkdirSync(outputDir, { recursive: true });
    await writeWeeklyPlanExcel(excelPath, plan);
    await writeRecipeBookPdf(pdfPath, plan);
    await writeRecipeBookPptx(pptxPath, plan);

    res.json({
      success:  true,
      excelUrl: "/output/cardapio-semanal.xlsx",
      pdfUrl:   "/output/livro-receitas.pdf",
      pptxUrl:  "/output/livro-receitas.pptx",
    });
  } catch (error: any) {
    console.error("[plan/export]", error);
    res.status(500).json({ error: error.message ?? "Erro ao exportar cardápio" });
  }
});
