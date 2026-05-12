import fs from "node:fs";
import path from "node:path";
import { extractPageLines, extractRecipeImage, extractAllRecipeImages, openPdf } from "./pdf.js";
import type { ImageResult } from "./pdf.js";
import type { PageLine, RecipeInput } from "./types.js";
import { slugify } from "./utils.js";

type ExtractionOptions = {
  pdfPaths: string[];
  imagesDir: string;
  startPage: number;
  onProgress?: (msg: string) => void;
};

const SECTION_LABELS = new Set([
  "MODO DE PREPARO", "MODO DE PREPARO - PASTA", "RECHEIO", "RECHEIO:",
  "MOLHO", "MOLHO:", "COBERTURA", "COBERTURA:", "CREME", "CREME:",
  "PURE", "PURE:", "DECORACAO", "DECORACAO:", "FINALIZACAO:", "FINALIZACAO",
  "MONTAGEM", "MONTAGEM:", "MILANESA", "MILANESA:", "EMPANAMENTO TRADICIONAL:",
  "MASSA", "MASSA:", "SUGESTAO: PODE SUBSTITIR O SALMAO POR AGULHAO NEGRO",
  "FINALIZACAO/DECORACAO", "FINALIZACAO/DECORACAO:", "DECORACAO/FINALIZACAO",
  "DECORACAO/FINALIZACAO:", "FINALIZACAO / DECORACAO", "DECORACAO / FINALIZACAO",
  "DECORACAO (SUGESTIVA)", "DECORACAO - SUGESTIVA", "DECORACAO SUGESTIVA",
  "FINALIZACAO E DECORACAO", "FINALIZACAO E DECORACAO:",
]);

const SKIP_LABELS = new Set([
  "FINALIZACAO/DECORACAO", "FINALIZACAO/DECORACAO:", "DECORACAO/FINALIZACAO",
  "DECORACAO/FINALIZACAO:", "FINALIZACAO / DECORACAO", "DECORACAO / FINALIZACAO",
  "DECORACAO (SUGESTIVA)", "DECORACAO - SUGESTIVA", "DECORACAO SUGESTIVA",
  "FINALIZACAO E DECORACAO", "FINALIZACAO E DECORACAO:",
]);

const CONTAINER_SECTION_LABELS = new Set([
  "RECHEIO", "RECHEIO:", "MOLHO", "MOLHO:", "COBERTURA", "COBERTURA:",
  "CREME", "CREME:", "MASSA", "MASSA:", "MONTAGEM", "MONTAGEM:",
]);

// Plural / list-marker headers that introduce a list of recipe VARIANTS
// (e.g. "RECHEIOS:" before each pastel filling). Lines after these should be
// treated as separate recipes, not subsections of a single one.
const VARIANT_LIST_HEADERS = new Set([
  "RECHEIOS", "RECHEIOS:", "OPCOES", "OPCOES:", "OPCOES DE RECHEIO", "OPCOES DE RECHEIO:",
  "VARIACOES", "VARIACOES:", "SABORES", "SABORES:",
]);

const SUBSECTION_PREFIXES = [
  "MOLHO", "RECHEIO", "COBERTURA", "CREME", "MASSA", "DECORACAO", "EMPANAMENTO", "FINALIZACAO", "MONTAGEM",
];

export async function extractRecipesFromPdfs(options: ExtractionOptions): Promise<RecipeInput[]> {
  const recipes: RecipeInput[] = [];
  for (const pdfPath of options.pdfPaths) {
    try {
      options.onProgress?.(`Abrindo PDF: ${path.basename(pdfPath)}`);
      const pdf = await openPdf(pdfPath);
      if (!pdf || typeof pdf.numPages !== "number" || pdf.numPages < 1) {
        options.onProgress?.(`PDF vazio ou invalido: ${path.basename(pdfPath)}`);
        continue;
      }
      const numPages = pdf.numPages;
      await pdf.cleanup?.();
      const fromDocument = await extractRecipesFromPdf(pdfPath, numPages, options.imagesDir, options.startPage, options.onProgress);
      recipes.push(...fromDocument);
    } catch (pdfError) {
      const msg = pdfError instanceof Error ? pdfError.message : String(pdfError);
      console.error(`[extractor] Erro ao processar ${path.basename(pdfPath)}: ${msg}`);
      options.onProgress?.(`Erro ao processar ${path.basename(pdfPath)}: ${msg}`);
      // Continue with next PDF instead of failing the whole batch
    }
  }
  return recipes;
}

