#!/bin/bash
# Wrapper for running the metrics tracker manually (e.g. from cron or launchd).
# Loads credentials from the repo .env and writes the CSV to CSV_OUT
# (defaults to metrics-output.csv in the repo root).

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CSV_OUT="${CSV_OUT:-$REPO_DIR/metrics-output.csv}"

source "$REPO_DIR/.env"
export IG_ACCESS_TOKEN

cd "$REPO_DIR"
node metrics/tracker.js --csv "$CSV_OUT"

echo "[$(date)] Metrics updated successfully" >> "$REPO_DIR/metrics/tracker.log"
