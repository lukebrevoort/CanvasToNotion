import dotenv from "dotenv";
dotenv.config({ override: true });
import path from "node:path";
import fs from "node:fs";

const repoRoot = path.resolve(import.meta.dirname, "..");
export const dataDir = path.join(repoRoot, "data");
fs.mkdirSync(dataDir, { recursive: true });

export const config = {
  repoRoot,
  dataDir,
  dbPath: path.join(dataDir, "cantn.sqlite"),
  credentialsPath: path.join(dataDir, "credentials.json"),
  statePath: path.join(dataDir, "state.json"),

  canvasDomain: process.env.CANVAS_DOMAIN ?? "",
  notionToken: process.env.NOTION_TOKEN ?? "",
  hqPageId: process.env.NOTION_HQ_PAGE_ID ?? "",
  assignmentsDbId: process.env.NOTION_ASSIGNMENTS_DB_ID ?? "",
  coursesDbId: process.env.NOTION_COURSES_DB_ID ?? "",
  syncIntervalMinutes: Number(process.env.SYNC_INTERVAL_MINUTES ?? 10),
};

export function requireEnv(name: string, value: string): string {
  if (!value) throw new Error(`Missing ${name}. Set it in .env (see .env.example).`);
  return value;
}
