// Daily snapshot store for age-based post performance tracking.
// Each cron run appends one snapshot per post (date → metrics).
// Snapshots accumulate in DATA_DIR/snapshots.json.

import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { resolve } from "path";
import { DATA_DIR } from "../config.js";

const SNAPSHOTS_PATH = resolve(DATA_DIR, "snapshots.json");

// --- Read / Write ---

export function loadSnapshots() {
  if (!existsSync(SNAPSHOTS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SNAPSHOTS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export function saveSnapshots(data) {
  const tmp = SNAPSHOTS_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, SNAPSHOTS_PATH);
}

// --- Record a daily snapshot for one post ---

// Returns one of:
//   "created"   — first snapshot ever for this post on today's date
//   "refreshed" — overwrote today's snapshot with newer numbers
//   "no_data"   — insights API failed; skipped to avoid clobbering good
//                 data with zeros (an earlier run today may have succeeded)
//
// Past-date snapshots are never touched — only today's row gets refreshed.
// This lets the cron run hourly and continually update today's metrics
// without growing storage and without violating the milestone-age model
// (Day 1 / Day 3 / Day 7 reads still resolve to a single value per day).
export function recordSnapshot(store, post, insights) {
  const today = new Date().toISOString().slice(0, 10);
  const id = post.id;

  // Guard: if insights call failed, do NOT overwrite an earlier successful
  // snap for today with zeros, and do NOT create an empty store entry for
  // a brand-new post. The next hourly run will retry from scratch.
  if (!insights) return "no_data";

  if (!store[id]) {
    store[id] = {
      posted_at: post.timestamp.slice(0, 10),
      media_type: post.media_type,
      caption_preview: (post.caption || "").split("\n")[0].slice(0, 60),
      permalink: post.permalink || "",
      snapshots: {},
    };
  }

  // Update metadata in case caption was edited
  store[id].caption_preview = (post.caption || "").split("\n")[0].slice(0, 60);

  const isRefresh = !!store[id].snapshots[today];

  const snap = {
    reach: insights?.reach ?? 0,
    likes: insights?.likes ?? post.like_count ?? 0,
    comments: insights?.comments ?? post.comments_count ?? 0,
    shares: insights?.shares ?? 0,
    saves: insights?.saved ?? 0,
    // views is universal in v22.0+ but historical Carousel/Photo snapshots
    // (taken before this field was promoted out of the VIDEO block) won't
    // have it. Callers aggregating views across non-Reel types must tolerate
    // missing keys in old snapshots.
    views: insights?.views ?? 0,
  };

  // Reel-specific metrics (VIDEO only)
  if (post.media_type === "VIDEO") {
    // API returns watch time in milliseconds — convert to seconds
    snap.avg_watch_time = insights?.ig_reels_avg_watch_time
      ? +(insights.ig_reels_avg_watch_time / 1000).toFixed(1)
      : 0;
    snap.total_watch_time = insights?.ig_reels_video_view_total_time
      ? Math.round(insights.ig_reels_video_view_total_time / 1000)
      : 0;
    // skip_rate is returned in PERCENT units (0–100), not decimal 0–1.
    // Confirmed by API call 2026-05-01: a Reel with mobile-dashboard skip
    // rate of 36.7% returns {"value": 36.7}. Stored as-is.
    // Preserve null when withheld: Meta withholds this metric on low-reach
    // Reels, and we want period-average computation to exclude those rather
    // than treat "withheld" as "0% skip". Downstream rate aggregation must
    // explicitly filter nulls.
    snap.skip_rate = insights?.reels_skip_rate ?? null;
  }

  store[id].snapshots[today] = snap;

  return isRefresh ? "refreshed" : "created";
}

// --- Account-level snapshot ---

// Same refresh semantics as recordSnapshot: today's row always overwrites,
// past dates frozen. Returns "created" | "refreshed" | "no_data".
//
// Skip on missing followers_count specifically — it's the load-bearing
// field for the dashboard's growth chart, and a partial API response
// (object present, fields undefined) would otherwise silently overwrite
// good data with zeros. profile_views and media_count tolerate 0 as a
// legitimate value, so just default those.
export function recordAccountSnapshot(store, accountData) {
  const today = new Date().toISOString().slice(0, 10);
  if (!accountData || typeof accountData.followers_count !== "number") return "no_data";
  if (!store._account) store._account = {};
  const isRefresh = !!store._account[today];
  store._account[today] = {
    followers_count: accountData.followers_count,
    profile_views: accountData.profile_views ?? 0,
    media_count: accountData.media_count ?? 0,
  };
  return isRefresh ? "refreshed" : "created";
}

// --- Age-based milestone computation ---

const MILESTONES = [
  { key: "day_1", days: 1 },
  { key: "day_3", days: 3 },
  { key: "day_7", days: 7 },
  { key: "day_30", days: 30 },
];

// Find the snapshot closest to a target date (within ±1 day tolerance)
function findSnapshotAt(snapshots, targetDate) {
  const target = new Date(targetDate).getTime();
  let best = null;
  let bestDist = Infinity;

  for (const [date, metrics] of Object.entries(snapshots)) {
    const dist = Math.abs(new Date(date).getTime() - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = metrics;
    }
  }

  // Allow ±2 days tolerance (accounts for HKT evening posts + cron timing)
  if (bestDist > 2 * 86400000) return null;
  return best;
}

function engagementRate(m) {
  if (!m || !m.reach) return 0;
  return ((m.likes + m.comments + m.saves + m.shares) / m.reach) * 100;
}

// Per-snapshot engagement rates as percent (0–100), keyed in IG's mobile-dashboard
// priority order. Returns null for any rate when the denominator (views) is 0
// or missing — this avoids divide-by-zero noise in pre-Phase-1 carousel snapshots
// that lack the views field. skip_rate is only populated for Reels (the
// reels_skip_rate API field doesn't exist for Carousels/Photos).
function snapshotRates(snap, isReel) {
  if (!snap) return null;
  const v = snap.views || 0;
  const rate = (action) => (v ? +(((action || 0) / v) * 100).toFixed(2) : null);
  return {
    skip_rate:    isReel ? (snap.skip_rate ?? null) : null,
    share_rate:   rate(snap.shares),
    like_rate:    rate(snap.likes),
    save_rate:    rate(snap.saves),
    comment_rate: rate(snap.comments),
  };
}

function computeMilestones(postData) {
  const { posted_at, snapshots, media_type } = postData;
  const isReel = media_type === "VIDEO";
  const result = {};

  const now = new Date();
  for (const { key, days } of MILESTONES) {
    const targetDate = new Date(posted_at);
    targetDate.setDate(targetDate.getDate() + days);
    // Only show milestone if the post has actually reached that age
    if (now < targetDate) {
      result[key] = null;
      continue;
    }
    const snap = findSnapshotAt(snapshots, targetDate.toISOString().slice(0, 10));
    if (snap) {
      result[key] = {
        ...snap,
        eng_rate: +engagementRate(snap).toFixed(2),
        rates: snapshotRates(snap, isReel),
      };
    } else {
      result[key] = null;
    }
  }

  // Lifetime = latest snapshot
  const dates = Object.keys(snapshots).sort();
  if (dates.length) {
    const latest = snapshots[dates[dates.length - 1]];
    result.lifetime = {
      ...latest,
      eng_rate: +engagementRate(latest).toFixed(2),
      rates: snapshotRates(latest, isReel),
    };
  } else {
    result.lifetime = null;
  }

  return result;
}

// --- Media type helper ---

function mediaType(igType) {
  switch (igType) {
    case "VIDEO": return "reel";
    case "CAROUSEL_ALBUM": return "carousel";
    case "IMAGE": return "photo";
    default: return (igType || "unknown").toLowerCase();
  }
}

// --- Summary for a date range ---

export function computeSummary(store, from, to) {
  const posts = [];

  for (const [id, data] of Object.entries(store)) {
    if (id === "_account") continue;
    if (data.posted_at < from || data.posted_at > to) continue;
    const milestones = computeMilestones(data);
    posts.push({
      id,
      posted_at: data.posted_at,
      type: mediaType(data.media_type),
      topic: data.caption_preview,
      permalink: data.permalink,
      milestones,
    });
  }

  posts.sort((a, b) => b.posted_at.localeCompare(a.posted_at));

  // Single pass over posts to populate three accumulator buckets:
  //   - totals: raw sums for ALL posts with a lifetime snapshot (drives averages
  //     + the legacy engagement_rate which still uses reach as denominator)
  //   - skip: simple average of per-Reel reels_skip_rate, excluding nulls
  //     (Meta withholds skip_rate on low-reach Reels — treating "withheld"
  //     as "0%" would skew the period average toward optimistic)
  //   - rate*: view-weighted accumulators for share/like/save/comment, using
  //     ONLY posts where views > 0. Posts without views (pre-Phase-1
  //     Carousels/Photos) are excluded from both numerator and denominator —
  //     attributing their raw actions to a 0-view denominator would inflate
  //     the period rate.
  const totals = { reach: 0, likes: 0, comments: 0, shares: 0, saves: 0, views: 0 };
  let postsWithData = 0;
  let sumSkip = 0, skipCount = 0;
  let rateViews = 0, rateShares = 0, rateLikes = 0, rateSaves = 0, rateComments = 0;
  for (const p of posts) {
    const lt = p.milestones.lifetime;
    if (!lt) continue;
    postsWithData++;
    totals.reach    += lt.reach;
    totals.likes    += lt.likes;
    totals.comments += lt.comments;
    totals.shares   += lt.shares;
    totals.saves    += lt.saves;
    totals.views    += lt.views || 0;

    if (p.type === "reel" && lt.skip_rate != null) {
      sumSkip += lt.skip_rate;
      skipCount++;
    }
    const v = lt.views || 0;
    if (v) {
      rateViews    += v;
      rateShares   += lt.shares   || 0;
      rateLikes    += lt.likes    || 0;
      rateSaves    += lt.saves    || 0;
      rateComments += lt.comments || 0;
    }
  }

  const n = postsWithData || 1;
  const avgEngRate = totals.reach
    ? ((totals.likes + totals.comments + totals.saves + totals.shares) / totals.reach) * 100
    : 0;

  const averages = {
    reach: Math.round(totals.reach / n),
    likes: Math.round(totals.likes / n),
    comments: Math.round(totals.comments / n),
    shares: Math.round(totals.shares / n),
    saves: Math.round(totals.saves / n),
    views: Math.round(totals.views / n),
    engagement_rate: +avgEngRate.toFixed(2),
  };

  // Five rates in IG mobile-dashboard priority order, all percent (0–100).
  const periodRate = (action) =>
    rateViews ? +((action / rateViews) * 100).toFixed(2) : null;
  const engagement_rates = {
    skip_rate:    skipCount ? +(sumSkip / skipCount).toFixed(2) : null,
    share_rate:   periodRate(rateShares),
    like_rate:    periodRate(rateLikes),
    save_rate:    periodRate(rateSaves),
    comment_rate: periodRate(rateComments),
  };

  // By content type
  const byType = {};
  for (const p of posts) {
    const lt = p.milestones.lifetime;
    if (!lt) continue;
    if (!byType[p.type]) byType[p.type] = { count: 0, reach: 0, eng_sum: 0, saves: 0 };
    const t = byType[p.type];
    t.count++;
    t.reach += lt.reach;
    t.eng_sum += lt.eng_rate;
    t.saves += lt.saves;
  }
  for (const [type, t] of Object.entries(byType)) {
    byType[type] = {
      count: t.count,
      avg_reach: Math.round(t.reach / t.count),
      avg_eng: +(t.eng_sum / t.count).toFixed(2),
      avg_saves: Math.round(t.saves / t.count),
    };
  }

  // By age — averages broken down by post type so reels are compared to reels,
  // carousels to carousels, etc. Now also includes per-rate averages used by
  // Table B to color-code each post's rates vs the period average.
  const byAge = {};
  for (const mk of ["day_1", "day_3", "day_7", "day_30", "lifetime"]) {
    const withData = posts.filter((p) => p.milestones[mk] && p.milestones[mk].reach > 0);
    if (!withData.length) {
      byAge[mk] = null;
      continue;
    }
    // Group by type. Reach/saves/eng aggregations use all withData posts.
    // Rate aggregations (views/shares/likes/etc) include only posts with
    // views > 0 — same exclusion as the period-level engagement_rates, so
    // pre-Phase-1 carousels without views don't inflate the rate numerator.
    const byType = {};
    for (const p of withData) {
      if (!byType[p.type]) {
        byType[p.type] = {
          reach: 0, saves: 0, eng_sum: 0, count: 0,
          rate_views: 0, rate_shares: 0, rate_likes: 0, rate_saves: 0, rate_comments: 0,
          skip_sum: 0, skip_count: 0,
        };
      }
      const m = p.milestones[mk];
      const t = byType[p.type];
      // t.{reach,saves,eng_sum} drive avg_reach/avg_saves/avg_eng — denominator
      // is `t.count` (all posts at this milestone). Same metric (saves) is
      // accumulated separately into `t.rate_saves` below for the rate
      // computation, where the denominator is `t.rate_views` (views-only
      // posts). Two accumulators by design — don't dedupe.
      t.reach += m.reach;
      t.saves += m.saves;
      t.eng_sum += m.eng_rate;
      t.count++;
      if (p.type === "reel" && m.skip_rate != null) {
        t.skip_sum += m.skip_rate;
        t.skip_count++;
      }
      const v = m.views || 0;
      if (v) {
        t.rate_views    += v;
        t.rate_shares   += m.shares   || 0;
        t.rate_likes    += m.likes    || 0;
        t.rate_saves    += m.saves    || 0;
        t.rate_comments += m.comments || 0;
      }
    }
    byAge[mk] = {};
    for (const [type, s] of Object.entries(byType)) {
      const rate = (action) =>
        s.rate_views ? +((action / s.rate_views) * 100).toFixed(2) : null;
      byAge[mk][type] = {
        avg_reach: Math.round(s.reach / s.count),
        avg_eng: +(s.eng_sum / s.count).toFixed(2),
        avg_saves: Math.round(s.saves / s.count),
        posts_with_data: s.count,
        avg_rates: {
          skip_rate:    s.skip_count ? +(s.skip_sum / s.skip_count).toFixed(2) : null,
          share_rate:   rate(s.rate_shares),
          like_rate:    rate(s.rate_likes),
          save_rate:    rate(s.rate_saves),
          comment_rate: rate(s.rate_comments),
        },
      };
    }
  }

  // Reel-specific averages
  const reels = posts.filter(p => p.type === "reel");
  let reelStats = null;
  if (reels.length) {
    let totalViews = 0, totalWatchTime = 0, reelCount = 0;
    for (const r of reels) {
      const lt = r.milestones.lifetime;
      if (!lt) continue;
      reelCount++;
      totalViews += lt.views || 0;
      totalWatchTime += lt.avg_watch_time || 0;
    }
    const rc = reelCount || 1;
    reelStats = {
      count: reelCount,
      avg_views: Math.round(totalViews / rc),
      avg_watch_time_sec: +(totalWatchTime / rc).toFixed(1),
    };
  }

  // All account snapshots — chart always shows full growth history regardless of post date filter
  const account = { ...(store._account || {}) };

  return {
    period: { from, to },
    posts_count: posts.length,
    totals,
    averages,
    engagement_rates,
    by_type: byType,
    by_age: byAge,
    reel_stats: reelStats,
    account,
    posts,
  };
}

// --- Two-period comparison ---

export function computeComparison(store, aFrom, aTo, bFrom, bTo) {
  const a = computeSummary(store, aFrom, aTo);
  const b = computeSummary(store, bFrom, bTo);

  function pctChange(current, previous) {
    if (!previous) return null;
    return +(((current - previous) / previous) * 100).toFixed(1);
  }
  // Rate deltas in percentage points (current - previous), preserving null
  // when either side is missing (e.g. a period with no Reels has no skip_rate).
  function ppDelta(current, previous) {
    if (current == null || previous == null) return null;
    return +(current - previous).toFixed(2);
  }

  const ar = a.engagement_rates;
  const br = b.engagement_rates;

  return {
    period_a: a,
    period_b: b,
    changes: {
      posts: a.posts_count - b.posts_count,
      avg_reach: pctChange(a.averages.reach, b.averages.reach),
      avg_views: pctChange(a.averages.views, b.averages.views),
      total_views: pctChange(a.totals.views, b.totals.views),
      engagement_rate: +(a.averages.engagement_rate - b.averages.engagement_rate).toFixed(2),
      avg_saves: pctChange(a.averages.saves, b.averages.saves),
      avg_shares: pctChange(a.averages.shares, b.averages.shares),
      // New engagement-rate deltas in percentage points (IG priority order)
      skip_rate_pp:    ppDelta(ar.skip_rate,    br.skip_rate),
      share_rate_pp:   ppDelta(ar.share_rate,   br.share_rate),
      like_rate_pp:    ppDelta(ar.like_rate,    br.like_rate),
      save_rate_pp:    ppDelta(ar.save_rate,    br.save_rate),
      comment_rate_pp: ppDelta(ar.comment_rate, br.comment_rate),
    },
  };
}
