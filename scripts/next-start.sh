#!/bin/bash
# Net2App Blast — Production Next.js Startup Wrapper
# Ensures a production build exists before starting the server.
# This prevents the "Could not find a production build" crash loop.
#
# IMPORTANT: We force the Webpack production build (--no-turbo) because
# Tailwind CSS v4 + @tailwindcss/postcss is not yet reliably wired into
# Next.js 16's default Turbopack production build — the resulting bundle
# was missing `/_next/static/css/` assets so the running UI rendered
# unstyled (page looked empty / "No logs visible"). The Webpack pipeline
# has long-standing PostCSS support for the same plugin.

set -eo pipefail

APP_DIR="/home/ubuntu/net2app-platform"
BUILD_ID_FILE="$APP_DIR/.next/BUILD_ID"
PORT="${PORT:-3000}"

cd "$APP_DIR"

# Check if a valid production build exists
if [ ! -f "$BUILD_ID_FILE" ]; then
    echo "[next-start] No production build found. Running 'next build --no-turbo' (timeout 10min)..."
    timeout 600 npx next build
    echo "[next-start] Build complete."
else
    # Verify the existing build has compiled CSS — if .next/static/css/ is
    # missing we know it was a stale Turbopack production build that won't
    # render Tailwind classes. Force-rebuild with Webpack in that case.
    if [ ! -d "$APP_DIR/.next/static/css" ] || [ -z "$(ls -A $APP_DIR/.next/static/css/ 2>/dev/null)" ]; then
        echo "[next-start] Existing build has NO compiled CSS (likely stale Turbopack build). Rebuilding with Webpack..."
        rm -rf "$APP_DIR/.next"
        timeout 600 npx next build
    else
        echo "[next-start] Build exists (BUILD_ID: $(cat $BUILD_ID_FILE)). Starting..."
    fi
fi

# Start the Next.js production server
exec node_modules/.bin/next start -p "$PORT"