async function extractRecipesFromPdf(
  pdfPath: string, numPages: number, imagesDir: string, startPage: number, onProgress?: (msg: string) => void,
): Promise<RecipeInput[]> {
  // Two-pass extraction: pdfjs accumulates internal state when getOperatorList() is called
  // repeatedly on the same document, eventually preventing access to shared image objects.
  // Pass 1 (text only) is safe since getTextContent() doesn't accumulate operator state.
  // Pass 2 (images only) uses a fresh document to avoid state corruption.

  type PageInfo = {
    pageNumber: number;
    recipes: Array<Omit<RecipeInput, "imagePath" | "sourcePdf" | "sourcePage"> & { nameY: number }>;
    categoryLabel: string;
    imageCount: number; // 1 for single-recipe pages, N for multi-recipe pages
  };

  // ── Pass 1: Extract text and parse recipes ────────────────────────────────
  const pageInfos: PageInfo[] = [];
  {
    const pdf = await openPdf(pdfPath);
    for (let pageNumber = startPage; pageNumber <= numPages; pageNumber += 1) {
      try {
        const page = await pdf.getPage(pageNumber);
        const lines = (await extractPageLines(page)).filter((line) => !isIgnorableLine(line));
        const category = lines.find((line) => parseCategoryLine(line.text) !== null);
        const hasPreparation = lines.some((line) => {
          const normalized = normalize(line.text);
          return normalized === "MODO DE PREPARO" || normalized.startsWith("MODO DE PREPARO") ||
            normalized === "PREPARO" || normalized === "MODO PREPARO";
        });

        if (!category || !hasPreparation) continue;
        const parsedCategory = parseCategoryLine(category.text);
        if (!parsedCategory) continue;

        onProgress?.(`Pag. ${pageNumber}: ${parsedCategory.label}`);

        const pageRecipes = parseRecipesFromPage(lines, parsedCategory.code, parsedCategory.name, parsedCategory.label);
        if (pageRecipes.length > 0) {
          pageInfos.push({ pageNumber, recipes: pageRecipes, categoryLabel: parsedCategory.label, imageCount: pageRecipes.length });
        }
      } catch (pageError) {
        onProgress?.(`Pag. ${pageNumber} ignorada: ${pageError instanceof Error ? pageError.message : String(pageError)}`);
      }
    }
    try { await pdf.cleanup?.(); } catch {}
  }

  // ── Pass 2: Extract images with fresh PDF per page ─────────────────────────
  // Opening a fresh PDF document for each page avoids pdfjs internal state
  // accumulation from getOperatorList() calls that corrupts shared image objects.
  const imageResults = new Map<number, ImageResult[]>(); // pageNumber → image results with positions

  for (const info of pageInfos) {
    try {
      const pdf = await openPdf(pdfPath);
      const page = await pdf.getPage(info.pageNumber);

      if (info.imageCount <= 1) {
        const imageOutputPath = path.join(imagesDir, `${slugify(info.categoryLabel)}-p${info.pageNumber}.png`);
        const result = await extractRecipeImage(page, imageOutputPath);
        imageResults.set(info.pageNumber, result ? [result] : []);
      } else {
        const pathBase = path.join(imagesDir, `${slugify(info.categoryLabel)}-p${info.pageNumber}`);
        const results = await extractAllRecipeImages(page, pathBase, info.imageCount);
        imageResults.set(info.pageNumber, results);
      }

      try { await pdf.cleanup?.(); } catch {}
    } catch {
      imageResults.set(info.pageNumber, []);
    }
  }

  // ── Combine results (proximity matching for multi-recipe pages) ───────────
  const results: RecipeInput[] = [];
  for (const info of pageInfos) {
    const images = imageResults.get(info.pageNumber) ?? [];
    if (info.recipes.length <= 1) {
      for (const { nameY: _, ...recipe } of info.recipes) {
        results.push({ ...recipe, imagePath: images[0]?.path ? path.basename(images[0].path) : null, sourcePdf: pdfPath, sourcePage: info.pageNumber });
      }
    } else {
      // Match images to recipes by Y-position proximity (greedy 1:1 assignment)
      const assigned = new Map<number, string>(); // recipe index → image path
      const usedImages = new Set<number>();
      for (let imgIdx = 0; imgIdx < images.length; imgIdx++) {
        const img = images[imgIdx];
        let bestRecipeIdx = -1;
        let bestDist = Infinity;
        for (let recIdx = 0; recIdx < info.recipes.length; recIdx++) {
          if (assigned.has(recIdx)) continue;
          const dist = Math.abs(img.pdfY - info.recipes[recIdx].nameY);
          if (dist < bestDist) { bestDist = dist; bestRecipeIdx = recIdx; }
        }
        if (bestRecipeIdx >= 0) {
          assigned.set(bestRecipeIdx, img.path);
          usedImages.add(imgIdx);
        }
      }
      for (let i = 0; i < info.recipes.length; i++) {
        const { nameY: _, ...recipe } = info.recipes[i];
        results.push({ ...recipe, imagePath: assigned.get(i) ? path.basename(assigned.get(i)!) : null, sourcePdf: pdfPath, sourcePage: info.pageNumber });
      }
    }
  }

  return results;
}

