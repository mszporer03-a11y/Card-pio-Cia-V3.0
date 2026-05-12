/**
 * Diagnostic script: scan PDFs and report all images found per page,
 * their dimensions, position, and which filter rejects them.
 * Run: node scripts/diag-images.mjs "path/to/file.pdf"
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const { getDocument, OPS } = pdfjs;

const pdfPath = process.argv[2];
if (!pdfPath) { console.error("Usage: node scripts/diag-images.mjs <pdf>"); process.exit(1); }

const loadingTask = getDocument({
  data: new Uint8Array(fs.readFileSync(pdfPath)),
  useWorkerFetch: false,
  useSystemFonts: true,
});
const pdf = await loadingTask.promise;
const scale = 2;

console.log(`\nPDF: ${path.basename(pdfPath)}`);
console.log(`Pages: ${pdf.numPages}`);
console.log("─".repeat(80));

for (let pageNum = 1; pageNum <= Math.min(pdf.numPages, 20); pageNum++) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const operatorList = await page.getOperatorList();
  const fnArray = operatorList.fnArray;
  const argsArray = operatorList.argsArray;

  const collected = [];

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    let imgData = null;
    let name = "";

    if (fn === OPS.paintInlineImageXObject) {
      imgData = argsArray[i][0];
      name = `inline_${i}`;
    } else if (fn === OPS.paintImageXObject) {
      const imageName = argsArray[i][0];
      for (const store of [page.objs, page.commonObjs]) {
        try {
          const d = store.get(imageName);
          if (d && typeof d.width === "number") { imgData = d; name = imageName; break; }
        } catch {}
      }
    }

    if (!imgData || typeof imgData.width !== "number") continue;

    const { width, height, kind } = imgData;
    const ratio = width / height;
    const mp = width * height;

    // Get paint position
    const matrixStack = [[1, 0, 0, 1, 0, 0]];
    const replayFns = fnArray.slice(0, i + 1);
    const replayArgs = argsArray.slice(0, i + 1);
    for (let j = 0; j < replayFns.length; j++) {
      const rfn = replayFns[j];
      const rargs = replayArgs[j];
      if (rfn === OPS.save) { matrixStack.push([...matrixStack[matrixStack.length - 1]]); }
      else if (rfn === OPS.restore) { if (matrixStack.length > 1) matrixStack.pop(); }
      else if (rfn === OPS.transform) {
        const [a, b, c, d, e, f] = rargs;
        const m = matrixStack[matrixStack.length - 1];
        matrixStack[matrixStack.length - 1] = [
          m[0]*a+m[2]*b, m[1]*a+m[3]*b,
          m[0]*c+m[2]*d, m[1]*c+m[3]*d,
          m[0]*e+m[2]*f+m[4], m[1]*e+m[3]*f+m[5],
        ];
      }
    }

    const [, , , , ex, ey] = matrixStack[matrixStack.length - 1];
    const canvasY = viewport.height - ey * scale;
    const contentMinY = 130, contentMaxY = viewport.height - 80;
    const inContent = canvasY >= contentMinY && canvasY <= contentMaxY;

    // Apply each filter
    const reasons = [];
    if (width < 150 || height < 150) reasons.push(`too_small(${width}x${height})`);
    if (ratio > 2.5 || ratio < 0.4) reasons.push(`bad_ratio(${ratio.toFixed(2)})`);
    if (mp > 1_000_000) reasons.push(`too_large(${(mp/1e6).toFixed(2)}MP)`);
    if (!inContent) reasons.push(`out_of_content_area(canvasY=${canvasY.toFixed(0)},min=${contentMinY},max=${contentMaxY.toFixed(0)})`);

    // Color variance check (sample)
    const bytesPerPixel = kind === 3 ? 4 : kind === 2 ? 3 : 0;
    let variance = null;
    if (bytesPerPixel > 0 && imgData.data?.length > 16) {
      const { data } = imgData;
      const totalPx = width * height;
      const sampleCount = Math.min(500, totalPx);
      const step = Math.max(1, Math.floor(totalPx / sampleCount));
      let rSum=0, gSum=0, bSum=0, rSumSq=0, gSumSq=0, bSumSq=0, n=0;
      for (let px = 0; px < totalPx; px += step) {
        const off = px * bytesPerPixel;
        const r = data[off], g = data[off+1], b = data[off+2];
        rSum+=r; gSum+=g; bSum+=b;
        rSumSq+=r*r; gSumSq+=g*g; bSumSq+=b*b;
        n++;
      }
      const rV = rSumSq/n - (rSum/n)**2;
      const gV = gSumSq/n - (gSum/n)**2;
      const bV = bSumSq/n - (bSum/n)**2;
      variance = (rV+gV+bV)/3;
      if (variance < 150) reasons.push(`low_variance(${variance.toFixed(0)})`);
    }

    const status = reasons.length === 0 ? "✅ PASS" : "❌ FAIL";
    collected.push({ name, width, height, kind, ratio, mp, canvasY, inContent, variance, reasons, status });
  }

  if (collected.length > 0) {
    console.log(`\nPage ${pageNum}: ${collected.length} image(s)`);
    for (const img of collected) {
      const varStr = img.variance !== null ? ` var=${img.variance.toFixed(0)}` : "";
      const reasonStr = img.reasons.length ? ` → ${img.reasons.join(", ")}` : "";
      console.log(`  ${img.status} ${img.name} ${img.width}x${img.height} kind=${img.kind} ratio=${img.ratio.toFixed(2)} ${(img.mp/1000).toFixed(0)}kpx canvasY=${img.canvasY.toFixed(0)}${varStr}${reasonStr}`);
    }
  }
}
console.log("\n─".repeat(80));
console.log("Done.");
process.exit(0);
