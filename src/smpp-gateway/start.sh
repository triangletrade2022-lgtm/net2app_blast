#!/bin/bash
# Net2App SMPP Gateway (Node.js) — Start Script
# Replaces the Python smpp_server.py with unified Node.js stack

APP_DIR="/home/ubuntu/net2app-platform"
LOG_DIR="$APP_DIR/logs"

mkdir -p "$LOG_DIR"

echo "Starting Net2App SMPP Gateway (Node.js)..."
cd "$APP_DIR" && npx tsx src/smpp-gateway/index.ts