function parseRecipesFromPage(
  lines: PageLine[], categoryCode: string, categoryName: string, categoryLabel: string,
): Array<Omit<RecipeInput, "imagePath" | "sourcePdf" | "sourcePage"> & { nameY: number }> {
  const bodyLines = lines.filter((line) => !parseCategoryLine(line.text));

  const columnStreams = splitColumnStreams(bodyLines);
  if (columnStreams.length > 1) {
    const all: Array<Omit<RecipeInput, "imagePath" | "sourcePdf" | "sourcePage"> & { nameY: number }> = [];
    for (const stream of columnStreams) {
      all.push(...parseSingleStream(stream, categoryCode, categoryName, categoryLabel));
    }
    return all;
  }
  return parseSingleStream(bodyLines, categoryCode, categoryName, categoryLabel);
}

function parseSingleStream(
  bodyLines: PageLine[], categoryCode: string, categoryName: string, categoryLabel: string,
): Array<Omit<RecipeInput, "imagePath" | "sourcePdf" | "sourcePage"> & { nameY: number }> {
  const bodyHeights = bodyLines.map((line) => line.maxHeight).sort((left, right) => left - right);
  const medianHeight = bodyHeights[Math.floor(bodyHeights.length / 2)] ?? 0;
  const dominantBodyFontName = getDominantFontName(bodyLines);

  const recipes: Array<Omit<RecipeInput, "imagePath" | "sourcePdf" | "sourcePage"> & { nameY: number }> = [];
  let current: { recipeName: string; nameY: number; ingredientsLines: string[]; preparationLines: string[]; inPreparation: boolean; } | undefined;
  let previousSignificantNormalizedText: string | undefined;
  // Once we see a "RECHEIOS:" / "SABORES:" header, the rest of the page lists
  // recipe variants — every heading-style line is a new recipe, never a subsection.
  let inVariantList = false;

  for (let index = 0; index < bodyLines.length; index += 1) {
    const line = bodyLines[index];
    const text = cleanupLine(line.text);
    const normalizedText = normalize(text);
    const embeddedRecipeTitle = extractEmbeddedRecipeTitle(text);
    const nextSignificantNormalizedText = findNextSignificantNormalizedText(bodyLines, index + 1);

    if (!text || normalizedText === "FOTO") continue;
    if (SKIP_LABELS.has(normalizedText)) { previousSignificantNormalizedText = normalizedText; continue; }
    if (VARIANT_LIST_HEADERS.has(normalizedText)) { inVariantList = true; previousSignificantNormalizedText = normalizedText; continue; }

    if (embeddedRecipeTitle) {
      if (current) {
        recipes.push({ categoryCode, categoryName, categoryLabel, recipeName: current.recipeName, nameY: current.nameY, ingredientsLines: current.ingredientsLines, preparationLines: current.preparationLines });
      }
      current = { recipeName: embeddedRecipeTitle, nameY: line.y, ingredientsLines: [], preparationLines: [], inPreparation: false };
      previousSignificantNormalizedText = normalize(embeddedRecipeTitle);
      continue;
    }

    if (isPreparationLabel(normalizedText)) {
      if (current) current.inPreparation = true;
      previousSignificantNormalizedText = normalizedText;
      continue;
    }

    if (isRecipeTitle(line, text, medianHeight, dominantBodyFontName, normalizedText, current, previousSignificantNormalizedText, nextSignificantNormalizedText, inVariantList)) {
      if (current) {
        recipes.push({ categoryCode, categoryName, categoryLabel, recipeName: current.recipeName, nameY: current.nameY, ingredientsLines: current.ingredientsLines, preparationLines: current.preparationLines });
      }
      current = { recipeName: text, nameY: line.y, ingredientsLines: [], preparationLines: [], inPreparation: false };
      previousSignificantNormalizedText = normalizedText;
      continue;
    }

    if (!current) { previousSignificantNormalizedText = normalizedText; continue; }
    if (current.inPreparation) { current.preparationLines.push(text); } else { current.ingredientsLines.push(text); }
    previousSignificantNormalizedText = normalizedText;
  }

  if (current) {
    recipes.push({ categoryCode, categoryName, categoryLabel, recipeName: current.recipeName, nameY: current.nameY, ingredientsLines: current.ingredientsLines, preparationLines: current.preparationLines });
  }

  const result = recipes.filter((r) => r.ingredientsLines.length > 0 && r.preparationLines.length > 0).filter((r) => !SKIP_LABELS.has(normalize(r.recipeName)));
  if (result.length === 0) return parseRecipesStructural(bodyLines, categoryCode, categoryName, categoryLabel);
  return result;
}

