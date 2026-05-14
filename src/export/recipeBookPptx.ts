import fs from "node:fs";
import path from "node:path";
import PptxGenJSImport from "pptxgenjs";
// pptxgenjs has inconsistent exports across CJS/ESM loaders — unwrap double-default when present.
const pptxgen = ((PptxGenJSImport as any).default ?? PptxGenJSImport) as { new (): any };
type PptxInstance = InstanceType<typeof pptxgen>;
import type { PlannedRow, RecipeRecord, WeeklyPlan } from "../core/types.js";
import { chunkArray, resolveRuntimePath } from "../core/utils.js";
import { getImagesDir } from "../core/database.js";

// ── Slide geometry (10" × 7.5") ───────────────────────────────────────────────
const SW = 10; const SH = 7.5;
const M  = 0.11; const HEADER_H = 0.5; const FOOTER_H = 0.32;

// ── Brand palette — Companhia do Churrasco ────────────────────────────────────
const C_RED       = "C02927"; // Vermelho Brasa
const C_RED_DARK  = "8B0000"; // Dark red
const C_BAR_TEXT  = "FAF0E6"; // Off-white text on red bars
const C_BEIGE     = "E4C193"; // Bege Quente
const C_CREAM     = "F8F4EE"; // Off-white background
const C_AMBER     = "D4A868"; // Amber for meat/special rows
const C_BLACK     = "1A1A1A"; // Near-black text
const C_WHITE     = "FFFFFF";
const C_CARD_BDR  = "C02927"; // Card border

const DAY_LABELS  = ["SEG", "TER", "QUA", "QUI", "SEX", "SÁB", "DOM"] as const;

// ── Public API ────────────────────────────────────────────────────────────────

export async function writeRecipeBookPptx(filePath: string, plan: WeeklyPlan): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const prs = new pptxgen();
  prs.layout = "LAYOUT_WIDE";
  prs.defineLayout({ name: "LANDSCAPE_75", width: SW, height: SH });
  prs.layout = "LANDSCAPE_75";

  addCoverSlide(prs, plan.title);
  addPlanTableSlides(prs, plan);

  const seenNames = new Set<string>();
  const recipes = plan.rows
    .flatMap((row) => row.days)
    .filter((d): d is NonNullable<typeof d> => d !== null)
    .map((d) => d.recipe)
    .filter((r) => {
      const key = r.recipeName.trim().toUpperCase();
      if (seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    });
  for (const pair of chunkArray(recipes, 2)) addRecipeCardSlide(prs, pair);

  await prs.writeFile({ fileName: filePath });
}

// ── Cover slide ───────────────────────────────────────────────────────────────

function addCoverSlide(prs: any, planTitle: string): void {
  const slide = prs.addSlide();
  const divY  = 4.35;
  const bgW   = SW - 2 * M;
  const bgH   = SH - 2 * M;

  // Background off-white
  slide.addShape(prs.ShapeType.rect, { x: M, y: M, w: bgW, h: bgH, fill: { color: C_CREAM }, line: { color: C_RED, width: 1.5 } });

  // Upper decorative tile area
  addTilePattern(slide, prs, M, M, bgW, divY - M);

  // Divider line
  slide.addShape(prs.ShapeType.line, {
    x: M, y: divY, w: bgW, h: 0,
    line: { color: C_RED, width: 2.5, dashType: "solid" },
  });

  // Lower white panel
  slide.addShape(prs.ShapeType.rect, { x: M, y: divY, w: bgW, h: SH - divY - M, fill: { color: C_WHITE }, line: { color: "none" } });

  // Logo
  const logoPath = getBrandLogoPath();
  if (logoPath) slide.addImage({ path: logoPath, x: M + 0.25, y: divY + 0.18, w: 0.55, h: 0.55 });

  const titleX = M + 1.05;
  slide.addText("RECEITUÁRIO", { x: titleX, y: divY + 0.14, w: 5.5, h: 0.55, fontSize: 36, bold: true, color: C_RED, fontFace: "Helvetica" });
  slide.addText("COZINHA QUENTE", { x: titleX, y: divY + 0.72, w: 5.5, h: 0.35, fontSize: 22, bold: true, color: C_BLACK, fontFace: "Helvetica" });

  // Vertical divider before plan title
  const vDivX = M + 6.6;
  slide.addShape(prs.ShapeType.line, {
    x: vDivX, y: divY + 0.15, w: 0, h: SH - divY - M - 0.3,
    line: { color: C_RED, width: 1.5, dashType: "solid" },
  });

  const rtW = SW - M - vDivX - 0.15;
  slide.addText(planTitle, { x: vDivX + 0.18, y: divY + 0.32, w: rtW, h: SH - divY - M - 0.5, fontSize: 20, bold: true, color: C_RED, align: "center", fontFace: "Helvetica", wrap: true });
}

