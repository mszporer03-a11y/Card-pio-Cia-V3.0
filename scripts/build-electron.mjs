/**
 * build-electron.mjs
 * Builds the Cardápio Cia v3.0 desktop app using Electron + electron-builder.
 *
 * Prerequisites (run first if server exe is missing):
 *   npm run build:server
 *
 * Outputs (inside release/electron-dist/):
 *   Cardapio-Cia-v3.0-Setup.exe     ← NSIS installer (recommended)
 *   Cardapio-Cia-v3.0-Portable.exe  ← Portable single exe
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir    = path.resolve(path.dirname(__filename), "..");
const releaseDir = path.join(rootDir, "release");
const distDir    = path.join(releaseDir, "electron-dist");
const serverExe  = path.join(releaseDir, "cardapio-cia-build.exe");

function runShell(commandLine, cwdDir = rootDir) {
  const result = spawnSync(commandLine, { cwd: cwdDir, stdio: "inherit", shell: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed: ${commandLine}`);
}

function main() {
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║   Cardápio Cia v3.0 — Build do App Desktop (Electron)          ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  if (!fs.existsSync(serverExe)) {
    console.error("❌ Servidor não encontrado em:", serverExe);
    console.error("   Execute primeiro: npm run build:server\n");
    process.exit(1);
  }
  console.log("✅ Servidor bundled encontrado:", path.basename(serverExe));

  const publicDir = path.join(releaseDir, "public");
  if (!fs.existsSync(publicDir)) {
    console.error("❌ Pasta public não encontrada:", publicDir);
    console.error("   Execute primeiro: npm run build:server\n");
    process.exit(1);
  }
  console.log("✅ Pasta public encontrada\n");

  console.log("🔨 Compilando app Electron...\n");

  const electronBuilderCmd = path.join(rootDir, "node_modules", ".bin", "electron-builder.cmd");
  runShell(`"${electronBuilderCmd}" --win --config electron-builder.json`);

  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║   Artefatos Gerados                                             ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  try {
    const files = fs.readdirSync(distDir).filter((f) => f.endsWith(".exe"));
    if (files.length === 0) {
      console.log("⚠️  Nenhum .exe encontrado em:", distDir);
    } else {
      for (const f of files) {
        const fullPath = path.join(distDir, f);
        const sizeMb   = (fs.statSync(fullPath).size / (1024 * 1024)).toFixed(1);
        console.log(`  📦 ${f}  (${sizeMb} MB)`);
      }
      console.log(`\n  📁 Pasta: ${distDir}\n`);
    }
  } catch {
    console.log("  Veja a pasta:", distDir);
  }
}

main();
