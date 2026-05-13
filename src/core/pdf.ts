import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import type { PageLine, PageTextItem } from "./types.js";
// Static import so esbuild bundles pdf.worker.mjs inline — avoids the
// /*webpackIgnore*/ dynamic import inside pdfjs that pkg cannot handle.
// @ts-expect-error: no type declarations for pdfjs worker bundle
import * as _pdfjsWorkerBundle from "pdfjs-dist/legacy/build/pdf.worker.mjs";

let pdfJsModulePromise: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | undefined;

export type PdfImageCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ImageResult = {
  path: string;
  pdfY: number; // PDF coordinate Y (bottom-up, higher = higher on page)
};

type RawImageData = {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
  kind: number;
};

function makeRawImageLike(width: number, height: number, rgba: Uint8ClampedArray): any {
  return {
    width,
    height,
    getContext: (_type: string) => ({
      getImageData: (_x: number, _y: number, _w: number, _h: number) => ({ data: rgba }),
    }),
    toBuffer: (_mime: string): Buffer => {
      const png = new PNG({ width, height });
      png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
      return PNG.sync.write(png);
    },
  };
}

export async function openPdf(filePath: string): Promise<any> {
  const { getDocument } = await loadPdfJs();
  const loadingTask = getDocument({
    data: new Uint8Array(fs.readFileSync(filePath)),
    useWorkerFetch: false,
    useSystemFonts: true,
  } as any);
  return loadingTask.promise;
}

function isPdfTextItem(item: unknown): item is { str: string; transform: number[]; width: number; height: number; fontName: string } {
  return typeof item === "object" && item !== null && "str" in item && "transform" in item;
}

export async function extractPageLines(page: any): Promise<PageLine[]> {
  const textContent = await page.getTextContent();
  const rawItems = (textContent.items as unknown[])
    .filter((item) => isPdfTextItem(item))
    .map((item) => {
      const textItem = item as { str: string; transform: number[]; width: number; height: number; fontName: string };
      return {
        text: textItem.str.trim(),
        x: textItem.transform[4],
        y: textItem.transform[5],
        width: textItem.width,
        height: textItem.height,
        fontName: textItem.fontName,
      } satisfies PageTextItem;
    });

  const items = rawItems
    .filter((item: PageTextItem) => item.text.length > 0)
    .sort((left: PageTextItem, right: PageTextItem) => {
      if (Math.abs(right.y - left.y) > 2) return right.y - left.y;
      return left.x - right.x;
    });

  const lines: PageLine[] = [];
  for (const item of items) {
    const currentLine = lines.at(-1);
    if (!currentLine || Math.abs(currentLine.y - item.y) > 2.5) {
      lines.push({ text: item.text, x: item.x, y: item.y, maxHeight: item.height, fontName: item.fontName, items: [item] });
      continue;
    }
    currentLine.items.push(item);
    currentLine.x = Math.min(currentLine.x, item.x);
    currentLine.maxHeight = Math.max(currentLine.maxHeight, item.height);
    currentLine.items.sort((left, right) => left.x - right.x);
    currentLine.text = joinLineText(currentLine.items);
    currentLine.fontName = dominantFont(currentLine.items);
  }

  const resolvedLines: PageLine[] = [];
  for (const line of lines) {
    for (const segment of splitLineItems(line.items)) {
      resolvedLines.push({
        text: joinLineText(segment).replace(/\s+/g, " ").trim(),
        x: Math.min(...segment.map((item) => item.x)),
        y: line.y,
        maxHeight: Math.max(...segment.map((item) => item.height)),
        fontName: dominantFont(segment),
        items: segment,
      });
    }
  }

  return resolvedLines;
}

function joinLineText(items: PageTextItem[]): string {
  let result = "";
  let previous: PageTextItem | undefined;
  for (const item of items) {
    if (!previous) { result = item.text; previous = item; continue; }
    const gap = item.x - (previous.x + previous.width);
    const separator = shouldInsertSpace(previous, item, gap) ? " " : "";
    result += `${separator}${item.text}`;
    previous = item;
  }
  return result;
}

