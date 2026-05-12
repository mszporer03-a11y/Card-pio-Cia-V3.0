import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { DAY_COLUMNS, resolveRuntimePath } from "../core/utils.js";
import type { WeeklyPlan } from "../core/types.js";

// ── Brand palette — Companhia do Churrasco ────────────────────────────────────
// Primary: Vermelho Brasa #C02927 · Bege Quente #E4C193 · Off-white #F8F4EE · Black #000000
const C_RED      = "FFC02927"; // Vermelho Brasa — headers, banners, borders
const C_RED_DARK = "FF8B0000"; // Dark red — darker banner stripe
const C_BEIGE    = "FFE4C193"; // Bege Quente — category cells, title row
const C_CREAM    = "FFF8F4EE"; // Off-white — sequence cells, light areas
const C_WHITE    = "FFFFFFFF"; // Data cells
const C_BLACK    = "FF000000"; // Text
const C_WHITE_TEXT = "FFFAF0E6"; // Text on dark (banner)

export async function writeWeeklyPlanExcel(filePath: string, plan: WeeklyPlan): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Cardapio", {
    properties: { defaultRowHeight: 28 },
    pageSetup: {
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.25, right: 0.25, top: 0.35, bottom: 0.3, header: 0.1, footer: 0.1 },
    },
    views: [{ state: "frozen", ySplit: 4, showGridLines: false }],
  });
  const lastColumnLetter = columnNumberToLetter(DAY_COLUMNS.length + 2);
  const logoPath = getBrandLogoPath();

  sheet.columns = [
    { key: "n",      width: 5.5  },
    { key: "pratos", width: 18   },
    ...DAY_COLUMNS.map(() => ({ width: 17.5 })),
  ];
  sheet.pageSetup.printTitlesRow = "1:4";

  // ── Row 1: Banner ─────────────────────────────────────────────────────────
  sheet.mergeCells("A1:D1");
  sheet.mergeCells(`F1:${lastColumnLetter}1`);
  fillRange(sheet, "A1", "D1",  solidFill(C_RED));
  fillRange(sheet, "F1", `${lastColumnLetter}1`, solidFill(C_RED));

  const bannerCell = sheet.getCell("F1");
  bannerCell.value = "BUFFET QUENTE";
  bannerCell.font  = { bold: true, italic: true, color: { argb: C_WHITE_TEXT }, size: 16 };
  bannerCell.alignment = { vertical: "middle", horizontal: "right" };

  sheet.getRow(1).height = 26;
  sheet.getRow(2).height = 8;
  sheet.getRow(3).height = 26;
  sheet.getRow(4).height = 28;

  // Logo in E1
  if (logoPath) {
    const imageId = workbook.addImage({ filename: logoPath, extension: "png" });
    sheet.addImage(imageId, {
      tl: { col: 4.1, row: 0.1 },
      ext: { width: 56, height: 24 },
      editAs: "oneCell",
    });
  }

  // ── Row 3: Title ──────────────────────────────────────────────────────────
  sheet.mergeCells(`A3:${lastColumnLetter}3`);
  const titleCell = sheet.getCell("A3");
  titleCell.value     = plan.title;
  titleCell.alignment = { vertical: "middle", horizontal: "center" };
  titleCell.font      = { bold: true, size: 13, color: { argb: C_BLACK } };
  titleCell.fill      = solidFill(C_BEIGE);
  titleCell.border    = outlineBorder(C_RED);

  // ── Row 4: Column headers ─────────────────────────────────────────────────
  const headerRow = sheet.getRow(4);
  headerRow.values = ["N", "PRATOS", ...DAY_COLUMNS];
  styleHeaderRow(headerRow);

  // ── Data rows ─────────────────────────────────────────────────────────────
  const firstDataRowNumber = 5;
  for (const row of plan.rows) {
    const worksheetRow = sheet.addRow([
      row.sequence,
      row.categoryName,
      ...row.days.map((day) => day?.recipeName ?? ""),
    ]);
    stylePlanDataRow(worksheetRow, isPratosDoDia(row.categoryName));
  }

  mergeRepeatedSequenceCells(sheet, firstDataRowNumber, plan.rows);
  applyOuterBorder(sheet, 4, firstDataRowNumber + plan.rows.length - 1, DAY_COLUMNS.length + 2);

  // Center-align all cells
  for (let col = 1; col <= DAY_COLUMNS.length + 2; col++) {
    sheet.getColumn(col).eachCell({ includeEmpty: true }, (cell) => {
      if (!cell.alignment) {
        cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      }
    });
  }

  await workbook.xlsx.writeFile(filePath);
}

