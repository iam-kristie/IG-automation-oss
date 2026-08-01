// IG access token store with self-refresh.
//
// Why this exists: IGAA long-lived tokens last 60 days and can only be
// refreshed while still valid. Once expired there is no recovery — you have to
// re-authorize by hand in the Meta App Dashboard (this happened 2026-07-31).
// Refreshing on a schedule rolls the expiry forward indefinitely.
//
// Railway env vars are immutable at runtime, so a refreshed token cannot be
// written back to IG_ACCESS_TOKEN. The live token therefore lives in the
// persistent volume (DATA_DIR/ig-token.json) and the env var is only a seed.
//
// Precedence (see resolveSeed): the env var wins whenever it *changes*, so
// pasting a fresh token into Railway always takes effect. As long as it stays
// the same, the refreshed token in the store wins — otherwise every restart
// would roll back to the stale seed.

import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { resolve } from "path";
import { DATA_DIR } from "../config.js";

const TOKEN_PATH = resolve(DATA_DIR, "ig-token.json");
const REFRESH_BASE = "https://graph.instagram.com/refresh_access_token";

// Refresh once the token has less than this long to live. 7 days gives ~168
// hourly attempts before expiry, so a stretch of API failures can't quietly
// run out the clock.
export const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

// Meta rejects refreshes on tokens younger than 24h, and an unknown expiry
// makes us attempt on every run. Don't retry more than hourly either way.
const MIN_ATTEMPT_INTERVAL_MS = 60 * 60 * 1000;

// --- Pure helpers (exported for tests) ---

// Decide which token to treat as current given the env var and stored state.
// Returns { token, reseed } — reseed means the store must be rewritten.
export function resolveSeed(envToken, state) {
  if (!state?.access_token) {
    // Nothing stored yet: env is the only source.
    return envToken ? { token: envToken, reseed: true } : { token: null, reseed: false };
  }
  if (envToken && envToken !== state.seed_token) {
    // Operator pasted a new token into the environment — that always wins,
    // including when the stored one is a refresh descended from the old seed.
    return { token: envToken, reseed: true };
  }
  // Env unchanged (or absent): keep whatever we last refreshed to.
  return { token: state.access_token, reseed: false };
}

// Should we attempt a refresh right now?
// Returns { due: boolean, reason: string }.
export function shouldRefresh(state, now) {
  if (!state?.access_token) return { due: false, reason: "no_token" };

  const lastAttempt = state.last_attempt_at ? Date.parse(state.last_attempt_at) : null;
  if (lastAttempt !== null && !Number.isNaN(lastAttempt) && now - lastAttempt < MIN_ATTEMPT_INTERVAL_MS) {
    return { due: false, reason: "attempted_recently" };
  }

  const expiresAt = state.expires_at ? Date.parse(state.expires_at) : null;
  if (expiresAt === null || Number.isNaN(expiresAt)) {
    // Freshly seeded token — we don't know its expiry until Meta tells us in a
    // refresh response, so attempt one to find out.
    return { due: true, reason: "expiry_unknown" };
  }
  if (expiresAt <= now) {
    // Already dead. Refreshing cannot revive it; only a manual re-auth can.
    return { due: false, reason: "expired" };
  }
  if (expiresAt - now <= REFRESH_THRESHOLD_MS) {
    return { due: true, reason: "expiring_soon" };
  }
  return { due: false, reason: "not_due" };
}

// --- Persistence ---

let storeWasCorrupt = false;

function readState() {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));
  } catch (e) {
    // Falling back to the env seed keeps the integration alive, but that seed
    // is usually the token from initial setup and may itself be long expired —
    // i.e. this can silently recreate the very outage this module prevents.
    // Shout about it, and keep the bad file for manual recovery of the token.
    storeWasCorrupt = true;
    console.error(
      `  ALERT: token store is CORRUPT (${e.message}). Falling back to the IG_ACCESS_TOKEN seed, ` +
        `which may already be expired. Check GET /api/token/status and re-authorize if needed.`
    );
    try {
      renameSync(TOKEN_PATH, `${TOKEN_PATH}.corrupt`);
      console.error(`  Corrupt store preserved at ${TOKEN_PATH}.corrupt`);
    } catch (renameErr) {
      console.error(`  Could not preserve corrupt store: ${renameErr.message}`);
    }
    return null;
  }
}

