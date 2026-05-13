import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir      = path.resolve(path.dirname(__filename), "..");
const buildDir     = path.join(rootDir, "build");
const releaseDir   = path.join(rootDir, "release");
const exeName      = "cardapio-cia-build.exe";
const exePath      = path.join(releaseDir, exeName);
const pkgEntryPath = path.join(buildDir, "pkg-server.cjs");

function run(command, args, cwdDir = rootDir) {
  const result = spawnSync(command, args, { cwd: cwdDir, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed: ${command} ${args.join(" ")}`);
}

function runShell(commandLine, cwdDir = rootDir) {
  const result = spawnSync(commandLine, { cwd: cwdDir, stdio: "inherit", shell: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed: ${commandLine}`);
}

function quoteArg(arg) {
  if (/^[a-zA-Z0-9_./:-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function copyDir(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const src = path.join(sourceDir, entry.name);
    const dst = path.join(targetDir, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

function writeLauncher() {
  const batPath = path.join(releaseDir, "iniciar-cardapio.bat");
  const content = ["@echo off", "cd /d %~dp0", `start "" ${exeName}`, ""].join("\r\n");
  fs.writeFileSync(batPath, content, "utf8");
}

function ensureWritableFolders() {
  fs.mkdirSync(path.join(releaseDir, "data", "images"),  { recursive: true });
  fs.mkdirSync(path.join(releaseDir, "data", "uploads"), { recursive: true });
  fs.mkdirSync(path.join(releaseDir, "output"),           { recursive: true });
}

function main() {
  fs.rmSync(buildDir,   { recursive: true, force: true });
  fs.mkdirSync(buildDir,   { recursive: true });
  fs.mkdirSync(releaseDir, { recursive: true });

  const esbuildArgs = [
    "src/pkgEntry.ts",
    "--bundle",
    "--platform=node",
    "--target=node24",
    "--format=cjs",
    // Keep native/problematic packages external; pdfjs-dist and pptxgenjs are
    // bundled inline to avoid the pkg dynamic-import limitation with ESM modules.
    "--external:better-sqlite3",
    "--external:exceljs",
    "--external:express",
    "--external:multer",
    "--external:pdfkit",
    "--external:pngjs",
    `--outfile=${pkgEntryPath}`,
  ];

  if (process.platform === "win32") {
    const esbuildCmd = path.join(rootDir, "node_modules", ".bin", "esbuild.cmd");
    runShell([quoteArg(esbuildCmd), ...esbuildArgs.map(quoteArg)].join(" "));
  } else {
    run(path.join(rootDir, "node_modules", ".bin", "esbuild"), esbuildArgs);
  }

  // Patch remaining dynamic import() calls for Node built-ins that esbuild
  // leaves as-is inside bundled CJS code (e.g. pptxgenjs lazily imports
  // node:fs and node:https). pkg cannot handle these dynamic imports, so
  // replace them with synchronous require() wrapped in Promise.resolve().
  {
    let bundleCode = fs.readFileSync(pkgEntryPath, "utf8");
    const builtins = ["node:fs", "node:https", "node:http", "node:path", "node:url",
                      "node:crypto", "node:stream", "node:buffer", "node:util",
                      "node:os", "node:zlib", "node:events", "node:assert"];
    for (const mod of builtins) {
      const dq = `import("${mod}")`;
      const sq = `import('${mod}')`;
      const replacement = (q) => `Promise.resolve({default:require(${q}), ...require(${q})})`;
      bundleCode = bundleCode.replaceAll(dq, replacement(`"${mod}"`));
      bundleCode = bundleCode.replaceAll(sq, replacement(`'${mod}'`));
    }
    fs.writeFileSync(pkgEntryPath, bundleCode, "utf8");
    console.log("Patched dynamic built-in imports in bundle.");
  }

  const pkgArgs = [
    "--config",        path.join(rootDir, "package.json"),
    pkgEntryPath,
    "--targets",       "node24-win-x64",
    "--compress",      "GZip",
    "--output",        exePath,
    "--fallback-to-source",
  ];

  if (process.platform === "win32") {
    const pkgCmd = path.join(rootDir, "node_modules", ".bin", "pkg.cmd");
    runShell([quoteArg(pkgCmd), ...pkgArgs.map(quoteArg)].join(" "));
  } else {
    run(path.join(rootDir, "node_modules", ".bin", "pkg"), pkgArgs);
  }

  copyDir(path.join(rootDir, "public"),  path.join(releaseDir, "public"));
  copyDir(path.join(rootDir, "assets"),  path.join(releaseDir, "assets"));
  ensureWritableFolders();
  writeLauncher();

  console.log("\nBuild concluido.");
  console.log(`Executavel: ${exePath}`);
  console.log(`Pasta para distribuir: ${releaseDir}`);
}

main();