function styleHeaderRow(row: ExcelJS.Row): void {
  row.height = 28;
  row.eachCell((cell) => {
    cell.font      = { bold: true, color: { argb: C_WHITE_TEXT } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.fill      = solidFill(C_RED);
    cell.border    = allBorders(C_BLACK, "thin");
  });
}

function stylePlanDataRow(row: ExcelJS.Row, isMeat: boolean): void {
  row.height = 44;
  row.eachCell((cell, col) => {
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border    = allBorders(C_BLACK, "thin");
    if (col === 1) {
      cell.font = { bold: true, size: 11, color: { argb: C_BLACK } };
      cell.fill = solidFill(C_CREAM);
      return;
    }
    if (col === 2) {
      cell.font = { bold: true, size: 10, color: { argb: C_BLACK } };
      cell.fill = solidFill(isMeat ? "FFD4A868" : C_BEIGE);
      return;
    }
    cell.font = { size: 9, bold: true, color: { argb: C_BLACK } };
    cell.fill = solidFill(C_WHITE);
  });
}

function isPratosDoDia(categoryName: string): boolean {
  const n = categoryName.toUpperCase();
  return n.includes("PRATOS DO DIA") || n.includes("PRATO DO DIA");
}

function mergeRepeatedSequenceCells(sheet: ExcelJS.Worksheet, firstRowNumber: number, rows: WeeklyPlan["rows"]): void {
  let rangeStart = firstRowNumber;
  for (let i = 1; i <= rows.length; i++) {
    const current = rows[i - 1];
    const next    = rows[i];
    if (next && next.sequence === current.sequence) continue;
    const rangeEnd = firstRowNumber + i - 1;
    if (rangeEnd > rangeStart) sheet.mergeCells(`A${rangeStart}:A${rangeEnd}`);
    rangeStart = rangeEnd + 1;
  }
}

function applyOuterBorder(sheet: ExcelJS.Worksheet, startRow: number, endRow: number, totalColumns: number): void {
  for (let r = startRow; r <= endRow; r++) {
    for (let c = 1; c <= totalColumns; c++) {
      const cell   = sheet.getRow(r).getCell(c);
      const border = { ...(cell.border ?? {}) } as ExcelJS.Borders;
      if (r === startRow)   border.top    = { style: "medium", color: { argb: C_RED } };
      if (r === endRow)     border.bottom = { style: "medium", color: { argb: C_RED } };
      if (c === 1)          border.left   = { style: "medium", color: { argb: C_RED } };
      if (c === totalColumns) border.right = { style: "medium", color: { argb: C_RED } };
      cell.border = border;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function solidFill(argb: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function allBorders(argb = "FF000000", style: ExcelJS.BorderStyle = "thin"): ExcelJS.Borders {
  return {
    top:    { style, color: { argb } },
    left:   { style, color: { argb } },
    bottom: { style, color: { argb } },
    right:  { style, color: { argb } },
    diagonal: {},
  };
}

function outlineBorder(argb: string): ExcelJS.Borders {
  return allBorders(argb, "medium");
}

function fillRange(sheet: ExcelJS.Worksheet, from: string, to: string, fill: ExcelJS.Fill): void {
  const startCell   = sheet.getCell(from);
  const endCell     = sheet.getCell(to);
  const startRow    = Number(startCell.row);
  const endRow      = Number(endCell.row);
  const startColumn = Number(startCell.col);
  const endColumn   = Number(endCell.col);
  for (let row = startRow; row <= endRow; row++) {
    for (let column = startColumn; column <= endColumn; column++) {
      sheet.getRow(row).getCell(column).fill = fill;
    }
  }
}

function columnNumberToLetter(n: number): string {
  let dividend = n;
  let name = "";
  while (dividend > 0) {
    const mod = (dividend - 1) % 26;
    name     = String.fromCharCode(65 + mod) + name;
    dividend = Math.floor((dividend - mod) / 26);
  }
  return name;
}

function getBrandLogoPath(): string | null {
  const candidate = resolveRuntimePath("assets", "logo.png");
  return fs.existsSync(candidate) ? candidate : null;
}
