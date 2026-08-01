#!/usr/bin/env node

// Instagram Webhook Server
// Receives comment events from Meta, matches keywords, sends DMs.
// Also serves the admin dashboard for metrics + keyword management.

import express from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { createClient } from "../lib/instagram.js";
import { getAccessToken, getTokenStatus, maybeRefreshToken } from "../lib/token.js";
import { matchKeyword } from "../lib/keyword-matcher.js";
import { loadKeywordRules, saveKeywordRules, DATA_DIR } from "../config.js";
import { loadSnapshots, saveSnapshots, recordSnapshot, recordAccountSnapshot, computeSummary, computeComparison } from "../lib/snapshots.js";
import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3100;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const APP_SECRET = process.env.IG_APP_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!VERIFY_TOKEN) {
  console.error("Error: WEBHOOK_VERIFY_TOKEN environment variable is required");
  process.exit(1);
}

// IG_ACCESS_TOKEN is only a seed — once the token store in DATA_DIR holds a
// self-refreshed token, the env var may be absent or stale. Fail only if
// neither source has one.
if (!getAccessToken()) {
  console.error(
    "Error: no IG access token available — set IG_ACCESS_TOKEN or restore DATA_DIR/ig-token.json"
  );
  process.exit(1);
}

if (!ADMIN_PASSWORD) {
  if (process.env.RAILWAY_ENVIRONMENT || process.env.DATA_DIR === "/data") {
    console.error("FATAL: ADMIN_PASSWORD is not set in production — refusing to start with unprotected admin routes");
    process.exit(1);
  }
  console.warn("WARNING: ADMIN_PASSWORD is not set — admin routes are unprotected (local dev only)");
}

// --- Webhook signature verification ---
function verifyWebhookSignature(req, _res, buf) {
  if (!APP_SECRET) return;
  // Only verify signature on webhook requests from Meta
  if (!req.path.startsWith("/webhook")) return;
  const sig = req.headers["x-hub-signature-256"];
  if (!sig) throw new Error("Missing webhook signature");
  const expected = "sha256=" + createHmac("sha256", APP_SECRET).update(buf).digest("hex");
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new Error("Invalid webhook signature");
  }
}

// --- Basic auth middleware for admin routes ---
function requireAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return next();
  const header = req.headers.authorization;
  if (header) {
    const [, encoded] = header.match(/^Basic\s+(.+)$/) || [];
    if (encoded) {
      const [, pass] = Buffer.from(encoded, "base64").toString().split(":");
      if (pass === ADMIN_PASSWORD) return next();
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="IG Automations"');
  res.status(401).send("Authentication required");
}

// Getter, not a value: maybeRefreshToken() can swap the token mid-process.
const ig = createClient(getAccessToken);

// --- Dedup store (in-memory with disk persistence) ---
const SENT_LOG_PATH = resolve(DATA_DIR, "sent-dms.json");
const sentCache = new Map();
// message_id (mid) → cache key, for matching async webhook events
// (echoes / read receipts) back to the originating sent record. In-memory
// only — rebuilt from sent-dms.json on startup. If you ever delete records
// from sent-dms.json by hand, the matching mid entries will linger here
// until the next restart (harmless: a stale mid just won't match anything).
const midToKey = new Map();

function saveSentLog() {
  const tmp = SENT_LOG_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(sentCache), null, 2));
  renameSync(tmp, SENT_LOG_PATH);
}

function initSentLog() {
  if (!existsSync(SENT_LOG_PATH)) return;
  let withMid = 0;
  try {
    const saved = JSON.parse(readFileSync(SENT_LOG_PATH, "utf-8"));
    for (const [k, v] of Object.entries(saved)) {
      sentCache.set(k, v);
      // Re-arm the mid index so echoes for DMs sent before the restart
      // still resolve to their record. Records that have a pending_reply
      // but already reached delivery=delivered before the restart will
      // never fire flushPendingReply (echo won't arrive twice) — that
      // reply is permanently stranded. Acceptable edge case at this scale.
      if (v && typeof v === "object" && v.message_id) {
        midToKey.set(v.message_id, k);
        withMid++;
      }
    }
    console.log(`Loaded ${sentCache.size} sent-dm records (${withMid} with message_id for echo matching)`);
  } catch (e) {
    // Without this log, a corrupted sent-dms.json would silently leave
    // sentCache + midToKey empty — every later echo would then "no match"
    // with no obvious cause.
    console.error(`Failed to load ${SENT_LOG_PATH}: ${e.message} — starting with empty caches`);
  }
}

