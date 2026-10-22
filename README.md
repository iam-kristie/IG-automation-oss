# IG Automations

Self-hosted Instagram automation for creators: daily metrics snapshots, a comment-keyword → auto-DM responder, and an analytics dashboard. Built on the Instagram Graph API (Instagram Login / `IGAA` tokens), Node.js + Express, zero database — everything persists to JSON files.

## Node.js security baseline (22 October 2026)

Use Node.js **22.23.4 or newer in the 22.x line** for the server and local Node scripts. Run `nvm install && nvm use` from the repository root before installing dependencies. The server image is pinned to `node:22.23.4-slim` for the [October 2026 Node.js security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).

Rebuild and redeploy the server image to update an existing service, then verify `node --version` inside the running container. Keep the existing certificate-store settings and TLS checks. The curl-only cron image has no Node runtime.

## Features

- **Comment keyword → DM** — Meta webhook receives comment events, fuzzy-matches keywords (typo-tolerant, emoji-stripping, mixed CJK/English), and sends the commenter a private reply with your link/material. Optionally posts a public comment reply *after* the DM is confirmed delivered.
- **Real delivery tracking** — Private Reply API's `200 OK` only means Meta accepted the request. This tool subscribes to `messages` (outbound echoes) and `messaging_seen` (read receipts) webhook fields to track true `pending → delivered → read` status per DM, plus classified failure reasons (24h window expired, user blocked DMs, token expired, …).
- **Daily metrics snapshots** — a cron service captures lifetime insights for every post daily (reach, likes, comments, shares, saves, views, Reel watch time / skip rate) plus account-level followers and profile views.
- **Analytics dashboard** — KPI cards, follower growth chart, content-type comparison (Reel vs Carousel), post-age milestone table (Day 1/3/7/30/Lifetime), per-metric engagement charts, date-range filtering and period-over-period comparison. See `docs/dashboard-wireframe.md`.
- **CSV export** — `node metrics/tracker.js --csv out.csv` exports all post metrics, preserving manually-maintained columns across runs.

## Architecture

```
ig-automations/
├── Dockerfile               ← webhook server image
├── Dockerfile.cron          ← cron trigger image (just curls the server)
├── config.js                ← keyword rules loading + DATA_DIR setup
├── lib/
│   ├── instagram.js         ← IG Graph API client (insights, comments, DMs)
│   ├── token.js             ← token store + auto-refresh (see "Access tokens")
│   ├── keyword-matcher.js   ← fuzzy keyword matching
│   └── snapshots.js         ← snapshot storage + age-milestone math
├── metrics/
│   ├── tracker.js           ← fetch all post metrics → CSV (manual use)
│   ├── snapshot.js          ← daily snapshot script (standalone)
│   └── run-tracker.sh       ← local wrapper for tracker.js
├── webhook/
│   ├── server.js            ← Express server (webhook + admin + API)
│   └── admin.html           ← dashboard UI (single file, no build step)
├── data/                    ← JSON persistence (gitignored runtime files)
│   └── keyword-rules.json   ← keyword → message rules (seed/example)
└── test/
    ├── keyword-matcher.test.js
    ├── token.test.js         ← token precedence + refresh-timing logic
    └── token-refresh.test.js ← refresh round-trip against a stubbed API
```

## Setup

### 1. Meta app