function addTilePattern(slide: any, prs: any, x: number, y: number, w: number, h: number): void {
  const sw2 = w / 2; const sh2 = h / 2;
  for (const [ox, oy] of [[0, 0], [sw2, 0], [0, sh2], [sw2, sh2]] as [number, number][]) {
    slide.addShape(prs.ShapeType.rect, {
      x: x + ox, y: y + oy, w: sw2, h: sh2,
      fill: { type: "none" }, line: { color: C_BEIGE, width: 0.4 },
    });
    slide.addShape(prs.ShapeType.ellipse, {
      x: x + ox + sw2 * 0.15, y: y + oy + sh2 * 0.15, w: sw2 * 0.7, h: sh2 * 0.7,
      fill: { type: "none" }, line: { color: C_BEIGE, width: 0.4 },
    });
  }
}

// ── Plan table slides ─────────────────────────────────────────────────────────

const PLAN_CONTENT_Y = M + HEADER_H + 0.05;
const PLAN_CONTENT_H = SH - M - HEADER_H - FOOTER_H - 0.05;
const COL_N   = 0.32; const COL_CAT = 1.05; const COL_DAY_W = (SW - 2 * M - COL_N - COL_CAT) / 7;
const ROW_H_TITLE = 0.29; const ROW_H_HDR = 0.28; const ROW_MIN_H = 0.28;

function addPlanTableSlides(prs: any, plan: WeeklyPlan): void {
  const rowHeights = plan.rows.map((row) => estimatePlanRowH(row));
  let slide         = prs.addSlide();
  let pageNum       = 2;
  addContentChrome(slide, prs, pageNum, plan.title);

  let y      = PLAN_CONTENT_Y;
  let prevSeq = -1;
  const tableHeaderFn = () => addPlanTableHeaders(slide, prs, y, plan.title);
  y = tableHeaderFn();

  for (let i = 0; i < plan.rows.length; i++) {
    const h   = rowHeights[i]!;
    const row = plan.rows[i]!;
    if (y + h > PLAN_CONTENT_Y + PLAN_CONTENT_H) {
      slide = prs.addSlide();
      pageNum++;
      addContentChrome(slide, prs, pageNum, plan.title);
      y       = PLAN_CONTENT_Y;
      prevSeq = -1;
      y       = addPlanTableHeaders(slide, prs, y, plan.title);
    }
    addPlanDataRow(slide, prs, row, y, h, row.sequence !== prevSeq);
    prevSeq = row.sequence;
    y += h;
  }
}

function addPlanTableHeaders(slide: any, prs: any, y: number, title: string): number {
  const tableW = SW - 2 * M;
  // Title row
  slide.addShape(prs.ShapeType.rect, { x: M, y, w: tableW, h: ROW_H_TITLE, fill: { color: C_BEIGE }, line: { color: "999999", width: 0.4 } });
  slide.addText(title, { x: M, y, w: tableW, h: ROW_H_TITLE, align: "center", valign: "middle", fontSize: 12, bold: true, color: C_BLACK, fontFace: "Helvetica" });
  y += ROW_H_TITLE;
  // Header row
  const headers = ["N", "PRATOS", ...DAY_LABELS];
  const colWs   = [COL_N, COL_CAT, ...Array<number>(7).fill(COL_DAY_W)];
  let cx = M;
  for (let c = 0; c < headers.length; c++) {
    const cw = colWs[c]!;
    slide.addShape(prs.ShapeType.rect, { x: cx, y, w: cw, h: ROW_H_HDR, fill: { color: C_RED }, line: { color: "777777", width: 0.3 } });
    slide.addText(headers[c]!, { x: cx, y, w: cw, h: ROW_H_HDR, align: "center", valign: "middle", fontSize: 7.5, bold: true, color: C_WHITE, fontFace: "Helvetica" });
    cx += cw;
  }
  y += ROW_H_HDR;
  return y;
}

