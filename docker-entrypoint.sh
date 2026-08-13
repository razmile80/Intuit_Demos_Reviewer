#!/bin/sh
# Link persistent dirs from the mounted volume into the app directory, so the
# app's relative paths (runs/, reports/, data/) survive restarts and redeploys.
set -e
PERSIST="${PERSIST_DIR:-/persist}"
mkdir -p "$PERSIST/runs" "$PERSIST/reports" "$PERSIST/data"
for d in runs reports data; do
  rm -rf "/app/$d"
  ln -s "$PERSIST/$d" "/app/$d"
done
exec node src/server.js
