#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Net2App Blast - Frontend Health Check
# Runs every minute via cron to auto-restart if the GUI goes down
# ═══════════════════════════════════════════════════════════════

APP_DIR="/home/ubuntu/net2app-platform"
LOG_FILE="${APP_DIR}/logs/health-check.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Check port 3000 (Next.js directly)
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:3000/ 2>/dev/null)
if [ "$HTTP_CODE" != "200" ]; then
    echo "${TIMESTAMP} ❌ Port 3000 returned ${HTTP_CODE:-NO_RESPONSE} - Restarting..." >> "$LOG_FILE"
    pm2 restart net2app-blast >> "$LOG_FILE" 2>&1
    echo "${TIMESTAMP} ✅ PM2 restart issued" >> "$LOG_FILE"
fi

# Check port 80 (Nginx)
HTTP_CODE_80=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:80/ 2>/dev/null)
if [ "$HTTP_CODE_80" != "200" ]; then
    echo "${TIMESTAMP} ⚠️ Port 80 returned ${HTTP_CODE_80:-NO_RESPONSE} - Restarting nginx..." >> "$LOG_FILE"
    systemctl restart nginx >> "$LOG_FILE" 2>&1
    echo "${TIMESTAMP} ✅ Nginx restart issued" >> "$LOG_FILE"
fi
