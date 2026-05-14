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
      rows.push({ sequence, categoryLabel: recipe.categoryLabel, categoryName: recipe.categoryName, days });
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
      rows.push({ sequence, categoryLabel: resolvedCategory.categoryLabel, categoryName: resolvedCategory.categoryName, days });
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

  const groupsByCode = new Map<string, CategoryPool[]>();
  for (const category of categories) {
    const { code, name } = splitCategoryLabel(category.categoryLabel);
    const codeGroups = groupsByCode.get(code) ?? [];
    const matchingGroup = codeGroups.find((group) => shouldConsolidateCategoryNames(group.categoryName, name));
    if (matchingGroup) {
      matchingGroup.sourceLabels.push(category.categoryLabel);
      matchingGroup.totalRecipes += category.totalRecipes;
    } else {
      codeGroups.push({
        categoryLabel: `${code} - ${name}`,
        categoryName: name,
        sourceLabels: [category.categoryLabel],
        totalRecipes: category.totalRecipes,
      });
      codeGroups.sort((left, right) => normalizeText(left.categoryName).length - normalizeText(right.categoryName).length);
    }
    groupsByCode.set(code, codeGroups);
  }
  return [...groupsByCode.values()].flat();
}

function splitCategoryLabel(categoryLabel: string): { code: string; name: string } {
  const match = categoryLabel.match(/^(\d+(?:\.\d+)?)\s*-\s*(.+)$/);
  if (!match) return { code: categoryLabel, name: categoryLabel };
  return { code: match[1], name: match[2] };
}

function shouldConsolidateCategoryNames(left: string, right: string): boolean {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);
  if (normalizedLeft === normalizedRight) return true;
  if (normalizedLeft.startsWith(`${normalizedRight} `) || normalizedRight.startsWith(`${normalizedLeft} `)) return true;
  const stripSuffix = (s: string) => s.replace(/[\s/]+\d+$/, "").replace(/[\s/]+[A-Z]$/, "").trim();
  const baseLeft = stripSuffix(normalizedLeft);
  const baseRight = stripSuffix(normalizedRight);
  if (baseLeft === baseRight && baseLeft.length >= 4) return true;
  if (baseLeft.startsWith(`${baseRight} `) || baseRight.startsWith(`${baseLeft} `)) return true;
  return false;
}
