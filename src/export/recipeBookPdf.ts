import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import type { PlannedDay, PlannedRow, RecipeRecord, WeeklyPlan } from "../core/types.js";
import { chunkArray, resolveRuntimePath } from "../core/utils.js";
import { getImagesDir } from "../core/database.js";

// ── Page geometry ─────────────────────────────────────────────────────────────
const PW = 720; const PH = 540; const M = 8;
const HEADER_H = 38; const FOOTER_H = 26;
const CONTENT_Y = M + HEADER_H + 3;
const CONTENT_B = PH - M - FOOTER_H - 3;

// ── Brand palette — Companhia do Churrasco ────────────────────────────────────
// Vermelho Brasa · Bege Quente · Off-white · Black
const C_RED       = "#C02927"; // Vermelho Brasa — bars, borders, accents
const C_RED_DARK  = "#8B0000"; // Dark band on bar top
const C_RED_LIGHT = "#E04040"; // Light band on bar bottom
const C_BAR_TEXT  = "#FAF0E6"; // Off-white text on red bars
const C_BEIGE     = "#E4C193"; // Bege Quente — table title, category cells
const C_CREAM     = "#F8F4EE"; // Off-white background
const C_AMBER     = "#D4A868"; // Amber — meat/special category highlight
const C_BLACK     = "#1A1A1A"; // Near-black text
const C_CARD_BDR  = "#C02927"; // Card borders

// ── Table geometry ────────────────────────────────────────────────────────────
const TBL_X = M; const TBL_W = PW - 2 * M;
const COL_N = 27; const COL_CAT = 90;
const COL_DAY     = (TBL_W - COL_N - COL_CAT) / 7;
const TBL_TITLE_H = 22; const TBL_HEADER_H = 22; const TBL_ROW_PAD = 4;
const FS_TITLE = 11; const FS_HEADER = 9; const FS_SEQ = 9; const FS_CAT = 8; const FS_DAY = 7;

// ── Recipe card geometry ──────────────────────────────────────────────────────
const CARD_GAP    = 8;
const CARD_H      = Math.floor((CONTENT_B - CONTENT_Y - CARD_GAP) / 2);
const CARD_HDR_H  = 18;
const TEXT_COL_W  = Math.floor(TBL_W * 0.47);
const DIVIDER_X   = M + TEXT_COL_W;

const DAY_LABELS = ["SEGUNDA", "TERÇA", "QUARTA", "QUINTA", "SEXTA", "SÁBADO", "DOMINGO"] as const;

// ── Public API ────────────────────────────────────────────────────────────────

export async function writeRecipeBookPdf(filePath: string, plan: WeeklyPlan): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const doc    = new PDFDocument({ size: [PW, PH], margin: 0, autoFirstPage: false });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    let pageNum = 0;

    doc.addPage(); pageNum++;
    drawCoverPage(doc, plan.title);

    pageNum = drawPlanTableSection(doc, plan, pageNum);

    const seenIds = new Set<number>();
    const recipes = plan.rows
      .flatMap((row) => row.days)
      .filter((d): d is PlannedDay => d !== null)
      .map((d) => d.recipe)
      .filter((r) => { if (seenIds.has(r.id)) return false; seenIds.add(r.id); return true; });

    for (const pair of chunkArray(recipes, 2)) {
      doc.addPage(); pageNum++;
      drawContentChrome(doc, pageNum);
      drawRecipeCardPage(doc, pair);
    }

    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

// ── Cover page ────────────────────────────────────────────────────────────────