function parseRecipesStructural(
  bodyLines: PageLine[], categoryCode: string, categoryName: string, categoryLabel: string,
): Array<Omit<RecipeInput, "imagePath" | "sourcePdf" | "sourcePage"> & { nameY: number }> {
  const cleanLines: Array<{ text: string; normalized: string; y: number; }> = [];
  for (const bl of bodyLines) {
    const text = cleanupLine(bl.text);
    const normalized = normalize(text);
    if (!text || normalized === "FOTO") continue;
    cleanLines.push({ text, normalized, y: bl.y });
  }
  if (cleanLines.length < 3) return [];

  const yDeltas: number[] = [];
  for (let i = 1; i < cleanLines.length; i++) {
    const delta = Math.abs(cleanLines[i - 1].y - cleanLines[i].y);
    if (delta > 0) yDeltas.push(delta);
  }
  yDeltas.sort((a, b) => a - b);
  const medianDelta = yDeltas[Math.floor(yDeltas.length / 2)] ?? 12;
  const gapThreshold = medianDelta * 2.5;

  const recipes: Array<Omit<RecipeInput, "imagePath" | "sourcePdf" | "sourcePage"> & { nameY: number }> = [];
  let recipeTitle: string | undefined;
  let recipeTitleY = 0;
  let ingredientsLines: string[] = [];
  let preparationLines: string[] = [];
  let inPreparation = false;

  for (let clIdx = 0; clIdx < cleanLines.length; clIdx++) {
    const cl = cleanLines[clIdx];
    if (isPreparationLabel(cl.normalized) || SECTION_LABELS.has(cl.normalized)) {
      if (isPreparationLabel(cl.normalized)) inPreparation = true;
      continue;
    }
    if (clIdx > 0) {
      const delta = Math.abs(cleanLines[clIdx - 1].y - cl.y);
      if (delta > gapThreshold && inPreparation) {
        if (recipeTitle && ingredientsLines.length > 0 && preparationLines.length > 0) {
          recipes.push({ categoryCode, categoryName, categoryLabel, recipeName: recipeTitle, nameY: recipeTitleY, ingredientsLines, preparationLines });
        }
        recipeTitle = undefined; recipeTitleY = 0; ingredientsLines = []; preparationLines = []; inPreparation = false;
      }
    }
    if (inPreparation) { preparationLines.push(cl.text); }
    else if (!recipeTitle) { recipeTitle = cl.text; recipeTitleY = cl.y; }
    else { ingredientsLines.push(cl.text); }
  }

  if (recipeTitle && ingredientsLines.length > 0 && preparationLines.length > 0) {
    recipes.push({ categoryCode, categoryName, categoryLabel, recipeName: recipeTitle, nameY: recipeTitleY, ingredientsLines, preparationLines });
  }
  return recipes.filter((r) => !SKIP_LABELS.has(normalize(r.recipeName)));
}

