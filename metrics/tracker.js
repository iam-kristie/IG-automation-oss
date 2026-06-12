#!/usr/bin/env node

// Instagram Metrics Tracker
// Fetches insights for all posts via IG Graph API and outputs CSV.
// Usage: node metrics/tracker.js [--csv path/to/output.csv]

import { createClient } from "../lib/instagram.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

const ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
if (!ACCESS_TOKEN) {
  console.error("Error: IG_ACCESS_TOKEN environment variable is required");
  process.exit(1);
}

const ig = createClient(ACCESS_TOKEN);

// CSV output path — default or from --csv flag
const csvFlagIdx = process.argv.indexOf("--csv");
const CSV_PATH =
  csvFlagIdx !== -1
    ? resolve(process.argv[csvFlagIdx + 1])
    : resolve("metrics-output.csv");

// Map IG media_type to our type names
function mediaType(igType) {
  switch (igType) {
    case "VIDEO":
      return "reel";
    case "CAROUSEL_ALBUM":
      return "carousel";
    case "IMAGE":
      return "photo";
    default:
      return igType.toLowerCase();
  }
}

// Extract a short topic from caption (first line, stripped of emojis, truncated)
function extractTopic(caption) {
  if (!caption) return "untitled";
  const firstLine = caption.split("\n")[0].replace(/[^\w\s\u4e00-\u9fff-]/g, "").trim();
  return firstLine.slice(0, 50) || "untitled";
}

// Read existing CSV to preserve manual fields (folder, pinned, notes, etc.)
function readExistingCSV(path) {
  if (!existsSync(path)) return new Map();
  const lines = readFileSync(path, "utf-8").trim().split("\n");
  if (lines.length < 2) return new Map();

  const headers = lines[0].split(",");
  const rows = new Map();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Simple CSV parse (handles our case — no commas in values except notes)
    const values = parseCSVLine(line);
    const row = {};
    headers.forEach((h, idx) => (row[h] = values[idx] || ""));
    // Key by date + type for matching
    rows.set(`${row.date}|${row.type}`, row);
  }
  return rows;
}

// Basic CSV line parser that handles our format
function parseCSVLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values;
}

const CSV_HEADERS = [
  "date", "platform", "type", "topic", "folder", "status", "pinned",
  "likes_7d", "comments_7d", "shares_7d", "saves_7d", "reach_7d", "impressions_7d", "follows_7d",
  "likes_total", "comments_total", "shares_total", "saves_total", "reach_total", "impressions_total", "follows_total",
  "notes",
];

async function main() {
  console.log("Fetching posts from Instagram API...");
  const media = await ig.getAllMedia();
  console.log(`Found ${media.length} posts\n`);

  // Read existing CSV for manual fields
  const existing = readExistingCSV(CSV_PATH);

  const today = new Date().toISOString().slice(0, 10);
  const rows = [];

  for (const post of media) {
    const postDate = post.timestamp.slice(0, 10);
    const type = mediaType(post.media_type);
    const key = `${postDate}|${type}`;

    console.log(`Fetching insights for ${type} posted ${postDate}...`);
    const insights = await ig.getMediaInsights(post.id);

    // Merge with existing row to preserve manual fields
    const prev = existing.get(key) || {};

    const row = {
      date: postDate,
      platform: "instagram",
      type,
      topic: prev.topic || extractTopic(post.caption),
      folder: prev.folder || "",
      status: prev.status || "published",
      pinned: prev.pinned || "no",
      // 7-day metrics not available via this API endpoint — keep existing
      likes_7d: prev.likes_7d || "",
      comments_7d: prev.comments_7d || "",
      shares_7d: prev.shares_7d || "",
      saves_7d: prev.saves_7d || "",
      reach_7d: prev.reach_7d || "",
      impressions_7d: prev.impressions_7d || "",
      follows_7d: prev.follows_7d || "",
      // Total/lifetime metrics from API
      likes_total: insights?.likes ?? post.like_count ?? "",
      comments_total: insights?.comments ?? post.comments_count ?? "",
      shares_total: insights?.shares ?? "",
      saves_total: insights?.saved ?? "",
      reach_total: insights?.reach ?? "",
      impressions_total: "",  // Not available for Reels/Carousels via this API
      follows_total: "",      // Not available via media insights
      notes: prev.notes
        ? prev.notes.replace(/; metrics updated [^;]*/g, "") +
          `; metrics updated ${today}`
        : `metrics updated ${today}`,
    };
    rows.push(row);
  }

  // Sort by date
  rows.sort((a, b) => a.date.localeCompare(b.date));

  // Write CSV
  const csvLines = [CSV_HEADERS.join(",")];
  for (const row of rows) {
    const line = CSV_HEADERS.map((h) => {
      const val = String(row[h] ?? "");
      // Quote if contains comma or double-quote (RFC 4180)
      return val.includes(",") || val.includes('"')
        ? `"${val.replace(/"/g, '""')}"` : val;
    }).join(",");
    csvLines.push(line);
  }
  csvLines.push(""); // trailing newline

  writeFileSync(CSV_PATH, csvLines.join("\n"));
  console.log(`\nWritten ${rows.length} rows to ${CSV_PATH}`);

  // Print summary table
  console.log("\n=== Metrics Summary ===");
  console.log(
    "Date       | Type      | Reach  | Likes | Comments | Shares | Saves"
  );
  console.log("-".repeat(75));
  for (const r of rows) {
    console.log(
      `${r.date} | ${r.type.padEnd(9)} | ${String(r.reach_total).padStart(6)} | ${String(r.likes_total).padStart(5)} | ${String(r.comments_total).padStart(8)} | ${String(r.shares_total).padStart(6)} | ${String(r.saves_total).padStart(5)}`
    );
  }
}

main().catch((e) => {
  console.error("Fatal error:", e.message);
  process.exit(1);
});