function shouldInsertSpace(previous: PageTextItem, current: PageTextItem, gap: number): boolean {
  const previousText = previous.text.trim();
  const currentText = current.text.trim();
  if (!previousText || !currentText) return false;
  // Tight kerning: only suppress space for single-letter follow when gap is genuinely small.
  // Previously this used 0.6*height which swallowed real word boundaries
  // (e.g. "ACOMPANHAR" + "O" with gap=2pt in 8pt-tall text).
  if (currentText.length === 1 && /[\p{L}]$/u.test(previousText) && /^[\p{L}]$/u.test(currentText) && gap < previous.height * 0.15) return false;
  if (/[\-\/(]$/u.test(previousText) || /^[,.;:)%\]/]/u.test(currentText)) return false;
  if (gap > Math.max(1.5, previous.height * 0.1)) return true;
  const isWordBoundary = /[\p{L}\d)]$/u.test(previousText) && /^[\p{L}\d(]/u.test(currentText);
  if (!isWordBoundary) return false;
  return gap > -Math.max(1.5, previous.height * 0.2);
}

function splitLineItems(items: PageTextItem[]): PageTextItem[][] {
  const segments: PageTextItem[][] = [];
  let currentSegment: PageTextItem[] = [];
  for (const item of items) {
    if (currentSegment.length === 0) { currentSegment = [item]; continue; }
    if (shouldStartNewSegment(currentSegment, item)) { segments.push(currentSegment); currentSegment = [item]; continue; }
    currentSegment.push(item);
  }
  if (currentSegment.length > 0) segments.push(currentSegment);
  return segments;
}

function shouldStartNewSegment(currentSegment: PageTextItem[], nextItem: PageTextItem): boolean {
  const currentText = joinLineText(currentSegment).replace(/\s+/g, " ").trim();
  const nextText = nextItem.text.trim();
  if (!currentText || !nextText) return false;
  const previous = currentSegment.at(-1);
  if (!previous) return false;
  const gap = nextItem.x - (previous.x + previous.width);
  // Very large horizontal gap = column boundary. Split unconditionally so
  // 2-column recipe pages (e.g. "MOLHO DE MARACUJÁ" left / "MOLHO CREMOSO DE LIMÃO" right)
  // don't get merged into a single line.
  if (gap > 60) return true;
  if (gap > Math.max(36, previous.height * 1.8) && looksLikeIngredientStart(nextText)) return true;
  return looksLikeIngredientStart(nextText) && isShortContinuationFragment(currentText);
}

function looksLikeIngredientStart(text: string): boolean {
  return /^(?:\d|½|¼|¾|QB\b|SUMO\b|SUCO\b|AZEITE\b|LEITE\b|CREME\b|OVOS?\b|MORANGO\b)/u.test(normalizeForComparison(text));
}

function isShortContinuationFragment(text: string): boolean {
  const normalizedText = normalizeForComparison(text);
  if (!normalizedText) return false;
  const words = normalizedText.split(/\s+/).filter(Boolean);
  return words.length <= 3 && !looksLikeIngredientStart(text) && !/[,:;.]$/u.test(text);
}

function normalizeForComparison(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim().toUpperCase();
}

function dominantFont(items: PageTextItem[]): string {
  const frequencies = new Map<string, number>();
  for (const item of items) frequencies.set(item.fontName, (frequencies.get(item.fontName) ?? 0) + 1);
  return [...frequencies.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "";
}

// ── Image extraction ──────────────────────────────────────────────────────────

function isRawImageData(obj: unknown): obj is RawImageData {
  return typeof obj === "object" && obj !== null &&
    typeof (obj as any).width === "number" && typeof (obj as any).height === "number" &&
    ((obj as any).data instanceof Uint8ClampedArray || (obj as any).data instanceof Uint8Array);
}

function rawImageToCanvas(img: RawImageData): any {
  const { width, height, data, kind } = img;
  let rgba: Uint8ClampedArray;
  if (kind === 3) {
    rgba = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  } else if (kind === 2) {
    rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      rgba[j] = data[i]!; rgba[j + 1] = data[i + 1]!; rgba[j + 2] = data[i + 2]!; rgba[j + 3] = 255;
    }
  } else if (kind === 1) {
    rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pos = y * width + x;
        const byte = data[Math.floor(pos / 8)]!;
        const val = ((byte >> (7 - (pos % 8))) & 1) * 255;
        const j = pos * 4;
        rgba[j] = rgba[j + 1] = rgba[j + 2] = val; rgba[j + 3] = 255;
      }
    }
  } else {
    return null;
  }
  return makeRawImageLike(width, height, rgba);
}