function isRecipeTitle(
  line: PageLine, text: string, medianHeight: number, dominantBodyFontName: string | undefined,
  normalizedText: string,
  current: { recipeName: string; ingredientsLines: string[]; preparationLines: string[]; inPreparation: boolean; } | undefined,
  previousSignificantNormalizedText: string | undefined,
  nextSignificantNormalizedText: string | undefined,
  inVariantList: boolean,
): boolean {
  if (normalizedText.length < 3) return false;
  if (SECTION_LABELS.has(normalizedText)) return false;
  if (normalizedText.startsWith("BUFFET QUENTE")) return false;
  if (/^\d+$/.test(normalizedText)) return false;
  if (looksLikeIngredient(normalizedText)) return false;

  const hasTitlePresentation =
    line.maxHeight >= medianHeight * (current?.inPreparation ? 1.03 : 1.1)
    || isProminentRelativeToBody(line.fontName, dominantBodyFontName);

  if (!current) return hasTitlePresentation && !looksLikeSentence(text);
  if (current.inPreparation) {
    const wordCount = normalizedText.split(/\s+/).filter(Boolean).length;
    return hasTitlePresentation && !looksLikeSentence(text) && wordCount <= 6;
  }
  if (isLikelySubsectionHeading(text, normalizedText, previousSignificantNormalizedText, current.recipeName, current.ingredientsLines.length > 0, nextSignificantNormalizedText, inVariantList)) return false;
  return hasTitlePresentation;
}

function looksLikeIngredient(text: string): boolean {
  return /^(?:\d|\d+\/\d+|½|¼|¾|QB|Q B|Q\/B|Q-B|SUMO|SUCO|SAL |AZEITE|OBS|LEVE|BATA|MISTURE|REFOGUE|TEMPERE|COLOQUE|ACRESCENTE|NUMA )/.test(text)
    || /\bQB\b/.test(text) || /TEMPERO PADRAO/.test(text);
}

function isIgnorableLine(line: PageLine): boolean {
  const text = cleanupLine(line.text);
  if (!text) return true;
  if (/^\d+$/.test(text) && line.y < 120) return true;
  if (normalize(text).startsWith("BUFFET QUENTE")) return true;
  if (/^CARDAPIO\s+BUFFET/i.test(normalize(text))) return true;
  return false;
}

function parseCategoryLine(text: string): { code: string; name: string; label: string } | null {
  const match = text.match(/^((?:\d\s*)+(?:\.\d+)?)\s*[–-]\s*(.+)$/);
  if (!match) return null;
  const code = match[1].replace(/\s+/g, "").trim();
  const rawName = cleanupLine(match[2]).replace(/\bFO\s*T\s*O\b.*$/i, "").trim();
  const name = normalizeCategoryName(rawName);
  return { code, name, label: `${code} - ${name}` };
}