1. Create a Meta app with Instagram Login for Business; generate a long-lived access token (`IGAA...`, valid 60 days). The server refreshes it for you from then on, see [Access tokens](#access-tokens).
2. Required permissions: `instagram_basic`, `instagram_manage_insights`, `instagram_manage_comments`, `instagram_manage_messages`.
3. Set the app to **Live** mode.
4. Subscribe these webhook fields (App Dashboard → Webhooks → Instagram):
   - `comments` — comment events (triggers keyword matching → DM)
   - `messages` — includes outbound echoes (`is_echo: true`) used to confirm real DM delivery
   - `messaging_seen` — recipient read receipts
5. Webhook callback URL: `https://<your-host>/webhook`, with the verify token you set in `WEBHOOK_VERIFY_TOKEN`.

> Meta requires a public privacy policy URL for app review — see `docs/privacy-policy-template.md`.

### 2. Run locally

```bash
cp .env.example .env   # fill in your credentials
npm ci
npm start              # webhook server + dashboard on http://localhost:3100
```

### 3. Configure keyword rules

Open the dashboard and add rules under **Keyword Automations**, or edit `data/keyword-rules.json`. Each rule: `keyword` (matched case-insensitively, 1-char typo tolerance), optional `postIds` to scope to specific posts (empty = all posts), `message` (the DM text), `enabled`.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `IG_ACCESS_TOKEN` | Instagram Login API token (`IGAA...`). A **seed** only — the live token is kept in `DATA_DIR/ig-token.json` and refreshed automatically. See [Access tokens](#access-tokens) |
| `IG_APP_ID` / `IG_APP_SECRET` | Meta app credentials (secret used to verify webhook signatures) |
| `WEBHOOK_VERIFY_TOKEN` | Webhook verification token (must match Meta dashboard) |
| `ADMIN_PASSWORD` | Dashboard basic-auth password (required in production) |
| `DATA_DIR` | Persistent data directory (default `./data`; set to your volume mount in production) |
| `PORT` | Server port (default 3100) |

## Access tokens

Instagram Login tokens last 60 days and can only be refreshed **while still valid**. Once one lapses there is no recovery: you have to re-authorize by hand in the Meta App Dashboard. This bit us in production, so the server now rolls the expiry forward on its own.

**Where the token lives.** Most PaaS environments (Railway included) make env vars immutable at runtime, so a refreshed token cannot be written back to `IG_ACCESS_TOKEN`. The live token is therefore kept in `DATA_DIR/ig-token.json` on your persistent volume, and `IG_ACCESS_TOKEN` acts only as a seed.

**Which token wins.** The store records the seed it descends from, so:

- You change `IG_ACCESS_TOKEN` → the new value wins. This is the escape hatch: pasting a fresh token always takes effect.
- You leave `IG_ACCESS_TOKEN` alone → the refreshed token in the store wins. Without this, every restart would roll back to a stale seed.

**When it refreshes.** On server boot, and at the start of every `POST /api/snapshots/run` (i.e. on your cron schedule), but only once the token is within 7 days of expiry. Attempts are rate-limited to one per hour, and a failed refresh is logged rather than thrown, so it can never cost you a snapshot.

**Endpoints** (basic-auth protected; neither returns the token itself):

| Endpoint | Purpose |
|----------|---------|
| `GET /api/token/status` | Expiry, days remaining, last refresh/attempt, last error |
| `POST /api/token/refresh` | Force a refresh. `200` = expiry moved, `202` = re-issued but expiry unchanged (see below), `500` = failed |

**Rotating manually.** Set `IG_ACCESS_TOKEN` to the new value everywhere (all services, plus local `.env`) and redeploy. On boot the server notices the seed changed and reseeds the store.

> **If `ig-token.json` is ever corrupted**, the server falls back to the `IG_ACCESS_TOKEN` seed — which may itself be long expired. It shouts about this in the logs, preserves the bad file as `ig-token.json.corrupt` so you can recover the token by hand, and reports `store_was_corrupt: true` from `/api/token/status`.

## Deployment (Railway example)

Two services from the same repo:

1. **Webhook server** — point the service at `Dockerfile`, mount a volume at `/data`, set `DATA_DIR=/data` and the env vars above.
2. **Daily snapshot cron** — point a second service at `Dockerfile.cron` as a cron-scheduled service. It just curls `POST /api/snapshots/run` on the server (set `WEBHOOK_URL` and `ADMIN_PASSWORD`). This indirection exists because some hosts (incl. Railway) don't allow two services to mount the same volume.

Railway (and most PaaS — Render, Fly.io, etc.) builds the image straight from the Dockerfile in the repo, so there's nothing to publish first. To build and run it yourself instead:

```bash
docker build -t ig-automations -f Dockerfile .
docker run -p 3100:3100 --env-file .env -v "$PWD/data:/data" -e DATA_DIR=/data ig-automations
```

## API notes & quirks (hard-won)

- Reel metrics (`ig_reels_avg_watch_time`, `reels_skip_rate`, …) must be fetched in a **separate** insights request — mixing unsupported metrics fails the whole request.
- `profile_views` requires `metric_type=total_value`, otherwise it returns empty.
- Per-post `follows` is not supported for Reels on Instagram Login tokens; account-level follower deltas are used instead.
- `/me/followers` does not exist for `IGAA` tokens (deprecated 2018) — you cannot check whether a given user follows you.
- `reposts` is surfaced in IG's mobile insights UI but not exposed to the Graph API.
- If a DM echo never arrives (>5 min), the recipient has likely disabled "Allow access to messages" — the DM was silently dropped. The dashboard keeps these as `pending` with an explanatory tooltip; the deferred public reply is never posted in that case.
- **A successful token refresh does not always extend the expiry.** Meta declines to extend tokens under 24 hours old, and it signals this by returning `200` with a *new* `access_token` whose expiry is unchanged — not by returning an error. Treat "refresh succeeded" as insufficient: compare the old and new expiry, or your token can lapse behind a log full of successful refreshes. `lib/token.js` does this and reports `extended: false`.
- **Refreshing does not invalidate the previous token.** Both remain usable until their own expiry, so a rotation can't strand in-flight requests.

## Testing

```bash
npm test   # 45 tests: keyword matching, token precedence, refresh round-trip
```

> `node --test test/` (passing a directory) fails with `MODULE_NOT_FOUND` on Node 24, so `npm test` uses the glob `test/*.test.js`.

## License

MIT — see `LICENSE`.