function hasSent(userId, keyword, mediaId) {
  return sentCache.has(`${userId}:${keyword}:${mediaId}`);
}

function markSent(userId, keyword, mediaId, extra = {}) {
  const key = `${userId}:${keyword}:${mediaId}`;
  const rec = {
    status: "sent",
    sent_at: new Date().toISOString(),
    username: extra.username || userId,
    keyword,
    post_date: extra.postDate || "",
    post_type: extra.postType || "",
    message_id: extra.messageId || null,
    // delivery: pending → delivered → read; "untracked" only when Meta
    // didn't return a message_id (very rare). The dashboard collapses
    // both "untracked" and missing-field into a single "Legacy" badge.
    delivery: extra.messageId ? "pending" : "untracked",
  };
  // Optional: a public comment reply queued for posting once the echo
  // webhook confirms the DM was actually emitted (avoids posting a
  // public "sent!" reply when the DM was silently dropped).
  if (extra.pendingReply) rec.pending_reply = extra.pendingReply;
  sentCache.set(key, rec);
  if (extra.messageId) midToKey.set(extra.messageId, key);
  saveSentLog();
}

// Post a deferred public comment reply if one was queued. Cleared on
// every attempt regardless of outcome so a duplicate echo doesn't
// repost. Failures are logged and dropped (matches the original
// inline-post behavior).
//
// Takes both `key` and `rec` and explicitly re-sets the cache after
// mutating. Today this is technically redundant (sentCache.get() returns
// the same reference, so the delete propagates), but the explicit set
// guards against a future copy-on-set refactor of markSent silently
// breaking pending_reply clearing.
async function flushPendingReply(key, rec) {
  if (!rec.pending_reply) return;
  const { comment_id, text } = rec.pending_reply;
  delete rec.pending_reply;
  sentCache.set(key, rec);
  saveSentLog(); // persist cleared state immediately
  try {
    await ig.replyToComment(comment_id, text);
    console.log(`  Comment reply posted (deferred): "${text}"`);
  } catch (e) {
    console.error(`  Comment reply failed: ${e.message}`);
  }
}

// Echo received → Meta processed our outbound DM. `echoTimestamp` is
// when Meta generated the webhook event, not strictly the recipient
// inbox time, but that's the closest signal we get.
function markDelivered(mid, echoTimestamp) {
  const key = midToKey.get(mid);
  if (!key) return false;
  const rec = sentCache.get(key);
  if (!rec) return false;
  if (rec.delivery === "read") return false; // do not downgrade
  rec.delivery = "delivered";
  rec.delivered_at = echoTimestamp;
  saveSentLog();
  return true;
}

// Read receipt — recipient's watermark advances past the DM's send time.
// O(n) full-cache scan per receipt, fine at personal-brand scale (<1k DMs).
// If a viral post ever blows the cache up by ~100x, add a userIdToKeys
// secondary index keyed by the leading userId segment of the cache key.
function markReadByWatermark(recipientUserId, watermarkMs) {
  let updated = 0;
  const watermarkIso = new Date(watermarkMs).toISOString();
  for (const [key, rec] of sentCache) {
    if (!rec || typeof rec !== "object") continue;
    const userId = key.split(":")[0];
    if (userId !== recipientUserId) continue;
    if (rec.delivery === "read") continue;
    if (!rec.sent_at) continue;
    if (new Date(rec.sent_at).getTime() > watermarkMs) continue;
    rec.delivery = "read";
    rec.read_at = watermarkIso;
    updated++;
  }
  if (updated) saveSentLog();
  return updated;
}

