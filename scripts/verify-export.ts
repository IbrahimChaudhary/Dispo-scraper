import fs from "node:fs";
import path from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import xlsx from "xlsx";
import { ensureDir, getConfig, log, runId } from "./common.js";

type Row = Record<string, unknown>;

function newestFile(dirPath: string): string {
  const entries = fs
    .readdirSync(dirPath)
    .map((name) => path.join(dirPath, name))
    .filter((fullPath) => fs.statSync(fullPath).isFile());

  if (!entries.length) {
    throw new Error(`No files found in ${dirPath}`);
  }

  entries.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return entries[0];
}

function parseFile(filePath: string): Row[] {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".csv" || ext === ".txt") {
    const raw = fs.readFileSync(filePath, "utf8");
    return parseCsv(raw, { columns: true, skip_empty_lines: true }) as Row[];
  }

  if (ext === ".xlsx" || ext === ".xls") {
    const workbook = xlsx.readFile(filePath);
    const firstSheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[firstSheetName];
    return xlsx.utils.sheet_to_json<Row>(sheet, { defval: "" });
  }

  throw new Error(`Unsupported export file extension: ${ext}`);
}

function assertRequiredColumns(rows: Row[], requiredColumns: string[]): void {
  if (!rows.length) {
    throw new Error("Export file has zero rows.");
  }
  const columns = Object.keys(rows[0]);
  const missing = requiredColumns.filter((required) => !columns.includes(required));
  if (missing.length) {
    throw new Error(`Missing required columns: ${missing.join(", ")}`);
  }
}

function main(): void {
  const id = runId();
  const config = getConfig();
  ensureDir(config.outputDir);

  if (!fs.existsSync(config.downloadsDir)) {
    throw new Error(`Downloads directory not found: ${config.downloadsDir}`);
  }

  const latest = newestFile(config.downloadsDir);
  const rows = parseFile(latest);
  assertRequiredColumns(rows, config.requiredColumns);

  const preview = rows.slice(0, 3);
  const normalizedPath = path.join(config.outputDir, "latest.json");
  fs.writeFileSync(normalizedPath, JSON.stringify(rows, null, 2), "utf8");

  log(id, "export verified", {
    file: latest,
    rowCount: rows.length,
    preview
  });
  log(id, "normalized json written", { path: normalizedPath });
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
