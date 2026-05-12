import fs from "node:fs";
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const { getDocument, OPS } = pdfjs;

const pdfPath = process.argv[2] || "C:/Users/aksak/Downloads/livro-receitas (1).pdf";
const pdf = await getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useWorkerFetch: false, useSystemFonts: true }).promise;

console.log(`PDF: ${pdfPath}, pages: ${pdf.numPages}`);

for (let p = 1; p <= Math.min(pdf.numPages, 10); p++) {
  const page = await pdf.getPage(p);
  const ol = await page.getOperatorList();
  const fnArray = ol.fnArray;

  const imgOpNames = {
    [OPS.paintImageXObject]: "paintImageXObject",
    [OPS.paintInlineImageXObject]: "paintInlineImageXObject",
    [OPS.paintSolidColorImageMask]: "paintSolidColorImageMask",
    [OPS.paintImageMaskXObject]: "paintImageMaskXObject",
    [OPS.paintFormXObjectBegin]: "paintFormXObjectBegin",
  };

  const found = {};
  for (const fn of fnArray) {
    if (imgOpNames[fn]) found[imgOpNames[fn]] = (found[imgOpNames[fn]] || 0) + 1;
  }

  // Try to resolve any XObject images
  const xobjectEntries = [];
  for (let i = 0; i < fnArray.length; i++) {
    if (fnArray[i] === OPS.paintImageXObject) {
      const name = ol.argsArray[i][0];
      for (const store of [page.objs, page.commonObjs]) {
        try {
          const d = store.get(name);
          if (d && typeof d.width === "number") {
            xobjectEntries.push(`${name}: ${d.width}x${d.height} kind=${d.kind}`);
            break;
          }
        } catch {}
      }
    }
  }

  // Check for Form XObjects (nested content streams with images inside)
  const formXobjectNames = [];
  for (let i = 0; i < fnArray.length; i++) {
    if (fnArray[i] === OPS.paintFormXObjectBegin) {
      const name = ol.argsArray[i]?.[0];
      if (name) formXobjectNames.push(name);
    }
  }

  console.log(`\nPage ${p}: ${fnArray.length} ops`);
  if (Object.keys(found).length) console.log(`  OPs: ${JSON.stringify(found)}`);
  if (xobjectEntries.length) console.log(`  Images: ${xobjectEntries.join(", ")}`);
  if (formXobjectNames.length) {
    console.log(`  FormXObjects: ${formXobjectNames.slice(0,5).join(", ")}`);
    // Try to resolve form xobject for nested images
    for (const name of formXobjectNames.slice(0, 2)) {
      for (const store of [page.objs, page.commonObjs]) {
        try {
          const d = store.get(name);
          if (d) { console.log(`    FormXObj ${name}: ${JSON.stringify(Object.keys(d))}`); break; }
        } catch {}
      }
    }
  }
  if (!Object.keys(found).length) console.log(`  (no image ops found)`);
}
