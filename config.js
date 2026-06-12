// Keyword → DM configuration
// Rules are stored in data/keyword-rules.json and managed via the admin UI.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// DATA_DIR: use persistent volume on Railway, fallback to local ./data
const DATA_DIR = process.env.DATA_DIR || resolve(__dirname, "data");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// On first deploy, seed from repo's default rules if volume is empty
const RULES_PATH = resolve(DATA_DIR, "keyword-rules.json");
const DEFAULT_RULES = resolve(__dirname, "data/keyword-rules.json");
if (!existsSync(RULES_PATH) && existsSync(DEFAULT_RULES)) {
  copyFileSync(DEFAULT_RULES, RULES_PATH);
}

export { DATA_DIR };

export function loadKeywordRules() {
  if (!existsSync(RULES_PATH)) return [];
  return JSON.parse(readFileSync(RULES_PATH, "utf-8"));
}

export function saveKeywordRules(rules) {
  writeFileSync(RULES_PATH, JSON.stringify(rules, null, 2));
}

// How close a comment must be to the keyword to count as a match.
// 0 = exact only, 1 = allow 1 character difference, etc.
export const MAX_TYPO_DISTANCE = 1;