// Atomic write, matching the snapshots store: a crash mid-write must not leave
// a truncated token file, since that would take the whole integration down.
function writeState(state) {
  const tmp = `${TOKEN_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, TOKEN_PATH);
}

// Slack when comparing old vs new expiry: a genuine extension moves the clock
// by weeks, so anything under an hour means Meta re-issued without extending.
const EXTENSION_EPSILON_MS = 60 * 60 * 1000;

// Meta rejects refreshes on tokens younger than 24h. That makes a manual
// POST /api/token/refresh predictably fail right after a rotation, with only
// Meta's generic message to go on. Explain it rather than leaving the operator
// to wonder whether the token is broken.
const TOKEN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

function rejectionHint(state) {
  const since = state.refreshed_at ? Date.parse(state.refreshed_at) : null;
  if (since === null || Number.isNaN(since)) return null;
  const age = Date.now() - since;
  if (age >= TOKEN_MIN_AGE_MS) return null;
  const hours = Math.max(1, Math.ceil((TOKEN_MIN_AGE_MS - age) / 3600000));
  return `This token was refreshed ${Math.floor(age / 3600000)}h ago. Meta rejects refreshes on tokens under 24h old — try again in ~${hours}h. The current token is still usable meanwhile.`;
}

// Record a failed attempt without ever throwing: maybeRefreshToken() is called
// from the server's boot path and from the snapshot handler, neither of which
// should die because the token file couldn't be written.
function recordFailure(state, message) {
  state.last_error = message;
  try {
    writeState(state);
  } catch (e) {
    console.error(`  Could not persist token refresh failure: ${e.message}`);
  }
  console.error(`  Token refresh failed: ${message}`);
}

let cached = null;

function loadState() {
  if (cached) return cached;
  const stored = readState();
  const envToken = process.env.IG_ACCESS_TOKEN || null;
  const { token, reseed } = resolveSeed(envToken, stored);

  if (reseed) {
    cached = {
      access_token: token,
      seed_token: token,
      // Unknown until the first successful refresh reports expires_in.
      expires_at: null,
      refreshed_at: null,
      last_attempt_at: null,
      source: "env",
    };
    writeState(cached);
    console.log("  Token store seeded from IG_ACCESS_TOKEN");
  } else {
    cached = stored;
  }
  return cached;
}

// --- Public API ---

// Current token. Passed to createClient as a getter so a refresh takes effect
// without restarting the process.
export function getAccessToken() {
  return loadState()?.access_token || null;
}

export function getTokenStatus() {
  const state = loadState();
  if (!state?.access_token) return { present: false };
  const expiresAt = state.expires_at ? Date.parse(state.expires_at) : null;
  const valid = expiresAt !== null && !Number.isNaN(expiresAt);
  return {
    present: true,
    source: state.source,
    expires_at: state.expires_at,
    days_remaining: valid ? Math.floor((expiresAt - Date.now()) / 86400000) : null,
    expired: valid ? expiresAt <= Date.now() : null,
    refreshed_at: state.refreshed_at,
    last_attempt_at: state.last_attempt_at,
    last_error: state.last_error || null,
    // Surfaced so a corrupt store shows up in ops checks rather than only in logs.
    store_was_corrupt: storeWasCorrupt,
  };
}

// Refresh if due. Never throws: a failed refresh must not take down the
// snapshot run that called it. Returns a result object for logging/HTTP.
//
// Concurrent callers share one in-flight refresh. Without this, two forced
// refreshes (admin double-click, or a manual trigger racing the hourly cron)
// would both send the *same* old token to Meta and the slower reply would win,
// making the stored result nondeterministic.
let inFlight = null;

export async function maybeRefreshToken(opts = {}) {
  if (inFlight) return inFlight;
  inFlight = doRefresh(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doRefresh({ force = false } = {}) {
  const state = loadState();
  if (!state?.access_token) return { refreshed: false, reason: "no_token" };

  const check = shouldRefresh(state, Date.now());
  if (!force && !check.due) return { refreshed: false, reason: check.reason };

  state.last_attempt_at = new Date().toISOString();

  try {
    const url = new URL(REFRESH_BASE);
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", state.access_token);
    const res = await fetch(url);
    const data = await res.json();

    // Validate the whole response before touching state. `state` is the live
    // cached object, so a half-applied update would leave the new token in use
    // while we report failure — the worst of both outcomes.
    const expiresIn = Number(data.expires_in);
    const invalid =
      data.error?.message ||
      (!data.access_token ? "no access_token in refresh response" : null) ||
      (!Number.isFinite(expiresIn) || expiresIn <= 0
        ? `invalid expires_in in refresh response: ${JSON.stringify(data.expires_in)}`
        : null);

    if (invalid) {
      recordFailure(state, invalid);
      return { refreshed: false, reason: "error", error: invalid, hint: rejectionHint(state) };
    }

    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const previousExpiry = state.expires_at ? Date.parse(state.expires_at) : null;

    state.access_token = data.access_token;
    state.expires_at = expiresAt;
    state.refreshed_at = new Date().toISOString();
    state.source = "refresh";
    state.last_error = null;
    // seed_token deliberately unchanged: it records which env value this chain
    // descends from, so an unchanged env var won't clobber the refresh.
    writeState(state);

    // Meta returns 200 with a new token even when it declines to extend the
    // grant (observed 2026-08-01 on a 20-minute-old token: expiry came back
    // unchanged). Treating that as success would let the token quietly run out
    // despite "successful" refreshes, so report whether the clock actually moved.
    const extended =
      previousExpiry === null ||
      Number.isNaN(previousExpiry) ||
      Date.parse(expiresAt) - previousExpiry > EXTENSION_EPSILON_MS;

    const days = Math.floor(expiresIn / 86400);
    if (extended) {
      console.log(`  Token refreshed — valid for ${days} more days (until ${expiresAt.slice(0, 10)})`);
    } else {
      console.warn(
        `  Token refreshed but expiry did NOT move (still ${expiresAt.slice(0, 10)}). ` +
          `Meta declines to extend tokens under 24h old; will retry on the next run.`
      );
    }
    return { refreshed: true, extended, expires_at: expiresAt, days_remaining: days };
  } catch (e) {
    recordFailure(state, e.message);
    return { refreshed: false, reason: "error", error: e.message, hint: rejectionHint(state) };
  }
}

// Test seam — drops the in-memory cache so the next call re-reads from disk.
export function _resetCache() {
  cached = null;
  inFlight = null;
  storeWasCorrupt = false;
}
