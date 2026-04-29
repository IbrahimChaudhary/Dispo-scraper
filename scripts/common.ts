import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

export type ScraperConfig = {
  email: string;
  password: string;
  loginUrl: string;
  buyersUrl: string;
  headless: boolean;
  timeoutMs: number;
  downloadsDir: string;
  outputDir: string;
  storageStatePath: string;
  requiredColumns: string[];
};

export const ROOT_DIR = process.cwd();

export function resolveFromRoot(...parts: string[]): string {
  return path.resolve(ROOT_DIR, ...parts);
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function nowStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function runId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function log(id: string, message: string, meta?: Record<string, unknown>): void {
  const payload = meta ? ` ${JSON.stringify(meta)}` : "";
  console.log(`[${new Date().toISOString()}] [${id}] ${message}${payload}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retry<T>(
  id: string,
  label: string,
  attempts: number,
  delayMs: number,
  fn: (attempt: number) => Promise<T>
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (attempt > 1) {
        log(id, `${label} retry`, { attempt, attempts });
      }
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function boolEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  return ["1", "true", "yes", "y"].includes(raw);
}

function numberEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  const num = Number(raw);
  if (!Number.isFinite(num)) return defaultValue;
  return num;
}

export function getConfig(): ScraperConfig {
  const requiredColumns = (process.env.REQUIRED_COLUMNS ?? "Name,Mailing address,Mailing city,Zip Code,State")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    email: requiredEnv("BUYERS_EMAIL"),
    password: requiredEnv("BUYERS_PASSWORD"),
    loginUrl: process.env.BUYERS_LOGIN_URL?.trim() || "https://skinnovationsllc.8020rei.com/session/login",
    buyersUrl: process.env.BUYERS_URL?.trim() || "https://skinnovationsllc.8020rei.com/buyers",
    headless: boolEnv("HEADLESS", false),
    timeoutMs: numberEnv("ACTION_TIMEOUT_MS", 60_000),
    downloadsDir: resolveFromRoot("downloads"),
    outputDir: resolveFromRoot("output"),
    storageStatePath: resolveFromRoot("auth", "storageState.json"),
    requiredColumns
  };
}