function addPlanDataRow(slide: any, prs: any, row: PlannedRow, y: number, h: number, showSeq: boolean): void {
  const bdr = { color: "999999", width: 0.25 };
  slide.addShape(prs.ShapeType.rect, { x: M, y, w: COL_N, h, fill: { color: C_CREAM }, line: bdr });
  if (showSeq) slide.addText(String(row.sequence), { x: M, y, w: COL_N, h, align: "center", valign: "middle", fontSize: 7.5, bold: true, color: C_BLACK, fontFace: "Helvetica" });

  const catX = M + COL_N;
  const catBg = isPratosDoDia(row.categoryName) ? C_AMBER : C_BEIGE;
  slide.addShape(prs.ShapeType.rect, { x: catX, y, w: COL_CAT, h, fill: { color: catBg }, line: bdr });
  slide.addText(row.categoryName, { x: catX + 0.02, y, w: COL_CAT - 0.04, h, align: "center", valign: "middle", fontSize: 6.5, bold: true, color: C_BLACK, fontFace: "Helvetica", wrap: true });

  for (let d = 0; d < 7; d++) {
    const dx = M + COL_N + COL_CAT + d * COL_DAY_W;
    slide.addShape(prs.ShapeType.rect, { x: dx, y, w: COL_DAY_W, h, fill: { color: C_WHITE }, line: bdr });
    const day = row.days[d];
    if (day?.recipeName) {
      slide.addText(day.recipeName, { x: dx + 0.02, y, w: COL_DAY_W - 0.04, h, align: "center", valign: "middle", fontSize: 6, bold: false, color: C_BLACK, fontFace: "Helvetica", wrap: true });
    }
  }
}

function estimatePlanRowH(row: PlannedRow): number {
  const maxWords = Math.max(
    row.categoryName.split(/\s+/).length,
    ...row.days.map((d) => (d?.recipeName ?? "").split(/\s+/).length),
  );
  return Math.max(ROW_MIN_H, Math.ceil(maxWords / 4) * 0.19);
}

function isPratosDoDia(categoryName: string): boolean {
  const n = categoryName.toUpperCase();
  return n.includes("PRATOS DO DIA") || n.includes("PRATO DO DIA");
}

// ── Recipe card slide ─────────────────────────────────────────────────────────

function addRecipeCardSlide(prs: any, recipes: RecipeRecord[]): void {
  const slide = prs.addSlide();
  addContentChrome(slide, prs, 0, "");
  const contentY = M + HEADER_H + 0.05;
  const availH   = SH - M - HEADER_H - FOOTER_H - 0.05;
  const cardH    = (availH - 0.08) / 2;

  for (let i = 0; i < 2; i++) {
    const recipe = recipes[i];
    if (!recipe) break;
    drawRecipeCard(slide, prs, recipe, M, contentY + i * (cardH + 0.08), cardH);
  }
}

