#!/usr/bin/env node

// Daily Snapshot Runner
// Fetches all posts + insights from IG API, appends today's snapshot.
// Designed to run as a Railway cron service writing to shared volume.
// Usage: node metrics/snapshot.js

import { createClient } from "../lib/instagram.js";
import { getAccessToken, maybeRefreshToken } from "../lib/token.js";
import { loadSnapshots, saveSnapshots, recordSnapshot, recordAccountSnapshot } from "../lib/snapshots.js";

if (!getAccessToken()) {
  console.error("Error: no IG access token available — set IG_ACCESS_TOKEN or restore DATA_DIR/ig-token.json");
  process.exit(1);
}

await maybeRefreshToken();
const ig = createClient(getAccessToken);

async function run() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`[${today}] Starting daily snapshot...`);

  const store = loadSnapshots();
  const media = await ig.getAllMedia();
  console.log(`Fetched ${media.length} posts`);

  // Account-level snapshot (followers, profile views)
  const accountData = await ig.getAccountInsights();
  if (accountData) {
    recordAccountSnapshot(store, accountData);
    console.log(`Account: ${accountData.followers_count} followers, ${accountData.profile_views} profile views today`);
  }

  // Per-post snapshots
  let created = 0, refreshed = 0, noData = 0;
  for (const post of media) {
    const insights = await ig.getMediaInsights(post.id, post.media_type);
    const result = recordSnapshot(store, post, insights);
    if (result === "created") created++;
    else if (result === "refreshed") refreshed++;
    else noData++;
  }

  saveSnapshots(store);
  console.log(`Snapshot complete: ${created} created, ${refreshed} refreshed${noData ? `, ${noData} skipped (no data)` : ""}`);
}

run().catch((e) => {
  console.error("Fatal error:", e.message);
  process.exit(1);
});
