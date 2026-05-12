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
    "--packages=external",
    `--outfile=${pkgEntryPath}`,
  ];

  if (process.platform === "win32") {
    const esbuildCmd = path.join(rootDir, "node_modules", ".bin", "esbuild.cmd");
    runShell([quoteArg(esbuildCmd), ...esbuildArgs.map(quoteArg)].join(" "));
  } else {
    run(path.join(rootDir, "node_modules", ".bin", "esbuild"), esbuildArgs);
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