function isLikelyRecipePhoto(img: RawImageData): boolean {
  const { width, height } = img;
  const ratio = width / height;
  if (width < 150 || height < 150) return false;
  if (ratio > 3.0 || ratio < 0.33) return false;
  if (width * height > 4_000_000) return false;
  if (img.data && img.data.length > 16 && isLikelySolidColorImage(img)) return false;
  if (img.data && img.data.length > 16 && hasLowColorVariance(img)) return false;
  return true;
}

function isLikelySolidColorImage(img: RawImageData): boolean {
  const { width, height, data, kind } = img;
  const bytesPerPixel = kind === 3 ? 4 : kind === 2 ? 3 : 0;
  if (bytesPerPixel === 0) return false;
  const totalPixels = width * height;
  const sampleCount = Math.min(200, totalPixels);
  const step = Math.max(1, Math.floor(totalPixels / sampleCount));
  const r0 = data[0]!, g0 = data[1]!, b0 = data[2]!;
  let sameCount = 0;
  for (let px = 0; px < totalPixels; px += step) {
    const offset = px * bytesPerPixel;
    const r = data[offset]!, g = data[offset + 1]!, b = data[offset + 2]!;
    if (Math.abs(r - r0) < 8 && Math.abs(g - g0) < 8 && Math.abs(b - b0) < 8) sameCount++;
  }
  return (sameCount / Math.ceil(totalPixels / step)) > 0.85;
}

function hasLowColorVariance(img: RawImageData): boolean {
  const { width, height, data, kind } = img;
  const bytesPerPixel = kind === 3 ? 4 : kind === 2 ? 3 : 0;
  if (bytesPerPixel === 0) return false;
  const totalPixels = width * height;
  const sampleCount = Math.min(500, totalPixels);
  const step = Math.max(1, Math.floor(totalPixels / sampleCount));
  let rSum = 0, gSum = 0, bSum = 0, rSumSq = 0, gSumSq = 0, bSumSq = 0, n = 0;
  for (let px = 0; px < totalPixels; px += step) {
    const offset = px * bytesPerPixel;
    const r = data[offset]!, g = data[offset + 1]!, b = data[offset + 2]!;
    rSum += r; gSum += g; bSum += b;
    rSumSq += r * r; gSumSq += g * g; bSumSq += b * b;
    n++;
  }
  if (n < 10) return false;
  const rVar = (rSumSq / n) - (rSum / n) ** 2;
  const gVar = (gSumSq / n) - (gSum / n) ** 2;
  const bVar = (bSumSq / n) - (bSum / n) ** 2;
  return ((rVar + gVar + bVar) / 3) < 150;
}

function saveIfValidPhoto(canvas: any, outputPath: string): boolean {
  const w: number = canvas.width;
  const h: number = canvas.height;
  if (w < 150 || h < 150) return false;
  const ctx = canvas.getContext("2d");
  const imageData = ctx.getImageData(0, 0, w, h);
  const data: Uint8ClampedArray = imageData.data;
  const totalPixels = w * h;
  const sampleCount = Math.min(500, totalPixels);
  const step = Math.max(1, Math.floor(totalPixels / sampleCount));
  let rSum = 0, gSum = 0, bSum = 0, rSumSq = 0, gSumSq = 0, bSumSq = 0, n = 0;
  for (let px = 0; px < totalPixels; px += step) {
    const offset = px * 4;
    const r = data[offset]!, g = data[offset + 1]!, b = data[offset + 2]!;
    rSum += r; gSum += g; bSum += b;
    rSumSq += r * r; gSumSq += g * g; bSumSq += b * b;
    n++;
  }
  if (n < 10) return false;
  const rVar = (rSumSq / n) - (rSum / n) ** 2;
  const gVar = (gSumSq / n) - (gSum / n) ** 2;
  const bVar = (bSumSq / n) - (bSum / n) ** 2;
  if (((rVar + gVar + bVar) / 3) < 150) return false;

  const pngBuf = canvas.toBuffer("image/png") as Buffer;
  const bytesPerPixel = pngBuf.length / totalPixels;
  const threshold = (w > 1000 && h > 700) ? 1.0 : 0.1;
  if (bytesPerPixel < threshold) return false;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, pngBuf);
  return true;
}