// --- Failure tracking store ---
const FAILED_LOG_PATH = resolve(DATA_DIR, "failed-dms.json");
const failCache = new Map();

function initFailLog() {
  if (!existsSync(FAILED_LOG_PATH)) return;
  try {
    const saved = JSON.parse(readFileSync(FAILED_LOG_PATH, "utf-8"));
    for (const [k, v] of Object.entries(saved)) failCache.set(k, v);
  } catch {}
}

// Classify a raw Meta API error object into a human-readable category + label
function classifyDmError(igError) {
  if (!igError) return { category: "unknown", label: "Unknown error" };
  const code = igError?.code;
  const subcode = igError?.error_subcode;
  const msg = (igError?.message || "").toLowerCase();

  if (code === 10 && subcode === 2534022) return { category: "window_expired", label: "Messaging window expired (24h)" };
  if (code === 10)  return { category: "window_expired", label: "Messaging window expired" };
  if (code === 4)   return { category: "rate_limited",   label: "Rate limited / spam protection" };
  if (code === 200) return { category: "permission",     label: "Permission denied" };
  if (code === 3)   return { category: "permission",     label: "Missing permission scope" };
  if (code === 102 || code === 190) return { category: "auth", label: "Token expired or invalid" };
  if (code === 100) return { category: "invalid_params", label: "Invalid parameters" };
  if (msg.includes("block"))    return { category: "user_blocked",     label: "User blocked DMs" };
  if (msg.includes("restrict")) return { category: "user_restricted",  label: "User restricted DMs" };
  return { category: "unknown", label: igError?.message || "Unknown error" };
}

function markFailed(userId, keyword, mediaId, igError, extra = {}) {
  const key = `${userId}:${keyword}:${mediaId}`;
  const { category, label } = classifyDmError(igError);
  failCache.set(key, {
    status: "failed",
    failed_at: new Date().toISOString(),
    username: extra.username || userId,
    keyword,
    post_date: extra.postDate || "",
    post_type: extra.postType || "",
    error_code: igError?.code ?? null,
    error_subcode: igError?.error_subcode ?? null,
    failure_reason: label,
    failure_category: category,
  });
  const tmp = FAILED_LOG_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(failCache), null, 2));
  renameSync(tmp, FAILED_LOG_PATH);
}

// --- Global comment replies ---
const REPLIES_PATH = resolve(DATA_DIR, "comment-replies.json");

function loadCommentReplies() {
  if (!existsSync(REPLIES_PATH)) return [];
  try { return JSON.parse(readFileSync(REPLIES_PATH, "utf-8")); } catch { return []; }
}

function saveCommentReplies(replies) {
  const tmp = REPLIES_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(replies, null, 2));
  renameSync(tmp, REPLIES_PATH);
}

// --- Express app ---
const app = express();
app.use(express.json({ limit: "100kb", verify: verifyWebhookSignature }));

// --- Admin dashboard (auth-protected) ---
app.get("/", requireAuth, (_req, res) => {
  res.sendFile(resolve(__dirname, "admin.html"));
});