function drawRecipeCard(slide: any, prs: any, recipe: RecipeRecord, cx: number, cy: number, ch: number): void {
  const cardW    = SW - 2 * M;
  const HDR_H    = 0.26;
  const textPct  = 0.47;
  const textColW = cardW * textPct;
  const photoX   = cx + textColW + 0.05;
  const photoW   = cardW - textColW - 0.05;
  const bodyY    = cy + HDR_H + 0.06;
  const bodyH    = ch - HDR_H - 0.08;

  // Card border
  slide.addShape(prs.ShapeType.rect, { x: cx, y: cy, w: cardW, h: ch, fill: { type: "none" }, line: { color: C_CARD_BDR, width: 0.7 } });
  // Header
  slide.addShape(prs.ShapeType.rect, { x: cx, y: cy, w: cardW, h: HDR_H, fill: { color: C_RED }, line: { color: "none" } });

  const displayLabel = recipe.categoryLabel.replace(/ - /, " \u2013 ");
  slide.addText(displayLabel, {
    x: cx + 0.08, y: cy + 0.03, w: textColW - 0.12, h: HDR_H - 0.06,
    fontSize: 8, bold: true, color: C_BAR_TEXT, fontFace: "Helvetica", valign: "top",
  });
  slide.addText("FOTO", {
    x: photoX, y: cy + 0.03, w: photoW - 0.08, h: HDR_H - 0.06,
    fontSize: 8, bold: true, color: C_BAR_TEXT, fontFace: "Helvetica", valign: "top",
  });

  // Vertical divider
  slide.addShape(prs.ShapeType.line, { x: cx + textColW, y: cy, w: 0, h: ch, line: { color: C_CARD_BDR, width: 0.5, dashType: "solid" } });

  // Recipe name
  slide.addText(recipe.recipeName, {
    x: cx + 0.08, y: bodyY, w: textColW - 0.16, h: bodyH * 0.2,
    fontSize: 10, bold: true, color: C_RED, fontFace: "Helvetica", valign: "top", wrap: true,
  });

  // Ingredients
  if (recipe.ingredientsLines.length > 0) {
    slide.addText(recipe.ingredientsLines.join("\n"), {
      x: cx + 0.08, y: bodyY + bodyH * 0.22, w: textColW - 0.16, h: bodyH * 0.36,
      fontSize: 6.5, color: C_BLACK, fontFace: "Helvetica", valign: "top", wrap: true,
    });
  }

  // Mode of preparation
  if (recipe.preparationLines.length > 0) {
    slide.addText("MODO DE PREPARO", {
      x: cx + 0.08, y: bodyY + bodyH * 0.59, w: textColW - 0.16, h: 0.14,
      fontSize: 7, bold: true, color: C_BLACK, fontFace: "Helvetica", underline: true,
    });
    slide.addText(recipe.preparationLines.join(" "), {
      x: cx + 0.08, y: bodyY + bodyH * 0.74, w: textColW - 0.16, h: bodyH * 0.26,
      fontSize: 6.5, color: C_BLACK, fontFace: "Helvetica", valign: "top", wrap: true,
    });
  }

  // Photo
  const fullImgPath = recipe.imagePath ? path.join(getImagesDir(), recipe.imagePath) : null;
  if (fullImgPath && fs.existsSync(fullImgPath)) {
    slide.addImage({ path: fullImgPath, x: photoX + 0.04, y: cy + HDR_H + 0.04, w: photoW - 0.08, h: ch - HDR_H - 0.08, sizing: { type: "contain", w: photoW - 0.08, h: ch - HDR_H - 0.08 } });
  } else {
    slide.addText("Sem imagem", { x: photoX, y: cy + HDR_H + ch / 2 - 0.1, w: photoW - 0.08, h: 0.2, align: "center", fontSize: 7.5, color: "888888", fontFace: "Helvetica" });
  }
}

// ── Content chrome ────────────────────────────────────────────────────────────

function addContentChrome(slide: any, prs: any, pageNum: number, _title: string): void {
  const barW = SW - 2 * M;
  // Header bar
  slide.addShape(prs.ShapeType.rect, { x: M, y: M, w: barW, h: HEADER_H, fill: { color: C_RED }, line: { color: "none" } });
  slide.addShape(prs.ShapeType.rect, { x: M, y: M, w: barW, h: 0.03, fill: { color: C_RED_DARK }, line: { color: "none" } });

  const logoPath = getBrandLogoPath();
  if (logoPath) {
    const ls = HEADER_H - 0.09;
    slide.addImage({ path: logoPath, x: (SW - ls) / 2, y: M + 0.05, w: ls, h: ls });
  }
  slide.addText("BUFFET QUENTE", {
    x: SW - M - 2.3, y: M + 0.1, w: 2.2, h: HEADER_H - 0.2,
    fontSize: 13, bold: true, italic: true, color: C_BAR_TEXT, align: "right", fontFace: "Helvetica",
  });

  // Footer bar
  slide.addShape(prs.ShapeType.rect, { x: M, y: SH - M - FOOTER_H, w: barW, h: FOOTER_H, fill: { color: C_RED }, line: { color: "none" } });
  if (pageNum > 0) {
    slide.addText(String(pageNum), { x: SW - M - 0.35, y: SH - M - FOOTER_H - 0.18, w: 0.28, h: 0.18, fontSize: 7.5, color: C_BLACK, align: "right", fontFace: "Helvetica" });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getBrandLogoPath(): string | null {
  const candidate = resolveRuntimePath("assets", "logo.png");
  return fs.existsSync(candidate) ? candidate : null;
}
