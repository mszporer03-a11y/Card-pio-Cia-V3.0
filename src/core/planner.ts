import type BetterSqlite3 from "better-sqlite3";
import { getCategories, getRecipesByCategory, getRecipeById } from "./database.js";
import { writeWeeklyPlanExcel } from "../export/excel.js";
import { writeRecipeBookPdf } from "../export/recipeBookPdf.js";
import { writeRecipeBookPptx } from "../export/recipeBookPptx.js";
import type { PlanSelection, PlannedDay, PlannedRow, RecipeRecord, WeeklyPlan, MandatoryRecipe } from "./types.js";
import { chunkArray, inferPlanTitleFromSelections, normalizeText, recipeSimilarity, sampleDiversified, sampleWithReplacement } from "./utils.js";

type GeneratePlanOptions = {
  database: BetterSqlite3.Database;
  selection: PlanSelection;
  excelPath: string;
  pdfPath: string;
  pptxPath: string;
  title?: string;
  consolidateSimilarCategories?: boolean;
  allowRepetition?: boolean;
  mandatoryRecipeIds?: number[];
};

type CategoryPool = {
  categoryLabel: string;
  categoryName: string;
  sourceLabels: string[];
  totalRecipes: number;
};

export async function generateWeeklyPlan(options: GeneratePlanOptions): Promise<WeeklyPlan> {
  const categoryPools = getPlanningCategoryPools(options.database, options.consolidateSimilarCategories ?? false);
  const categoryMap = new Map(categoryPools.map((category) => [normalizeText(category.categoryLabel), category]));

  const rows: PlannedRow[] = [];
  let sequence = 1;

  // Mandatory recipes appear every day
  if (options.mandatoryRecipeIds && options.mandatoryRecipeIds.length > 0) {
    for (const recipeId of options.mandatoryRecipeIds) {
      if (typeof recipeId !== "number" || !Number.isFinite(recipeId) || recipeId < 1) continue;
      const recipe = getRecipeById(options.database, recipeId);
      if (!recipe) {
        console.warn(`[planner] Receita obrigatória ID ${recipeId} não encontrada, ignorando`);
        continue;
      }
      const days: Array<PlannedDay | null> = Array.from({ length: 7 }, () => ({
        recipeId: recipe.id,
        recipeName: recipe.recipeName,
        recipe,
      }));
      rows.push({ sequence, categoryLabel: recipe.categoryLabel, categoryName: recipe.categoryName, sourceLabels: [recipe.categoryLabel], days });
      sequence += 1;
    }
  }

  const allSelectedNames: string[] = [];
  const SIMILARITY_THRESHOLD = 0.5;

  for (const [selectionKey, rawCount] of Object.entries(options.selection)) {
    const requestedCount = Math.floor(Number(rawCount));
    if (!Number.isFinite(requestedCount) || requestedCount <= 0) continue;

    const resolvedCategory = categoryMap.get(normalizeText(selectionKey));
    if (!resolvedCategory) {
      console.warn(`[planner] Categoria não encontrada: ${selectionKey}, ignorando`);
      continue;
    }

    const recipes = resolvedCategory.sourceLabels.flatMap((label) => getRecipesByCategory(options.database, label));
    if (recipes.length === 0) {
      console.warn(`[planner] Categoria ${resolvedCategory.categoryLabel} sem receitas, ignorando`);
      continue;
    }

    // Always draw from the full pool (all recipes in the category, with or without image).
    // requestedCount = how many recipe rows per day for this category.
    // Each row spans 7 days, so total slots to sample = requestedCount * 7.
    const pool = recipes;
    const totalSlots = requestedCount * 7;

    const filteredPool = pool.filter((r) => {
      for (const name of allSelectedNames) {
        if (recipeSimilarity(r.recipeName, name) >= SIMILARITY_THRESHOLD) return false;
      }
      return true;
    });
    const effectivePool = filteredPool.length >= requestedCount ? filteredPool : pool;

    let sampled: RecipeRecord[];
    if (options.allowRepetition) {
      sampled = sampleWithReplacement(effectivePool, totalSlots, Math.random);
    } else {
      if (totalSlots > effectivePool.length) {
        console.warn(`[planner] ${resolvedCategory.categoryLabel}: solicitados ${totalSlots} slots, disponíveis ${effectivePool.length}. Usando todas + repetindo.`);
        const allShuffled = sampleDiversified(effectivePool, effectivePool.length, (r) => r.recipeName, Math.random, SIMILARITY_THRESHOLD);
        const extra = sampleWithReplacement(effectivePool, totalSlots - effectivePool.length, Math.random);
        sampled = [...allShuffled, ...extra];
      } else {
        sampled = sampleDiversified(effectivePool, totalSlots, (r) => r.recipeName, Math.random, SIMILARITY_THRESHOLD);
      }
    }

    for (const r of sampled) allSelectedNames.push(r.recipeName);

    for (const [groupIdx, group] of chunkArray(sampled, 7).entries()) {
      const days: Array<PlannedDay | null> = Array.from({ length: 7 }, (_, index) => {
        const recipe = group[index] ?? sampled[(groupIdx * 7 + index) % sampled.length];
        if (!recipe) return null;
        return { recipeId: recipe.id, recipeName: recipe.recipeName, recipe };
      });
      rows.push({ sequence, categoryLabel: resolvedCategory.categoryLabel, categoryName: resolvedCategory.categoryName, sourceLabels: resolvedCategory.sourceLabels, days });
      sequence += 1;
    }
  }

  const orderedRecipes = rows.flatMap((row) => row.days).filter((day): day is PlannedDay => day !== null).map((day) => day.recipe);
  const plan: WeeklyPlan = {
    title: options.title ?? inferPlanTitleFromSelections(Object.keys(options.selection)),
    rows,
    recipes: orderedRecipes,
  };

  await writeWeeklyPlanExcel(options.excelPath, plan);
  await writeRecipeBookPdf(options.pdfPath, plan);
  await writeRecipeBookPptx(options.pptxPath, plan);
  return plan;
}

