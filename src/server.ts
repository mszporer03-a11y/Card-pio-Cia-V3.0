import express from "express";
import type { NextFunction, Request, Response } from "express";
import fs from "node:fs";
import { getImagesDir } from "./core/database.js";
import { resolvePublicDir, resolveRuntimePath } from "./core/utils.js";
import { extractRouter } from "./routes/extract.js";
import { recipesRouter } from "./routes/recipes.js";
import { planRouter } from "./routes/plan.js";

const app  = express();
const PORT = 3456;

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(resolvePublicDir()));
app.use("/images",  express.static(getImagesDir()));

const outputDir = resolveRuntimePath("output");
fs.mkdirSync(outputDir, { recursive: true });
app.use("/output", express.static(outputDir));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use("/api", extractRouter);
app.use("/api", recipesRouter);
app.use("/api", planRouter);

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[unhandled]", err);
  if (!res.headersSent) {
    res.status(500).json({ error: err.message ?? "Erro interno do servidor" });
  }
});

// ── Start & graceful shutdown ─────────────────────────────────────────────────
import { closeDatabase } from "./core/database.js";

const server = app.listen(PORT, () => {
  console.log(`\n  Cardápio Cia v3.0 rodando em http://localhost:${PORT}\n`);
});

function shutdown() {
  console.log("\nEncerrando servidor...");
  server.close(() => {
    try { closeDatabase(); } catch {}
    console.log("Servidor encerrado.");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