// --- Metrics API (auth-protected, fetches live from IG) ---
app.get("/api/metrics", requireAuth, async (_req, res) => {
  try {
    const media = await ig.getAllMedia();
    const results = [];
    for (const post of media) {
      const insights = await ig.getMediaInsights(post.id);
      results.push({
        date: post.timestamp.slice(0, 10),
        type: post.media_type === "VIDEO" ? "reel" : post.media_type === "CAROUSEL_ALBUM" ? "carousel" : "photo",
        topic: (post.caption || "").split("\n")[0].slice(0, 60),
        reach: insights?.reach ?? 0,
        likes: insights?.likes ?? post.like_count ?? 0,
        comments: insights?.comments ?? post.comments_count ?? 0,
        shares: insights?.shares ?? 0,
        saves: insights?.saved ?? 0,
      });
    }
    results.sort((a, b) => a.date.localeCompare(b.date));
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Keyword rules CRUD API (auth-protected) ---
app.get("/api/rules", requireAuth, (_req, res) => {
  res.json(loadKeywordRules());
});

app.post("/api/rules", requireAuth, (req, res) => {
  const rules = loadKeywordRules();
  const { keyword, message, postIds = [], enabled = true } = req.body;
  if (!keyword || !message) return res.status(400).json({ error: "keyword and message required" });
  rules.push({ keyword: keyword.toUpperCase(), postIds, message, enabled });
  saveKeywordRules(rules);
  res.json({ ok: true, index: rules.length - 1 });
});

app.put("/api/rules/:index", requireAuth, (req, res) => {
  const rules = loadKeywordRules();
  const index = parseInt(req.params.index);
  if (index < 0 || index >= rules.length) return res.status(404).json({ error: "not found" });
  const { keyword, message, postIds, enabled } = req.body;
  if (keyword !== undefined) rules[index].keyword = keyword.toUpperCase();
  if (message !== undefined) rules[index].message = message;
  if (postIds !== undefined) rules[index].postIds = postIds;
  if (enabled !== undefined) rules[index].enabled = enabled;
  saveKeywordRules(rules);
  res.json({ ok: true });
});

// --- Global comment replies API (auth-protected) ---
app.get("/api/replies", requireAuth, (_req, res) => {
  res.json(loadCommentReplies());
});

app.put("/api/replies", requireAuth, (req, res) => {
  const { replies } = req.body;
  if (!Array.isArray(replies)) return res.status(400).json({ error: "replies must be an array" });
  const clean = replies.map(String).filter(Boolean);
  saveCommentReplies(clean);
  res.json({ ok: true, count: clean.length });
});

app.delete("/api/rules/:index", requireAuth, (req, res) => {
  const rules = loadKeywordRules();
  const index = parseInt(req.params.index);
  if (index < 0 || index >= rules.length) return res.status(404).json({ error: "not found" });
  rules.splice(index, 1);
  saveKeywordRules(rules);
  res.json({ ok: true });
});

// --- DM Log API (auth-protected) — unified sent + failed ---
app.get("/api/log", requireAuth, (_req, res) => {
  const merged = {};
  // Sent entries (normalize legacy string-timestamp format)
  for (const [k, v] of sentCache) {
    merged[k] = typeof v === "object"
      ? { ...v, status: v.status || "sent" }
      : { status: "sent", sent_at: v, username: k.split(":")[0], keyword: k.split(":")[1], post_date: "", post_type: "" };
  }
  // Failed entries — do not overwrite a successful send with a subsequent failure
  for (const [k, v] of failCache) {
    if (merged[k]?.status === "sent") continue;
    merged[k] = v;
  }
  res.json(merged);
});

// --- Snapshot API (auth-protected) ---
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(s) { return DATE_RE.test(s) ? s : null; }

app.get("/api/snapshots/summary", requireAuth, (req, res) => {
  const store = loadSnapshots();
  const from = validDate(req.query.from) || "2000-01-01";
  const to = validDate(req.query.to) || "2099-12-31";
  res.json(computeSummary(store, from, to));
});

app.get("/api/snapshots/compare", requireAuth, (req, res) => {
  const a_from = validDate(req.query.a_from);
  const a_to = validDate(req.query.a_to);
  const b_from = validDate(req.query.b_from);
  const b_to = validDate(req.query.b_to);
  if (!a_from || !a_to || !b_from || !b_to) {
    return res.status(400).json({ error: "a_from, a_to, b_from, b_to required (YYYY-MM-DD)" });
  }
  const store = loadSnapshots();
  res.json(computeComparison(store, a_from, a_to, b_from, b_to));
});

// --- Token status / manual refresh (auth-protected) ---
// Never returns the token itself, only its expiry metadata.
app.get("/api/token/status", requireAuth, (_req, res) => {
  res.json(getTokenStatus());
});

app.post("/api/token/refresh", requireAuth, async (_req, res) => {
  const result = await maybeRefreshToken({ force: true });
  // refreshed-but-not-extended is not a success: Meta re-issued the token
  // without moving the expiry (it declines to extend tokens under 24h old).
  // 202 rather than 200 so a caller checking status codes doesn't read it as
  // "expiry is now 60 days out".
  const code = !result.refreshed ? 500 : result.extended ? 200 : 202;
  res.status(code).json({ ...result, status: getTokenStatus() });
});

// --- Snapshot trigger (auth-protected, called by Railway cron) ---
// The snapshotRunning mutex blocks concurrent runs but does not throttle
// back-to-back runs. The cron fires hourly (~144 IG-API calls/day at 6
// posts), well under IGAA's ~200/hr cap. Manual triggers via curl bypass
// that assumption — if you script repeated calls in a tight loop you can
// burn the quota. Don't.
let snapshotRunning = false;

app.post("/api/snapshots/run", requireAuth, async (_req, res) => {
  if (snapshotRunning) {
    return res.status(409).json({ error: "Snapshot already running" });
  }
  snapshotRunning = true;
  const today = new Date().toISOString().slice(0, 10);
  console.log(`[${today}] Snapshot triggered via API`);

  try {
    // Piggyback the token refresh on the hourly cron. It's a no-op until the
    // token is within a week of expiring, and it never throws — a refresh
    // failure must not cost us the snapshot.
    await maybeRefreshToken();

    const store = loadSnapshots();

    // Account-level snapshot
    const accountData = await ig.getAccountInsights();
    if (accountData) {
      recordAccountSnapshot(store, accountData);
      console.log(`  Account: ${accountData.followers_count} followers, ${accountData.profile_views} profile views`);
    }

    // Per-post snapshots — recordSnapshot now refreshes today's row on every
    // run (no longer idempotent on date alone), so hourly cron continually
    // updates today's metrics with the latest Meta numbers.
    const media = await ig.getAllMedia();
    let created = 0, refreshed = 0, noData = 0;
    for (const post of media) {
      const insights = await ig.getMediaInsights(post.id, post.media_type);
      const result = recordSnapshot(store, post, insights);
      if (result === "created") created++;
      else if (result === "refreshed") refreshed++;
      else noData++;
    }

    saveSnapshots(store);
    const msg = `Snapshot complete: ${created} created, ${refreshed} refreshed${noData ? `, ${noData} skipped (no data)` : ""}`;
    console.log(`  ${msg}`);

    res.json({ ok: true, date: today, posts: media.length, created, refreshed, no_data: noData, message: msg });
  } catch (e) {
    console.error(`  Snapshot failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  } finally {
    snapshotRunning = false;
  }
});

// --- Webhook verification ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// --- Webhook event handler ---
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  if (body.object !== "instagram") return;

  for (const entry of body.entry || []) {
    // --- Messaging events (echoes + read receipts) ---
    // Delivered via the `messages` and `messaging_seen` webhook fields once
    // those are subscribed in the Meta App config. Both arrive in
    // entry.messaging[] (Messenger-style), distinct from entry.changes[]
    // which carries comment events.
    for (const msg of entry.messaging || []) {
      // Outbound DM echo — confirms Meta processed and emitted the message
      if (msg.message?.is_echo && msg.message?.mid) {
        const ts = msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString();
        const ok = markDelivered(msg.message.mid, ts);
        // Always log — no-match echoes are expected (e.g. echoes for DMs
        // sent before this rollout, manual DMs, or other apps on the same
        // account) but observability matters during initial rollout when
        // we're verifying webhook delivery.
        if (ok) {
          console.log(`  Echo → delivered: ${msg.message.mid}`);
          // Echo confirms the DM is in the recipient's conversation —
          // safe to post the deferred public comment reply now.
          const key = midToKey.get(msg.message.mid);
          const rec = key ? sentCache.get(key) : null;
          if (key && rec) await flushPendingReply(key, rec);
        } else {
          console.log(`  Echo → no matching DM record for mid: ${msg.message.mid}`);
        }
        continue;
      }
      // Read receipt — recipient's read watermark advanced
      if (msg.read?.watermark && msg.sender?.id) {
        const updated = markReadByWatermark(msg.sender.id, msg.read.watermark);
        if (updated) console.log(`  Read receipt from ${msg.sender.id}: ${updated} DM(s) marked read`);
        continue;
      }
    }

    if (!entry.changes) continue;

    for (const change of entry.changes) {
      if (change.field !== "comments") continue;

      const { id: commentId, text, from, media } = change.value;
      const commenterId = from?.id;
      const commenterUsername = from?.username;
      const mediaId = media?.id;

      if (!text || !commenterId || !commentId) continue;

      console.log(
        `Comment from @${commenterUsername}: "${text}" on media ${mediaId} (comment ${commentId})`
      );

      const rule = matchKeyword(text, mediaId);
      if (!rule) {
        console.log(`  No keyword match`);
        continue;
      }

      console.log(`  Matched keyword: ${rule.keyword}`);

      if (hasSent(commenterId, rule.keyword, mediaId)) {
        console.log(`  Already sent DM to @${commenterUsername} — skipping`);
        continue;
      }

      // Look up post info from snapshots for the DM log
      const store = loadSnapshots();
      const postData = store[mediaId];
      const postType = postData?.media_type === "VIDEO" ? "reel"
        : postData?.media_type === "CAROUSEL_ALBUM" ? "carousel"
        : postData ? "photo" : "";
      const extra = {
        username: commenterUsername,
        postDate: postData?.posted_at || "",
        postType,
      };

      try {
        const result = await ig.sendPrivateReply(commentId, rule.message);
        const messageId = result?.message_id;

        // Pre-pick the public reply text so it can be persisted with
        // the sent record and posted later (after the echo confirms
        // delivery). This avoids posting "Sent! 📩" publicly when the
        // DM is silently dropped because the recipient has DMs off.
        const replies = loadCommentReplies();
        const replyText = replies.length > 0
          ? replies[Math.floor(Math.random() * replies.length)]
          : null;

        const sentExtra = { ...extra, messageId };
        // If we have both a reply and a message_id, defer the post
        // until the echo arrives. If we have a reply but no message_id
        // (rare — Meta didn't return one), there's no echo to wait for,
        // so post immediately so we don't drop the reply entirely.
        if (replyText && messageId) {
          sentExtra.pendingReply = { comment_id: commentId, text: replyText };
        }
        markSent(commenterId, rule.keyword, mediaId, sentExtra);
        const replyMode = !replyText ? "none"
          : messageId ? "deferred"
          : "posting now";
        console.log(`  DM sent to @${commenterUsername} (mid: ${messageId || "n/a"}, reply: ${replyMode})`);

        if (replyText && !messageId) {
          try {
            await ig.replyToComment(commentId, replyText);
            console.log(`  Comment reply posted (no mid for deferral): "${replyText}"`);
          } catch (e) {
            console.error(`  Comment reply failed: ${e.message}`);
          }
        }
      } catch (e) {
        markFailed(commenterId, rule.keyword, mediaId, e.igError || null, extra);
        console.error(`  DM failed for @${commenterUsername}: ${e.message}`);
      }
    }
  }
});

initSentLog();
initFailLog();
app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);

  // Refresh on boot as well as hourly, so a freshly pasted seed token gets its
  // expiry recorded straight away rather than waiting for the next cron tick.
  await maybeRefreshToken();
  const status = getTokenStatus();
  if (status.expired) {
    console.error("  IG token has EXPIRED — re-authorize in the Meta App Dashboard and update IG_ACCESS_TOKEN");
  } else if (status.days_remaining !== null) {
    console.log(`  IG token valid for ${status.days_remaining} more days (expires ${status.expires_at.slice(0, 10)})`);
  } else {
    console.log("  IG token expiry unknown — will be recorded after the first successful refresh");
  }
});
