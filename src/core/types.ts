export type PageTextItem = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName: string;
};

export type PageLine = {
  text: string;
  x: number;
  y: number;
  maxHeight: number;
  fontName: string;
  items: PageTextItem[];
};

export type RecipeInput = {
  categoryCode: string;
  categoryName: string;
  categoryLabel: string;
  recipeName: string;
  ingredientsLines: string[];
  preparationLines: string[];
  imagePath: string | null;
  sourcePdf: string;
  sourcePage: number;
};

export type RecipeRecord = {
  id: number;
  categoryCode: string;
  categoryName: string;
  categoryLabel: string;
  recipeName: string;
  ingredientsLines: string[];
  preparationLines: string[];
  imagePath: string | null;
  sourcePdf: string;
  sourcePage: number;
};

export type CategorySummary = {
  categoryLabel: string;
  categoryName: string;
  totalRecipes: number;
};

export type PlanSelection = Record<string, number>;

export type PlannedDay = {
  recipeId: number;
  recipeName: string;
  recipe: RecipeRecord;
};

export type PlannedRow = {
  sequence: number;
  categoryLabel: string;
  categoryName: string;
  days: Array<PlannedDay | null>;
};

export type WeeklyPlan = {
  title: string;
  rows: PlannedRow[];
  recipes: RecipeRecord[];
};

export type UpsertStats = {
  inserted: number;
  updated: number;
  skipped: number;
  total: number;
};

export type RecipeUpdate = {
  recipeName?: string;
  categoryCode?: string;
  categoryName?: string;
  categoryLabel?: string;
  ingredientsLines?: string[];
  preparationLines?: string[];
  imagePath?: string | null;
};

export type MandatoryRecipe = {
  recipeId: number;
  recipeName: string;
  categoryLabel: string;
};
