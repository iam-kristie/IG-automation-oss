# IG Automations

Self-hosted Instagram automation for creators: daily metrics snapshots, a comment-keyword → auto-DM responder, and an analytics dashboard. Built on the Instagram Graph API (Instagram Login / `IGAA` tokens), Node.js + Express, zero database — everything persists to JSON files.

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
    └── keyword-matcher.test.js
```

## Setup

### 1. Meta app

1. Create a Meta app with Instagram Login for Business; generate a long-lived access token (`IGAA...`, valid 60 days — refresh periodically).
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
| `IG_ACCESS_TOKEN` | Instagram Login API token (`IGAA...`) |
| `IG_APP_ID` / `IG_APP_SECRET` | Meta app credentials (secret used to verify webhook signatures) |
| `WEBHOOK_VERIFY_TOKEN` | Webhook verification token (must match Meta dashboard) |
| `ADMIN_PASSWORD` | Dashboard basic-auth password (required in production) |
| `DATA_DIR` | Persistent data directory (default `./data`; set to your volume mount in production) |
| `PORT` | Server port (default 3100) |

## Deployment (Railway example)

Two services from the same repo:

1. **Webhook server** — build `Dockerfile`, mount a volume at `/data`, set `DATA_DIR=/data` and the env vars above.
2. **Daily snapshot cron** — build `Dockerfile.cron` as a cron-scheduled service. It just curls `POST /api/snapshots/run` on the server (set `WEBHOOK_URL` and `ADMIN_PASSWORD`). This indirection exists because some hosts (incl. Railway) don't allow two services to mount the same volume.

The included GitHub Actions workflow (`.github/workflows/docker.yml`) builds and pushes both images to GHCR on push to `main`.

## API notes & quirks (hard-won)

- Reel metrics (`ig_reels_avg_watch_time`, `reels_skip_rate`, …) must be fetched in a **separate** insights request — mixing unsupported metrics fails the whole request.
- `profile_views` requires `metric_type=total_value`, otherwise it returns empty.
- Per-post `follows` is not supported for Reels on Instagram Login tokens; account-level follower deltas are used instead.
- `/me/followers` does not exist for `IGAA` tokens (deprecated 2018) — you cannot check whether a given user follows you.
- `reposts` is surfaced in IG's mobile insights UI but not exposed to the Graph API.
- If a DM echo never arrives (>5 min), the recipient has likely disabled "Allow access to messages" — the DM was silently dropped. The dashboard keeps these as `pending` with an explanatory tooltip; the deferred public reply is never posted in that case.

## Testing

```bash
npm test   # keyword matcher unit tests
```

## License

MIT — see `LICENSE`.