function drawCoverPage(doc: PDFKit.PDFDocument, planTitle: string): void {
  const divY = Math.round(PH * 0.58);

  // Upper area — off-white with tile pattern
  doc.rect(M, M, PW - 2 * M, divY - M).fill(C_CREAM);
  drawTilePattern(doc, M + 1, M + 1, PW - 2 * M - 2, divY - M - 1);

  // Horizontal divider
  doc.lineWidth(2.5).strokeColor(C_RED).moveTo(M, divY).lineTo(PW - M, divY).stroke();

  // Lower area — white
  doc.rect(M + 1, divY + 1, PW - 2 * M - 2, PH - divY - M - 1).fill("#FFFFFF");

  // Border
  doc.lineWidth(2).strokeColor(C_RED).rect(M, M, PW - 2 * M, PH - 2 * M).stroke();

  // Logo
  const logoPath = getBrandLogoPath();
  if (logoPath) doc.image(logoPath, M + 18, divY + 16, { fit: [40, 40] });

  const textX = M + 78;
  doc.font("Helvetica-Bold").fontSize(30).fillColor(C_RED).text("RECEITUÁRIO", textX, divY + 20, { lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(19).fillColor(C_BLACK).text("COZINHA QUENTE", textX, divY + 58, { lineBreak: false });

  // Vertical divider
  const vDivX = Math.round(PW * 0.67);
  doc.lineWidth(1.5).strokeColor(C_RED).moveTo(vDivX, divY + 12).lineTo(vDivX, PH - M - 12).stroke();

  // Plan title
  const rtX = vDivX + 14; const rtW = PW - M - rtX - 12;
  doc.font("Helvetica-Bold").fontSize(17).fillColor(C_RED).text(planTitle, rtX, divY + 26, { width: rtW, align: "center" });
}

function drawTilePattern(doc: PDFKit.PDFDocument, x: number, y: number, w: number, h: number): void {
  const gs = 28; const cr = 11; const ir = 3.5; const ld = 4;
  doc.save().rect(x, y, w, h).clip();
  doc.lineWidth(0.5).strokeColor(C_BEIGE);
  const cols = Math.ceil(w / gs) + 2;
  const rows = Math.ceil(h / gs) + 2;
  for (let row = -1; row <= rows; row++) {
    for (let col = -1; col <= cols; col++) {
      const cx = x + col * gs; const cy = y + row * gs;
      doc.circle(cx, cy, cr).stroke();
      doc.circle(cx, cy, ir).stroke();
      const lx1 = cx + cr; const lx2 = cx + gs - cr;
      if (lx2 > lx1) {
        const mid = (lx1 + lx2) / 2;
        doc.moveTo(lx1, cy).bezierCurveTo(mid - gs * 0.1, cy - ld, mid + gs * 0.1, cy - ld, lx2, cy).stroke();
        doc.moveTo(lx1, cy).bezierCurveTo(mid - gs * 0.1, cy + ld, mid + gs * 0.1, cy + ld, lx2, cy).stroke();
      }
      const ly1 = cy + cr; const ly2 = cy + gs - cr;
      if (ly2 > ly1) {
        const mid = (ly1 + ly2) / 2;
        doc.moveTo(cx, ly1).bezierCurveTo(cx - ld, mid - gs * 0.1, cx - ld, mid + gs * 0.1, cx, ly2).stroke();
        doc.moveTo(cx, ly1).bezierCurveTo(cx + ld, mid - gs * 0.1, cx + ld, mid + gs * 0.1, cx, ly2).stroke();
      }
    }
  }
  doc.restore();
}

// ── Content chrome (header + footer) ─────────────────────────────────────────

function drawContentChrome(doc: PDFKit.PDFDocument, pageNum: number): void {
  drawBar(doc, M, M, PW - 2 * M, HEADER_H);
  drawBar(doc, M, PH - M - FOOTER_H, PW - 2 * M, FOOTER_H);

  const logoPath = getBrandLogoPath();
  if (logoPath) {
    const lSize = HEADER_H - 8;
    doc.image(logoPath, (PW - lSize) / 2, M + 4, { fit: [lSize, lSize] });
  }

  doc.font("Helvetica-BoldOblique").fontSize(14).fillColor(C_BAR_TEXT)
    .text("BUFFET QUENTE", PW - M - 176, M + 11, { width: 168, align: "right", lineBreak: false });

  doc.font("Helvetica").fontSize(9).fillColor("#000000")
    .text(String(pageNum), PW - M - 26, PH - M - FOOTER_H - 14, { width: 20, align: "right", lineBreak: false });
}

function drawBar(doc: PDFKit.PDFDocument, x: number, y: number, w: number, h: number): void {
  doc.rect(x, y, w, h).fill(C_RED);
  doc.rect(x, y, w, 3).fill(C_RED_DARK);
  doc.rect(x, y + h - 3, w, 3).fill(C_RED_LIGHT);
  doc.save().lineWidth(0.3).strokeColor(C_RED_DARK).opacity(0.35);
  for (let i = 1; i < 3; i++) {
    const ly = y + Math.round(h * i / 3);
    doc.moveTo(x, ly).lineTo(x + w, ly).stroke();
  }
  doc.restore();
}

// ── Plan table ────────────────────────────────────────────────────────────────

function drawPlanTableSection(doc: PDFKit.PDFDocument, plan: WeeklyPlan, pageNum: number): number {
  const rowHeights = plan.rows.map((row) => calcPlanRowHeight(doc, row));
  doc.addPage(); pageNum++;
  drawContentChrome(doc, pageNum);
  let y = CONTENT_Y;
  const tableStartY = y;
  y = drawTableTitleAndHeaders(doc, plan.title, y);
  let prevSeq = -1;

  for (let i = 0; i < plan.rows.length; i++) {
    const h   = rowHeights[i]!;
    const row = plan.rows[i]!;
    if (y + h > CONTENT_B) {
      doc.lineWidth(1.2).strokeColor(C_RED).rect(TBL_X, tableStartY, TBL_W, y - tableStartY).stroke();
      doc.addPage(); pageNum++;
      drawContentChrome(doc, pageNum);
      y = CONTENT_Y;
      y = drawTableTitleAndHeaders(doc, plan.title, y);
    }
    const showSeq = row.sequence !== prevSeq;
    prevSeq = row.sequence;
    drawTableDataRow(doc, row, y, h, showSeq);
    y += h;
  }

  doc.lineWidth(1.2).strokeColor(C_RED).rect(TBL_X, tableStartY, TBL_W, y - tableStartY).stroke();
  return pageNum;
}

function drawTableTitleAndHeaders(doc: PDFKit.PDFDocument, title: string, y: number): number {
  // Title row — warm beige
  doc.rect(TBL_X, y, TBL_W, TBL_TITLE_H).lineWidth(0.4).fillAndStroke(C_BEIGE, "#999999");
  doc.font("Helvetica-Bold").fontSize(FS_TITLE).fillColor(C_BLACK);
  const titleH = doc.heightOfString(title, { width: TBL_W - 8, lineGap: 0 });
  doc.text(title, TBL_X + 4, y + (TBL_TITLE_H - titleH) / 2, { width: TBL_W - 8, align: "center", lineBreak: true });
  y += TBL_TITLE_H;

  // Header row — red brasa with white text
  const headerLabels = ["N", "PRATOS", ...DAY_LABELS];
  const colWidths    = [COL_N, COL_CAT, ...Array<number>(7).fill(COL_DAY)];
  let cx = TBL_X;
  for (let c = 0; c < headerLabels.length; c++) {
    const cw = colWidths[c]!;
    doc.rect(cx, y, cw, TBL_HEADER_H).lineWidth(0.4).fillAndStroke(C_RED, "#777777");
    doc.font("Helvetica-Bold").fontSize(FS_HEADER).fillColor("#FFFFFF");
    const lh = doc.heightOfString(headerLabels[c]!, { width: cw - 4, lineGap: 0 });
    doc.text(headerLabels[c]!, cx + 2, y + (TBL_HEADER_H - lh) / 2, { width: cw - 4, align: "center", lineBreak: false });
    cx += cw;
  }
  y += TBL_HEADER_H;
  return y;
}

function calcPlanRowHeight(doc: PDFKit.PDFDocument, row: PlannedRow): number {
  doc.font("Helvetica-Bold").fontSize(FS_CAT);
  const catH = doc.heightOfString(row.categoryName, { width: COL_CAT - 6, lineGap: 0.5 });
  doc.font("Helvetica").fontSize(FS_DAY);
  let maxDayH = 8;
  for (const day of row.days) {
    if (!day?.recipeName) continue;
    const dh = doc.heightOfString(day.recipeName, { width: COL_DAY - 4, lineGap: 0.5 });
    if (dh > maxDayH) maxDayH = dh;
  }
  return Math.max(22, Math.max(catH, maxDayH) + TBL_ROW_PAD * 2);
}

function drawTableDataRow(doc: PDFKit.PDFDocument, row: PlannedRow, y: number, h: number, showSeq: boolean): void {
  const border = "#888888"; const bw = 0.3;

  // Sequence column
  doc.rect(TBL_X, y, COL_N, h).lineWidth(bw).fillAndStroke("#FFFFFF", border);
  if (showSeq) {
    doc.font("Helvetica-Bold").fontSize(FS_SEQ).fillColor(C_BLACK);
    const sh = doc.heightOfString(String(row.sequence), { width: COL_N - 4 });
    doc.text(String(row.sequence), TBL_X, y + (h - sh) / 2, { width: COL_N, align: "center", lineBreak: false });
  }

  // Category column — beige or amber for meat rows
  const catBg = isPratosDoDia(row.categoryName) ? C_AMBER : C_BEIGE;
  const catX  = TBL_X + COL_N;
  doc.rect(catX, y, COL_CAT, h).lineWidth(bw).fillAndStroke(catBg, border);
  doc.font("Helvetica-Bold").fontSize(FS_CAT).fillColor(C_BLACK);
  const catTh = doc.heightOfString(row.categoryName, { width: COL_CAT - 6, lineGap: 0.5 });
  doc.text(row.categoryName, catX + 3, y + (h - catTh) / 2, { width: COL_CAT - 6, align: "center", lineGap: 0.5 });

  // Day columns
  for (let d = 0; d < 7; d++) {
    const dx = TBL_X + COL_N + COL_CAT + d * COL_DAY;
    doc.rect(dx, y, COL_DAY, h).lineWidth(bw).fillAndStroke("#FFFFFF", border);
    const day = row.days[d];
    if (day?.recipeName) {
      doc.font("Helvetica").fontSize(FS_DAY).fillColor(C_BLACK);
      const dayTh = doc.heightOfString(day.recipeName, { width: COL_DAY - 4, lineGap: 0.5 });
      doc.text(day.recipeName, dx + 2, y + (h - dayTh) / 2, { width: COL_DAY - 4, align: "center", lineGap: 0.5 });
    }
  }

  doc.lineWidth(0.5).strokeColor(C_RED).moveTo(TBL_X, y + h).lineTo(TBL_X + TBL_W, y + h).stroke();
}

function isPratosDoDia(categoryName: string): boolean {
  const n = categoryName.toUpperCase();
  return n.includes("PRATOS DO DIA") || n.includes("PRATO DO DIA");
}

// ── Recipe card pages ─────────────────────────────────────────────────────────

function drawRecipeCardPage(doc: PDFKit.PDFDocument, recipes: RecipeRecord[]): void {
  const card1Y = CONTENT_Y;
  const card2Y = CONTENT_Y + CARD_H + CARD_GAP;
  if (recipes[0]) drawRecipeCard(doc, recipes[0], card1Y);
  if (recipes[1]) drawRecipeCard(doc, recipes[1], card2Y);
}

function drawRecipeCard(doc: PDFKit.PDFDocument, recipe: RecipeRecord, cardY: number): void {
  const cardX = M; const cardW = TBL_W;
  const textX = cardX + 6; const textW = TEXT_COL_W - 12;
  const textContentY = cardY + CARD_HDR_H + 5;
  const textContentH = CARD_H - CARD_HDR_H - 10;

  // Card border
  doc.lineWidth(0.7).strokeColor(C_CARD_BDR).rect(cardX, cardY, cardW, CARD_H).stroke();

  // Header background — red brasa
  doc.rect(cardX, cardY, cardW, CARD_HDR_H).fill(C_RED);
  doc.lineWidth(0.5).strokeColor(C_RED).moveTo(cardX, cardY + CARD_HDR_H).lineTo(cardX + cardW, cardY + CARD_HDR_H).stroke();
  doc.lineWidth(0.5).strokeColor(C_CARD_BDR).moveTo(DIVIDER_X, cardY).lineTo(DIVIDER_X, cardY + CARD_H).stroke();

  // Header text
  const displayLabel = recipe.categoryLabel.replace(/ - /, " \u2013 ");
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#FFFFFF")
    .text(displayLabel, textX, cardY + 4, { width: textW, lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#FFFFFF")
    .text("FOTO", DIVIDER_X + 6, cardY + 4, { width: TBL_W - TEXT_COL_W - 12, lineBreak: false });

  const ingredients  = recipe.ingredientsLines.join("\n");
  const preparation  = recipe.preparationLines.join(" ");
  const layout       = computeCardLayout(doc, recipe.recipeName, ingredients, preparation, textW, textContentH);

  // Clip text to card area
  doc.save();
  doc.rect(textX - 1, textContentY, textW + 2, textContentH).clip();

  let ty = textContentY;

  // Recipe name
  doc.font("Helvetica-Bold").fontSize(layout.nameSize).fillColor(C_RED);
  const nameH = doc.heightOfString(recipe.recipeName, { width: textW, lineGap: 0.5 });
  doc.text(recipe.recipeName, textX, ty, { width: textW, lineGap: 0.5, height: textContentH });
  ty += nameH + 4;

  // Ingredients
  const remaining1 = textContentH - (ty - textContentY);
  if (remaining1 > 0) {
    doc.font("Helvetica").fontSize(layout.bodySize).fillColor(C_BLACK);
    const ingH = doc.heightOfString(ingredients, { width: textW, lineGap: 0.8 });
    doc.text(ingredients, textX, ty, { width: textW, lineGap: 0.8, height: remaining1 });
    ty += Math.min(ingH, remaining1) + 5;
  }

  // Mode of preparation
  const remaining2 = textContentH - (ty - textContentY);
  if (remaining2 > 12) {
    doc.font("Helvetica-Bold").fontSize(layout.bodySize + 0.5).fillColor(C_BLACK);
    const modeH = doc.heightOfString("MODO DE PREPARO", { width: textW });
    doc.text("MODO DE PREPARO", textX, ty, { width: textW, underline: true, lineBreak: false });
    ty += modeH + 4;

    const remaining3 = textContentH - (ty - textContentY);
    if (remaining3 > 0) {
      doc.font("Helvetica").fontSize(layout.bodySize).fillColor(C_BLACK)
        .text(preparation, textX, ty, { width: textW, lineGap: 0.8, align: "left", height: remaining3 });
    }
  }

  doc.restore();

  // Photo area
  const photoX = DIVIDER_X + 8; const photoY = cardY + CARD_HDR_H + 6;
  const photoW = TBL_W - TEXT_COL_W - 16; const photoH = CARD_H - CARD_HDR_H - 12;

  const fullImgPath = recipe.imagePath ? path.join(getImagesDir(), recipe.imagePath) : null;
  if (fullImgPath && fs.existsSync(fullImgPath)) {
    doc.image(fullImgPath, photoX, photoY, { fit: [photoW, photoH], align: "center", valign: "center" });
  } else {
    doc.font("Helvetica").fontSize(9).fillColor("#888888")
      .text("Sem imagem", photoX, photoY + photoH / 2 - 9, { width: photoW, align: "center", lineBreak: false });
    doc.fillColor(C_BLACK);
  }
}

function computeCardLayout(
  doc: PDFKit.PDFDocument, name: string, ingredients: string, preparation: string, width: number, availH: number,
): { nameSize: number; bodySize: number } {
  for (const bodySize of [9, 8.5, 8, 7.5, 7, 6.5, 6, 5.5]) {
    const nameSize = bodySize + 1.5;
    doc.font("Helvetica-Bold").fontSize(nameSize);
    const nameH = doc.heightOfString(name, { width, lineGap: 0.5 }) + 4;
    doc.font("Helvetica").fontSize(bodySize);
    const ingH = doc.heightOfString(ingredients, { width, lineGap: 0.8 }) + 5;
    doc.font("Helvetica-Bold").fontSize(bodySize + 0.5);
    const modeH = doc.heightOfString("MODO DE PREPARO", { width }) + 4;
    doc.font("Helvetica").fontSize(bodySize);
    const prepH = doc.heightOfString(preparation, { width, lineGap: 0.8 });
    if (nameH + ingH + modeH + prepH <= availH) return { nameSize, bodySize };
  }
  return { nameSize: 7, bodySize: 5.5 };
}

function getBrandLogoPath(): string | null {
  const candidate = resolveRuntimePath("assets", "logo.png");
  return fs.existsSync(candidate) ? candidate : null;
}
