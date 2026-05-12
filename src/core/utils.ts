import fs from "node:fs";
import path from "node:path";

export const DAY_COLUMNS = [
  "SEGUNDA",
  "TERCA",
  "QUARTA",
  "QUINTA",
  "SEXTA",
  "SABADO",
  "DOMINGO",
] as const;

export function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^A-Z0-9]+/gi, " ")
    .trim()
    .toUpperCase();
}

export function slugify(value: string): string {
  return normalizeText(value).toLowerCase().replace(/\s+/g, "-");
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function sampleWithoutReplacement<T>(items: T[], count: number, random: () => number): T[] {
  const pool = [...items];
  const result: T[] = [];
  for (let index = 0; index < count; index += 1) {
    const choice = Math.floor(random() * pool.length);
    result.push(pool.splice(choice, 1)[0]);
  }
  return result;
}

export function sampleWithReplacement<T>(items: T[], count: number, random: () => number): T[] {
  const result: T[] = [];
  for (let index = 0; index < count; index += 1) {
    const choice = Math.floor(random() * items.length);
    result.push(items[choice]);
  }
  return result;
}

export function inferPlanTitleFromSelections(selectionKeys: string[]): string {
  const dateText = new Date().toISOString().slice(0, 10);
  return `CARDAPIO SEMANAL ${dateText} - ${selectionKeys.length} CATEGORIAS`;
}

export function displayPdfLabel(filePath: string): string {
  return path.basename(filePath);
}

/**
 * Compute a 0–1 similarity score between two recipe names using word-level
 * Jaccard index on normalised tokens.
 */
export function recipeSimilarity(a: string, b: string): number {
  const tokenise = (s: string) => new Set(normalizeText(s).split(/\s+/).filter(Boolean));
  const setA = tokenise(a);
  const setB = tokenise(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Sample `count` items from `items`, maximising diversity according to a
 * similarity function.
 */
export function sampleDiversified<T>(
  items: T[],
  count: number,
  nameOf: (item: T) => string,
  random: () => number,
  threshold = 0.5,
): T[] {
  if (items.length === 0) return [];
  if (count >= items.length) {
    return sampleWithoutReplacement(items, items.length, random);
  }

  const selected: T[] = [];
  const remaining = [...items];
  const maxRetries = Math.min(remaining.length * 2, 60);

  while (selected.length < count && remaining.length > 0) {
    let bestIdx = -1;
    let bestScore = Infinity;

    for (let attempt = 0; attempt < maxRetries && remaining.length > 0; attempt++) {
      const idx = Math.floor(random() * remaining.length);
      const candidate = remaining[idx];
      const candidateName = nameOf(candidate);

      let worstSim = 0;
      for (const sel of selected) {
        const sim = recipeSimilarity(candidateName, nameOf(sel));
        if (sim > worstSim) worstSim = sim;
      }

      if (worstSim < threshold) {
        selected.push(remaining.splice(idx, 1)[0]);
        bestIdx = -1;
        break;
      }

      if (worstSim < bestScore) {
        bestScore = worstSim;
        bestIdx = idx;
      }
    }

    if (bestIdx >= 0) {
      selected.push(remaining.splice(bestIdx, 1)[0]);
    }
  }

  return selected;
}

export function getAppDataDir(): string {
  return path.resolve(process.cwd());
}

export function isPackagedRuntime(): boolean {
  return typeof (process as NodeJS.Process & { pkg?: unknown }).pkg !== "undefined";
}

export function getRuntimeRootDir(): string {
  if (process.env.CARDAPIO_DATA_DIR) {
    return process.env.CARDAPIO_DATA_DIR;
  }
  if (isPackagedRuntime()) {
    return path.dirname(process.execPath);
  }
  return getAppDataDir();
}

export function resolveRuntimePath(...parts: string[]): string {
  return path.join(getRuntimeRootDir(), ...parts);
}

export function resolvePublicDir(): string {
  const externalPublic = resolveRuntimePath("public");
  if (fs.existsSync(externalPublic)) return externalPublic;
  return path.join(getAppDataDir(), "public");
}
