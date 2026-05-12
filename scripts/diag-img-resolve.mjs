// Test: try to actually get image data from livro-receitas
import fs from "node:fs";
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const { getDocument, OPS } = pdfjs;

const pdfPath = process.argv[2] || "C:/Users/aksak/Downloads/livro-receitas (1).pdf";
const pdf = await getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useWorkerFetch: false, useSystemFonts: true }).promise;

const page = await pdf.getPage(3);
const ol = await page.getOperatorList();
const fnArray = ol.fnArray;
const argsArray = ol.argsArray;

console.log(`Page 3 ops: ${fnArray.length}`);

for (let i = 0; i < fnArray.length; i++) {
  if (fnArray[i] === OPS.paintImageXObject) {
    const name = argsArray[i][0];
    console.log(`\nFound paintImageXObject at idx ${i}, name=${name}`);

    // Try sync get
    for (const [storeName, store] of [["objs", page.objs], ["commonObjs", pdf.commonObjs]]) {
      try {
        const d = store.get(name);
        if (d === undefined || d === null) {
          console.log(`  ${storeName}.get(${name}) = ${d}`);
        } else if (typeof d === "object") {
          const keys = Object.keys(d);
          console.log(`  ${storeName}.get(${name}) = {${keys.join(",")}}`);
          if (d.width) console.log(`    -> ${d.width}x${d.height} kind=${d.kind} data=${d.data?.length} bytes`);
        } else {
          console.log(`  ${storeName}.get(${name}) = ${typeof d}: ${d}`);
        }
      } catch (e) {
        console.log(`  ${storeName}.get(${name}) THREW: ${e.message}`);
      }
    }

    // Try async get via callback
    await new Promise((resolve) => {
      page.objs.get(name, (data) => {
        if (data) {
          console.log(`  async objs.get callback: ${data.width}x${data.height} kind=${data.kind}`);
        } else {
          console.log(`  async objs.get callback: null/undefined`);
        }
        resolve();
      });
    }).catch(() => {});

    // Check if it's a SMask or image reference
    console.log(`  argsArray[${i}]:`, JSON.stringify(argsArray[i]));
  }
}