function normalizeCategoryName(value: string): string {
  let n = cleanupLine(value).replace(/[–—]/g, "-").replace(/\s*-\s*/g, " - ").replace(/\s*\/\s*/g, " / ").trim();
  const hadLineMarker = /\(\s*\d+\s*[ºª]\s+LINHA\s*\)+/iu.test(n);
  n = n.replace(/^\d+\s*[ºª]\s*/u, "").trim();
  n = n.replace(/\(\s*\d+\s*[ºª]\s+LINHA\s*\)+/giu, "").trim();
  if (hadLineMarker && n.includes(" - ")) n = n.split(" - ")[0].trim();
  if (/^EXTRAS\s+-\s+MOLHOS DIVERSOS\s*\/\s*PASTA DE ALHO$/iu.test(n)) n = "EXTRAS - MOLHOS DIVERSOS";
  return n.replace(/\s+/g, " ").replace(/[\s-]+$/u, "").trim();
}

function extractEmbeddedRecipeTitle(text: string): string | null {
  const match = cleanupLine(text).match(/^OBS\.?\s*:?(?:\s*RECEITA)?\s+(.+)$/iu);
  if (!match) return null;
  if (!normalize(text).includes("RECEITA")) return null;
  return cleanupLine(match[1]).replace(/^RECEITA\s+/iu, "").replace(/[:.]$/u, "").trim();
}

function isPreparationLabel(normalizedText: string): boolean {
  return normalizedText === "PREPARO" || normalizedText === "MODO PREPARO" || /^MODO DE PREPARO(?:\s|$|[^A-Z])/.test(normalizedText);
}

function isLikelySubsectionHeading(
  text: string, normalizedText: string, previousSignificantNormalizedText: string | undefined,
  currentRecipeName: string | undefined, hasCollectedIngredients: boolean, nextSignificantNormalizedText: string | undefined,
  inVariantList: boolean = false,
): boolean {
  if (SECTION_LABELS.has(normalizedText)) return true;
  if (previousSignificantNormalizedText && CONTAINER_SECTION_LABELS.has(previousSignificantNormalizedText)) return false;
  // Following a "RECHEIOS:" / "SABORES:" header, the next heading-style lines are
  // recipe variants (e.g. each pastel filling), not subsections of one recipe.
  if (previousSignificantNormalizedText && VARIANT_LIST_HEADERS.has(previousSignificantNormalizedText)) return false;
  if (inVariantList) {
    for (const prefix of SUBSECTION_PREFIXES) {
      if (normalizedText.startsWith(`${prefix}:`) || normalizedText.startsWith(`${prefix} :`)) return true;
    }
    return false;
  }

  // Inline labeled subsection like "EMPANAMENTO: FARINHA - OVOS - FARINHA DE ROSCA"
  // — a section keyword followed by colon and a list of items on one line.
  for (const prefix of SUBSECTION_PREFIXES) {
    if (normalizedText.startsWith(`${prefix}:`) || normalizedText.startsWith(`${prefix} :`)) return true;
  }

  const wordCount = normalizedText.replace(/[:/-]/g, " ").split(/\s+/).filter(Boolean).length;
  if (wordCount === 0) return false;
  if (currentRecipeName && wordCount <= 6 && normalize(currentRecipeName).includes(normalizedText) && nextSignificantNormalizedText && looksLikeIngredient(nextSignificantNormalizedText)) return true;
  if (hasCollectedIngredients && wordCount <= 6 && nextSignificantNormalizedText && looksLikeIngredient(nextSignificantNormalizedText) && SUBSECTION_PREFIXES.some((prefix) => normalizedText === prefix || normalizedText.startsWith(`${prefix} `))) return true;

  // Heading-style line appearing during ingredient collection (between the recipe
  // title and its MODO DE PREPARO) is almost always a sub-component header
  // ("MANTEIGA DE PARMESÃO E ALHO", "MOLHO CREMOSO DE ERVAS", "FINALIZAÇÃO"), not
  // a brand-new recipe — a real new recipe only appears after the previous recipe's
  // preparation block (handled by the in-preparation branch in isRecipeTitle).
  // We require an ingredient-like next line to avoid swallowing the very first
  // title on a page when its first ingredient has slipped above it.
  if (currentRecipeName && hasCollectedIngredients && nextSignificantNormalizedText && looksLikeIngredient(nextSignificantNormalizedText)) return true;

  return text.endsWith(":") || wordCount === 1;
}

