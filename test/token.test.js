import { test } from "node:test";
import assert from "node:assert";
import { resolveSeed, shouldRefresh, REFRESH_THRESHOLD_MS } from "../lib/token.js";

const NOW = Date.parse("2026-08-01T12:00:00Z");
const iso = (msFromNow) => new Date(NOW + msFromNow).toISOString();
const DAY = 86400000;

// --- resolveSeed: which token wins ---

test("seeds from env when nothing is stored", () => {
  assert.deepStrictEqual(resolveSeed("IGAA_new", null), { token: "IGAA_new", reseed: true });
});

test("no token at all when env is empty and nothing stored", () => {
  assert.deepStrictEqual(resolveSeed(null, null), { token: null, reseed: false });
});

test("keeps the refreshed token when env is unchanged", () => {
  // The critical case: without seed_token tracking, every restart would roll
  // back from the refreshed token to the stale env seed.
  const state = { access_token: "IGAA_refreshed", seed_token: "IGAA_seed" };
  assert.deepStrictEqual(resolveSeed("IGAA_seed", state), {
    token: "IGAA_refreshed",
    reseed: false,
  });
});

test("env override wins when the operator pastes a new token", () => {
  const state = { access_token: "IGAA_refreshed", seed_token: "IGAA_seed" };
  assert.deepStrictEqual(resolveSeed("IGAA_manual", state), {
    token: "IGAA_manual",
    reseed: true,
  });
});

test("keeps the stored token when env is absent entirely", () => {
  const state = { access_token: "IGAA_refreshed", seed_token: "IGAA_seed" };
  assert.deepStrictEqual(resolveSeed(null, state), {
    token: "IGAA_refreshed",
    reseed: false,
  });
});

// --- shouldRefresh: when to call Meta ---

test("not due when the token has plenty of life left", () => {
  const state = { access_token: "t", expires_at: iso(50 * DAY) };
  assert.deepStrictEqual(shouldRefresh(state, NOW), { due: false, reason: "not_due" });
});

test("due once inside the refresh threshold", () => {
  const state = { access_token: "t", expires_at: iso(REFRESH_THRESHOLD_MS - DAY) };
  assert.deepStrictEqual(shouldRefresh(state, NOW), { due: true, reason: "expiring_soon" });
});

test("due when expiry is unknown, so the first run learns it", () => {
  const state = { access_token: "t", expires_at: null };
  assert.deepStrictEqual(shouldRefresh(state, NOW), { due: true, reason: "expiry_unknown" });
});

test("not due once already expired — refresh cannot revive it", () => {
  const state = { access_token: "t", expires_at: iso(-DAY) };
  assert.deepStrictEqual(shouldRefresh(state, NOW), { due: false, reason: "expired" });
});

test("backs off when an attempt was made within the last hour", () => {
  const state = {
    access_token: "t",
    expires_at: null,
    last_attempt_at: iso(-10 * 60 * 1000),
  };
  assert.deepStrictEqual(shouldRefresh(state, NOW), { due: false, reason: "attempted_recently" });
});

test("retries once the backoff window has passed", () => {
  const state = {
    access_token: "t",
    expires_at: null,
    last_attempt_at: iso(-2 * 60 * 60 * 1000),
  };
  assert.deepStrictEqual(shouldRefresh(state, NOW), { due: true, reason: "expiry_unknown" });
});

test("no token means nothing to refresh", () => {
  assert.deepStrictEqual(shouldRefresh(null, NOW), { due: false, reason: "no_token" });
  assert.deepStrictEqual(shouldRefresh({}, NOW), { due: false, reason: "no_token" });
});

test("a corrupt last_attempt_at does not block refreshing", () => {
  const state = { access_token: "t", expires_at: null, last_attempt_at: "not-a-date" };
  assert.deepStrictEqual(shouldRefresh(state, NOW), { due: true, reason: "expiry_unknown" });
});

test("a corrupt expires_at is treated as unknown, not as valid", () => {
  const state = { access_token: "t", expires_at: "garbage" };
  assert.deepStrictEqual(shouldRefresh(state, NOW), { due: true, reason: "expiry_unknown" });
});