async function extractAllEmbeddedPhotoCanvases(operatorList: any, OPS: any, page: any): Promise<Array<{ canvas: any; opIndex: number; name: string }>> {
  const fnArray = operatorList.fnArray as number[];
  const argsArray = operatorList.argsArray as unknown[][];

  // Collect all image ops with their indices
  type ImageRequest = { name: string; opIndex: number; inlineData?: RawImageData };
  const requests: ImageRequest[] = [];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]!;
    if (fn === OPS.paintInlineImageXObject) {
      const imgData = (argsArray[i] as any[])[0];
      if (isRawImageData(imgData)) requests.push({ name: `inline_${i}`, opIndex: i, inlineData: imgData });
    } else if (fn === OPS.paintImageXObject) {
      const imageName = (argsArray[i] as any[])[0] as string;
      requests.push({ name: imageName, opIndex: i });
    }
  }

  if (requests.length === 0) return [];

  // Resolve all XObject images — pdfjs resolves image data asynchronously,
  // so synchronous store.get() throws for objects not yet ready.
  // The callback form (get(name, cb)) fires immediately if already resolved,
  // or waits until resolution, which correctly handles both cases.
  const collected: Array<RawImageData & { name: string; opIndex: number }> = [];
  await Promise.all(requests.map((req) => {
    if (req.inlineData) {
      collected.push({ ...req.inlineData, name: req.name, opIndex: req.opIndex });
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      try {
        page.objs.get(req.name, (data: unknown) => {
          if (isRawImageData(data)) collected.push({ ...(data as RawImageData), name: req.name, opIndex: req.opIndex });
          resolve();
        });
      } catch {
        resolve();
      }
    });
  }));

  if (collected.length === 0) return [];
  const photos = collected.filter((img) => isLikelyRecipePhoto(img)).sort((a, b) => b.width * b.height - a.width * a.height);
  const results: Array<{ canvas: any; opIndex: number; name: string }> = [];
  for (const photo of photos) {
    const canvas = rawImageToCanvas(photo);
    if (canvas) results.push({ canvas, opIndex: photo.opIndex, name: photo.name });
  }
  return results;
}

function getImagePaintPositions(operatorList: any, OPS: any, viewport: any): Map<number, PdfImageCrop> {
  const { fnArray, argsArray } = operatorList as { fnArray: number[]; argsArray: unknown[][] };
  const matrixStack: number[][] = [[1, 0, 0, 1, 0, 0]];
  const result = new Map<number, PdfImageCrop>();
  const scale: number = (viewport as any).scale ?? 2;
  const vHeight: number = (viewport as any).height;

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]!;
    const args = argsArray[i] as number[];
    if (fn === OPS.save) {
      matrixStack.push([...matrixStack[matrixStack.length - 1]!]);
    } else if (fn === OPS.restore) {
      if (matrixStack.length > 1) matrixStack.pop();
    } else if (fn === OPS.transform) {
      const [a, b, c, d, e, f] = args;
      const m = matrixStack[matrixStack.length - 1]!;
      matrixStack[matrixStack.length - 1] = [
        m[0]! * a! + m[2]! * b!, m[1]! * a! + m[3]! * b!,
        m[0]! * c! + m[2]! * d!, m[1]! * c! + m[3]! * d!,
        m[0]! * e! + m[2]! * f! + m[4]!, m[1]! * e! + m[3]! * f! + m[5]!,
      ];
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const [a, , c, d, e, f] = matrixStack[matrixStack.length - 1]!;
      const pdfCorners = [
        [e!, f!], [a! + e!, matrixStack[matrixStack.length - 1]![1]! + f!],
        [a! + c! + e!, matrixStack[matrixStack.length - 1]![1]! + d! + f!], [c! + e!, d! + f!],
      ];
      const canvasYs = pdfCorners.map(([, py]) => vHeight - py! * scale);
      const canvasXs = pdfCorners.map(([px]) => px! * scale);
      result.set(i, {
        x: Math.min(...canvasXs), y: Math.min(...canvasYs),
        width: Math.max(...canvasXs) - Math.min(...canvasXs),
        height: Math.max(...canvasYs) - Math.min(...canvasYs),
      });
    }
  }
  return result;
}

