// Covers the refresh round-trip: Meta's response → persisted store.
// DATA_DIR must be set before importing, since config.js reads it at import time.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { resolve, join } from "path";

const DIR = mkdtempSync(join(tmpdir(), "ig-token-test-"));
process.env.DATA_DIR = DIR;
process.env.IG_ACCESS_TOKEN = "IGAA_seed";

const { maybeRefreshToken, getAccessToken, getTokenStatus, shouldRefresh, _resetCache } =
  await import("../lib/token.js");

const TOKEN_PATH = resolve(DIR, "ig-token.json");
const readStore = () => JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));
const realFetch = globalThis.fetch;

function stubFetch(payload) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url.toString());
    return { json: async () => payload };
  };
  return calls;
}

// Start each test from a clean store seeded from the env var.
beforeEach(() => {
  rmSync(TOKEN_PATH, { force: true });
  _resetCache();
});

after(() => {
  globalThis.fetch = realFetch;
  rmSync(DIR, { recursive: true, force: true });
});

test("a successful refresh persists the new token and its expiry", async () => {
  const calls = stubFetch({
    access_token: "IGAA_rotated",
    token_type: "bearer",
    expires_in: 5184000, // 60 days, as Meta returns
  });

  const result = await maybeRefreshToken();
  assert.strictEqual(result.refreshed, true);
  assert.strictEqual(result.days_remaining, 60);

  // The request must hit the refresh endpoint with the *old* token.
  assert.match(calls[0], /refresh_access_token/);
  assert.match(calls[0], /grant_type=ig_refresh_token/);
  assert.match(calls[0], /access_token=IGAA_seed/);

  const store = readStore();
  assert.strictEqual(store.access_token, "IGAA_rotated");
  assert.strictEqual(store.source, "refresh");
  assert.strictEqual(store.last_error, null);
  // seed_token stays pinned to the env value so an unchanged env var
  // won't roll the rotated token back on the next boot.
  assert.strictEqual(store.seed_token, "IGAA_seed");

  // The live getter reflects the rotation without a restart.
  assert.strictEqual(getAccessToken(), "IGAA_rotated");
  assert.strictEqual(getTokenStatus().expired, false);
});

test("an expired-token error is recorded without throwing or losing the token", async () => {
  stubFetch({
    error: {
      message: "Error validating access token: Session has expired",
      type: "OAuthException",
      code: 190,
    },
  });

  const result = await maybeRefreshToken();
  assert.strictEqual(result.refreshed, false);
  assert.strictEqual(result.reason, "error");
  assert.match(result.error, /Session has expired/);

  const store = readStore();
  // The old token is kept: clearing it would turn a recoverable outage into a
  // dead server that can't even report why.
  assert.strictEqual(store.access_token, "IGAA_seed");
  assert.match(store.last_error, /Session has expired/);
  assert.ok(store.last_attempt_at);
});

test("a malformed response (no access_token) is treated as failure", async () => {
  stubFetch({ unexpected: true });
  const result = await maybeRefreshToken();
  assert.strictEqual(result.refreshed, false);
  assert.strictEqual(result.reason, "error");
  assert.strictEqual(readStore().access_token, "IGAA_seed");
});

// Regression: a response carrying access_token but no usable expires_in used to
// swap the new token into the live store *and* report failure, leaving an
// unrefreshable token in use with no recorded expiry.
for (const [label, expires_in] of [
  ["missing", undefined],
  ["null", null],
  ["non-numeric", "soon"],
  ["zero", 0],
  ["negative", -100],
]) {
  test(`a response with ${label} expires_in fails without swapping the token`, async () => {
    stubFetch({ access_token: "IGAA_half_applied", expires_in });

    const result = await maybeRefreshToken();
    assert.strictEqual(result.refreshed, false);
    assert.strictEqual(result.reason, "error");
    assert.match(result.error, /expires_in|access_token/);

    // The old token must stay in force — both in the store and in the getter.
    assert.strictEqual(readStore().access_token, "IGAA_seed");
    assert.strictEqual(getAccessToken(), "IGAA_seed");
    assert.strictEqual(readStore().expires_at, null);
  });
}

// Observed against the live API on 2026-08-01: refreshing a 20-minute-old
// token returns 200 with a new access_token but an unchanged expiry. If that
// counted as success, the token could expire despite "successful" refreshes.
test("a refresh that does not move the expiry is reported as not extended", async () => {
  const fixedExpiry = Date.now() + 40 * 86400000;
  writeFileSync(
    TOKEN_PATH,
    JSON.stringify({
      access_token: "IGAA_seed",
      seed_token: "IGAA_seed",
      expires_at: new Date(fixedExpiry).toISOString(),
      refreshed_at: null,
      last_attempt_at: null,
      source: "refresh",
    })
  );
  _resetCache();

  // Meta hands back a new token whose expiry lands on the same instant.
  stubFetch({
    access_token: "IGAA_reissued",
    expires_in: Math.floor((fixedExpiry - Date.now()) / 1000),
  });

  const result = await maybeRefreshToken({ force: true });
  assert.strictEqual(result.refreshed, true);
  assert.strictEqual(result.extended, false, "expiry did not move, so this is not an extension");
});