function looksLikeSentence(text: string): boolean {
  const wordCount = cleanupLine(text).split(/\s+/).filter(Boolean).length;
  return /[.!?]$/u.test(text) || (/,/.test(text) && wordCount > 7);
}

function cleanupLine(text: string): string {
  return text.replace(/\s+/g, " ").replace(/FOT O/g, "FOTO").trim();
}

function normalize(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim().toUpperCase();
}

function findNextSignificantNormalizedText(lines: PageLine[], startIndex: number): string | undefined {
  for (let index = startIndex; index < lines.length; index += 1) {
    const n = normalize(cleanupLine(lines[index]?.text ?? ""));
    if (n && n !== "FOTO") return n;
  }
  return undefined;
}

function getDominantFontName(lines: PageLine[]): string | undefined {
  // pdfjs assigns font ranks (e.g. "g_d0_f3") dynamically per document load,
  // so the same font can have different numbers depending on processing order.
  // We use the font NAME as identity instead — it's stable within a single page
  // extraction (which is all we need for prominence comparison).
  const frequencies = new Map<string, number>();
  for (const line of lines) {
    if (!line.fontName) continue;
    frequencies.set(line.fontName, (frequencies.get(line.fontName) ?? 0) + 1);
  }
  return [...frequencies.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
}

function isProminentRelativeToBody(fontName: string, dominantBodyFontName: string | undefined): boolean {
  if (!fontName || !dominantBodyFontName) return false;
  return fontName !== dominantBodyFontName;
}

// Detect 2-column body layout. If the page has consistent left/right text columns
// (titles and ingredients flowing in parallel), parse each column as its own stream
// so the parser doesn't interleave content from both sides.
function splitColumnStreams(bodyLines: PageLine[]): PageLine[][] {
  if (bodyLines.length < 6) return [bodyLines];

  // Bucket lines by Y (1pt rounding) and look for rows where two distinct lines
  // share the same Y with a wide horizontal gap — that's the column signature.
  const yBuckets = new Map<number, PageLine[]>();
  for (const line of bodyLines) {
    const key = Math.round(line.y);
    if (!yBuckets.has(key)) yBuckets.set(key, []);
    yBuckets.get(key)!.push(line);
  }

  let twoColRows = 0;
  const splitCandidates: number[] = [];
  for (const linesAtY of yBuckets.values()) {
    if (linesAtY.length < 2) continue;
    const sorted = [...linesAtY].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i++) {
      const leftEnd = sorted[i - 1].x + estimateLineWidth(sorted[i - 1]);
      const rightStart = sorted[i].x;
      if (rightStart - leftEnd > 60) {
        twoColRows++;
        splitCandidates.push((leftEnd + rightStart) / 2);
        break;
      }
    }
  }

  if (twoColRows < 3) return [bodyLines];

  splitCandidates.sort((a, b) => a - b);
  const splitX = splitCandidates[Math.floor(splitCandidates.length / 2)];

  const left: PageLine[] = [];
  const right: PageLine[] = [];
  for (const line of bodyLines) {
    if (line.x < splitX) left.push(line);
    else right.push(line);
  }
  if (left.length < 3 || right.length < 3) return [bodyLines];
  return [left, right];
}

function estimateLineWidth(line: PageLine): number {
  if (!line.items || line.items.length === 0) return 0;
  let maxRight = line.x;
  for (const item of line.items) {
    const right = item.x + (item.width ?? 0);
    if (right > maxRight) maxRight = right;
  }
  return maxRight - line.x;
}

export function ensureExtractionPaths(imagesDir: string): void {
  fs.mkdirSync(imagesDir, { recursive: true });
}
