#!/bin/bash
# Net2App Blast — Production Next.js Startup Wrapper
# Ensures a production build exists before starting the server.
# This prevents the "Could not find a production build" crash loop.

set -eo pipefail

APP_DIR="/home/ubuntu/net2app-platform"
BUILD_ID_FILE="$APP_DIR/.next/BUILD_ID"
PORT="${PORT:-3000}"

cd "$APP_DIR"

# Check if a valid production build exists
if [ ! -f "$BUILD_ID_FILE" ]; then
    echo "[next-start] No production build found. Running 'npm run build' (timeout 5min)..."
    timeout 300 npm run build
    echo "[next-start] Build complete."
else
    echo "[next-start] Build exists (BUILD_ID: $(cat $BUILD_ID_FILE)). Starting..."
fi

# Start the Next.js production server
exec node_modules/.bin/next start -p "$PORT"