test("a genuine extension is reported as extended", async () => {
  writeFileSync(
    TOKEN_PATH,
    JSON.stringify({
      access_token: "IGAA_seed",
      seed_token: "IGAA_seed",
      expires_at: new Date(Date.now() + 5 * 86400000).toISOString(),
      refreshed_at: null,
      last_attempt_at: null,
      source: "refresh",
    })
  );
  _resetCache();

  stubFetch({ access_token: "IGAA_rotated", expires_in: 5184000 });
  const result = await maybeRefreshToken();

  assert.strictEqual(result.refreshed, true);
  assert.strictEqual(result.extended, true);
  assert.strictEqual(result.days_remaining, 60);
});

test("the first refresh from an unknown expiry counts as extended", async () => {
  // Nothing to compare against on a freshly seeded store, so don't cry wolf.
  stubFetch({ access_token: "IGAA_rotated", expires_in: 5184000 });
  const result = await maybeRefreshToken();
  assert.strictEqual(result.extended, true);
});

test("a token whose expiry never moves stays due for retry", async () => {
  // The safety net: as long as it's inside the 7-day window, every run retries.
  const soon = new Date(Date.now() + 3 * 86400000).toISOString();
  writeFileSync(
    TOKEN_PATH,
    JSON.stringify({
      access_token: "IGAA_seed",
      seed_token: "IGAA_seed",
      expires_at: soon,
      refreshed_at: null,
      last_attempt_at: null,
      source: "refresh",
    })
  );
  _resetCache();

  stubFetch({ access_token: "IGAA_x", expires_in: Math.floor(3 * 86400) });
  const first = await maybeRefreshToken();
  assert.strictEqual(first.extended, false);

  // Still expiring soon => still due once the hourly backoff clears.
  const store = readStore();
  store.last_attempt_at = new Date(Date.now() - 2 * 3600000).toISOString();
  writeFileSync(TOKEN_PATH, JSON.stringify(store));
  _resetCache();
  assert.deepStrictEqual(shouldRefresh(readStore(), Date.now()), {
    due: true,
    reason: "expiring_soon",
  });
});

test("concurrent refreshes share one in-flight call to Meta", async () => {
  let resolveFetch;
  const gate = new Promise((r) => {
    resolveFetch = r;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await gate;
    return { json: async () => ({ access_token: "IGAA_rotated", expires_in: 5184000 }) };
  };

  const both = Promise.all([maybeRefreshToken({ force: true }), maybeRefreshToken({ force: true })]);
  resolveFetch();
  const [a, b] = await both;

  assert.strictEqual(calls, 1, "must not send the same old token to Meta twice");
  assert.strictEqual(a.refreshed, true);
  assert.deepStrictEqual(a, b, "both callers get the same result");
  assert.strictEqual(getAccessToken(), "IGAA_rotated");
});

test("a corrupt store is preserved, flagged, and reseeded from env", async () => {
  writeFileSync(TOKEN_PATH, "{ this is not json");
  _resetCache();

  // Falling back keeps the service alive, but must be visible to ops rather
  // than looking like an ordinary first-boot seed.
  assert.strictEqual(getAccessToken(), "IGAA_seed");
  const status = getTokenStatus();
  assert.strictEqual(status.store_was_corrupt, true);

  // The unparseable file is moved aside, not overwritten, so the previous
  // token can still be recovered by hand.
  assert.ok(existsSync(`${TOKEN_PATH}.corrupt`));
  rmSync(`${TOKEN_PATH}.corrupt`, { force: true });
});

test("a network throw is caught rather than propagating to the caller", async () => {
  globalThis.fetch = async () => {
    throw new Error("fetch failed");
  };
  const result = await maybeRefreshToken();
  assert.strictEqual(result.refreshed, false);
  assert.strictEqual(result.error, "fetch failed");
});

test("a healthy token is left alone and makes no API call", async () => {
  // Seed a store that is nowhere near expiry.
  writeFileSync(
    TOKEN_PATH,
    JSON.stringify({
      access_token: "IGAA_seed",
      seed_token: "IGAA_seed",
      expires_at: new Date(Date.now() + 50 * 86400000).toISOString(),
      refreshed_at: null,
      last_attempt_at: null,
      source: "refresh",
    })
  );
  _resetCache();

  const calls = stubFetch({ access_token: "should_not_be_used", expires_in: 5184000 });
  const result = await maybeRefreshToken();

  assert.deepStrictEqual(result, { refreshed: false, reason: "not_due" });
  assert.strictEqual(calls.length, 0, "must not call Meta when the token is healthy");
  assert.strictEqual(getAccessToken(), "IGAA_seed");
});

test("force overrides the not-due check for manual rotation", async () => {
  writeFileSync(
    TOKEN_PATH,
    JSON.stringify({
      access_token: "IGAA_seed",
      seed_token: "IGAA_seed",
      expires_at: new Date(Date.now() + 50 * 86400000).toISOString(),
      refreshed_at: null,
      last_attempt_at: null,
      source: "refresh",
    })
  );
  _resetCache();

  stubFetch({ access_token: "IGAA_forced", expires_in: 5184000 });
  const result = await maybeRefreshToken({ force: true });

  assert.strictEqual(result.refreshed, true);
  assert.strictEqual(getAccessToken(), "IGAA_forced");
});