export async function extractRecipeImage(page: any, outputPath: string): Promise<ImageResult | null> {
  const results = await extractAllRecipeImages(page, outputPath.replace(/\.png$/, ""), 1);
  if (results.length === 0) return null;
  // Rename suffixed file to the expected single-image path
  if (results[0].path !== outputPath && fs.existsSync(results[0].path)) {
    fs.renameSync(results[0].path, outputPath);
    return { path: outputPath, pdfY: results[0].pdfY };
  }
  return results[0];
}

export async function extractAllRecipeImages(page: any, outputPathBase: string, maxCount: number = 1): Promise<ImageResult[]> {
  const { OPS } = await loadPdfJs();
  const operatorList = await page.getOperatorList();
  const hasImageOps = operatorList.fnArray.some(
    (op: number) => op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject,
  );
  if (!hasImageOps) return [];
  const dir = path.dirname(outputPathBase);
  fs.mkdirSync(dir, { recursive: true });
  const scale = 2;
  const viewport = page.getViewport({ scale });
  const ctmPositions = getImagePaintPositions(operatorList, OPS, viewport);
  const allCanvases = await extractAllEmbeddedPhotoCanvases(operatorList, OPS, page);

  if (allCanvases.length > 0) {
    // Filter out images in header/footer decoration areas
    // These PDFs use 540pt tall pages: header ~top 70pt, footer ~bottom 45pt
    const contentMinCanvasY = 130; // scale=2: below header decorations
    const contentMaxCanvasY = viewport.height - 80; // above footer bar

    type CanvasWithPos = { canvas: any; canvasY: number; pdfY: number };
    const withPos: CanvasWithPos[] = [];
    for (const c of allCanvases) {
      const pos = ctmPositions.get(c.opIndex);
      // If position unknown, treat as valid content (can't determine if header/footer)
      const canvasY = pos?.y ?? (viewport.height / 2);
      // Skip decorative images in header/footer areas
      if (canvasY < contentMinCanvasY || canvasY > contentMaxCanvasY) continue;
      const pdfY = (viewport.height - canvasY) / scale;
      withPos.push({ canvas: c.canvas, canvasY, pdfY });
    }
    withPos.sort((a, b) => a.canvasY - b.canvasY); // top to bottom in visual order
    const saved: ImageResult[] = [];
    for (let i = 0; i < withPos.length && saved.length < maxCount; i++) {
      const suffix = withPos.length > 1 ? String.fromCharCode(97 + i) : "";
      const outputPath = `${outputPathBase}${suffix}.png`;
      if (saveIfValidPhoto(withPos[i]!.canvas, outputPath)) {
        saved.push({ path: outputPath, pdfY: withPos[i]!.pdfY });
      }
    }
    if (saved.length > 0) return saved;
  }
  return [];
}

async function loadPdfJs(): Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
      // Inject the pre-bundled WorkerMessageHandler so pdfjs never needs to
      // dynamically import pdf.worker.mjs (which fails in @yao-pkg/pkg).
      const wmh = (_pdfjsWorkerBundle as any).WorkerMessageHandler;
      if (wmh && (pdfjs as any).PDFWorker) {
        Object.defineProperty((pdfjs as any).PDFWorker, "_setupFakeWorkerGlobal", {
          get: () => Promise.resolve(wmh),
          configurable: true,
        });
      }
      return pdfjs;
    });
  }
  return pdfJsModulePromise;
}