export function getPlanningCategories(database: BetterSqlite3.Database, consolidateSimilarCategories = false) {
  return getPlanningCategoryPools(database, consolidateSimilarCategories).map((category) => ({
    categoryLabel: category.categoryLabel,
    categoryName: category.categoryName,
    totalRecipes: category.totalRecipes,
  }));
}

function getPlanningCategoryPools(database: BetterSqlite3.Database, consolidateSimilarCategories: boolean): CategoryPool[] {
  const categories = getCategories(database);
  if (!consolidateSimilarCategories) {
    return categories.map((category) => ({
      categoryLabel: category.categoryLabel,
      categoryName: category.categoryName,
      sourceLabels: [category.categoryLabel],
      totalRecipes: category.totalRecipes,
    }));
  }

  // Flat global grouping — no code-based bucketing so cross-code duplicates are caught.
  const groups: CategoryPool[] = [];
  for (const category of categories) {
    const name = extractCategoryName(category.categoryLabel);
    const matchingGroup = groups.find((g) => shouldConsolidateCategoryNames(g.categoryName, name));
    if (matchingGroup) {
      matchingGroup.sourceLabels.push(category.categoryLabel);
      matchingGroup.totalRecipes += category.totalRecipes;
    } else {
      groups.push({
        categoryLabel: category.categoryLabel,
        categoryName: name,
        sourceLabels: [category.categoryLabel],
        totalRecipes: category.totalRecipes,
      });
    }
  }
  return groups;
}

function extractCategoryName(categoryLabel: string): string {
  const match = categoryLabel.match(/^[\d.]+\s*[-\u2013]\s*(.+)$/);
  return match ? match[1].trim() : categoryLabel.trim();
}

function shouldConsolidateCategoryNames(left: string, right: string): boolean {
  const nl = normalizeText(left);
  const nr = normalizeText(right);
  if (nl === nr) return true;
  // singular/plural (trailing S)
  if (nl + "S" === nr || nr + "S" === nl) return true;
  // one is a prefix of the other (word boundary)
  if (nl.startsWith(nr + " ") || nr.startsWith(nl + " ")) return true;
  // strip trailing number/letter suffix, then retry
  const strip = (s: string) => s.replace(/[\s/]+\d+$/, "").replace(/[\s/]+[A-Z]$/, "").trim();
  const bl = strip(nl);
  const br = strip(nr);
  if (bl === br && bl.length >= 4) return true;
  if ((bl + "S" === br || br + "S" === bl) && bl.length >= 4) return true;
  if (bl.startsWith(br + " ") || br.startsWith(bl + " ")) return true;
  return false;
}
