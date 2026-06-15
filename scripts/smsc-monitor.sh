#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Net2App Blast - SMSC Connection Monitor
# Checks the SMPP gateway REST API every 5 minutes via cron
# and alerts (logs) if the SMSC has been down for too long
# ═══════════════════════════════════════════════════════════════

APP_DIR="/home/ubuntu/net2app-platform"
LOG_FILE="${APP_DIR}/logs/smsc-monitor.log"
STATE_FILE="${APP_DIR}/logs/smsc-monitor.state"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Status endpoints
# Primary: Next.js API (syncs DB bind status + proxies SMPP server)
NEXTJS_STATUS_URL="http://127.0.0.1:3000/api/smpp/status"
# Fallback: direct SMPP server REST API (used when Next.js is unreachable)
SMPPD_STATUS_URL="http://127.0.0.1:9000/api/smpp/status"

# Thresholds
CONSECUTIVE_ALERT_THRESHOLD=6  # 6 checks x 5 min = 30 min down triggers alert
SERVICE_RESTART_THRESHOLD=12    # 12 checks x 5 min = 60 min down triggers restart

# Read previous state
PREV_FAILURES=0
if [ -f "$STATE_FILE" ]; then
    PREV_FAILURES=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
fi

USE_FALLBACK=false

# — Step 1: Try the Next.js API first (richer data + DB sync) —
RESPONSE=$(curl -s --max-time 5 "$NEXTJS_STATUS_URL" 2>/dev/null)
CURL_EXIT=$?

if [ "$CURL_EXIT" -ne 0 ] || [ -z "$RESPONSE" ]; then
    echo "${TIMESTAMP} ⚠️ Next.js API unreachable (curl exit: ${CURL_EXIT}), falling back to direct SMPP API..." >> "$LOG_FILE"
    USE_FALLBACK=true
fi

# — Step 2: Fall back to direct SMPP server API if needed —
if [ "$USE_FALLBACK" = true ]; then
    RESPONSE=$(curl -s --max-time 5 "$SMPPD_STATUS_URL" 2>/dev/null)
    CURL_EXIT=$?

    if [ "$CURL_EXIT" -ne 0 ] || [ -z "$RESPONSE" ]; then
        # Both endpoints are down — critical issue
        echo "${TIMESTAMP} 🔴 CRITICAL: SMPP server directly unreachable too (curl exit: ${CURL_EXIT})" >> "$LOG_FILE"
        echo "${TIMESTAMP} 🔴 SMPP gateway may be down entirely" >> "$LOG_FILE"
        systemctl is-active net2app-smpp >> "$LOG_FILE" 2>&1 || {
            echo "${TIMESTAMP} 🔴 SMPP service is down! Restarting..." >> "$LOG_FILE"
            systemctl restart net2app-smpp >> "$LOG_FILE" 2>&1
        }
        echo "0" > "$STATE_FILE"
        exit 1
    fi

    # Parse fallback (direct SMPP server) JSON format
    PARSED=$(
        echo "$RESPONSE" | python3 <<'PYEOF'
import sys, json

try:
    data = json.load(sys.stdin)
except json.JSONDecodeError:
    data = {}

# Direct SMPP server format: supplier_connected or supplier.connected
connected = data.get('supplier_connected', False)
if not connected:
    connected = data.get('supplier', {}).get('connected', False)
connected_bool = str(connected).lower()

sessions = data.get('connected_sessions', data.get('sessions', 0))
suppliers_list = data.get('suppliers', [data.get('supplier', {})])

total = len(suppliers_list) if isinstance(suppliers_list, list) else (1 if suppliers_list else 0)
con_count = 1 if connected_bool == 'true' else 0

sup_names = []
for s in (suppliers_list if isinstance(suppliers_list, list) else [suppliers_list]):
    if not s:
        continue
    icon = '✅' if s.get('connected', False) else '❌'
    sup_names.append(f"{icon}{s.get('name','?')} ({s.get('system_id','?')})")
sup_summary = ', '.join(sup_names)

print(f"CONNECTED={connected_bool}")
print(f"CONNECTED_COUNT={con_count}")
print(f"TOTAL_COUNT={total}")
print(f"ESME_SESSIONS={sessions}")
print(f"FETCH_ERROR=")
print(f"SUPPLIER_SUMMARY={sup_summary}")
print(f"CHECKED_AT=")
print(f"SOURCE=direct")
PYEOF
    2>/dev/null || echo "PARSE_FAILED=1"
    )

else
    # Parse Next.js API JSON format (richer structure)
    PARSED=$(
        echo "$RESPONSE" | python3 <<'PYEOF'
import sys, json

try:
    data = json.load(sys.stdin)
except json.JSONDecodeError:
    data = {}

sup_connected = data.get('suppliers_connected', 0)
sup_total     = data.get('suppliers_total', 0)
connected_bool = str(sup_connected > 0).lower()
esme_sessions = data.get('esme_sessions', 0)
fetch_error   = str(data.get('fetch_error', '') or '')
checked_at    = data.get('checked_at', '')

sup_names = []
for s in data.get('suppliers', []):
    icon = '✅' if s.get('connected') else '❌'
    sup_names.append(f"{icon}{s.get('name','?')} ({s.get('system_id','?')})")
sup_summary = ', '.join(sup_names)

print(f"CONNECTED={connected_bool}")
print(f"CONNECTED_COUNT={sup_connected}")
print(f"TOTAL_COUNT={sup_total}")
print(f"ESME_SESSIONS={esme_sessions}")
print(f"FETCH_ERROR={fetch_error}")
print(f"SUPPLIER_SUMMARY={sup_summary}")
print(f"CHECKED_AT={checked_at}")
print(f"SOURCE=nextjs")
PYEOF
    2>/dev/null || echo "PARSE_FAILED=1"
    )
fi

# — Extract parsed values —
if echo "$PARSED" | grep -q "PARSE_FAILED=1"; then
    echo "${TIMESTAMP} 🔴 CRITICAL: Failed to parse JSON response from any source" >> "$LOG_FILE"
    echo "${TIMESTAMP} 🔴 Raw response: $(echo "$RESPONSE" | head -c 200)" >> "$LOG_FILE"
    echo "0" > "$STATE_FILE"
    exit 1
fi

SUPPLIER_CONNECTED=$(echo "$PARSED" | grep "^CONNECTED=" | cut -d= -f2-)
CONNECTED_COUNT=$(echo "$PARSED"   | grep "^CONNECTED_COUNT=" | cut -d= -f2-)
TOTAL_COUNT=$(echo "$PARSED"       | grep "^TOTAL_COUNT=" | cut -d= -f2-)
ESME_SESSIONS=$(echo "$PARSED"     | grep "^ESME_SESSIONS=" | cut -d= -f2-)
FETCH_ERROR=$(echo "$PARSED"       | grep "^FETCH_ERROR=" | cut -d= -f2-)
SUPPLIER_SUMMARY=$(echo "$PARSED"  | grep "^SUPPLIER_SUMMARY=" | cut -d= -f2-)
CHECKED_AT=$(echo "$PARSED"        | grep "^CHECKED_AT=" | cut -d= -f2-)
SOURCE=$(echo "$PARSED"            | grep "^SOURCE=" | cut -d= -f2-)

# Log fetch_error from Next.js API (SMPP server down but Next.js up)
if [ "$SOURCE" = "nextjs" ] && [ -n "$FETCH_ERROR" ]; then
    echo "${TIMESTAMP} ⚠️ SMPP server unreachable via Next.js API: ${FETCH_ERROR}" >> "$LOG_FILE"
fi

if [ "$SUPPLIER_CONNECTED" = "true" ]; then
    # At least one SMSC supplier is connected
    echo "${TIMESTAMP} ✅ SMSC connected (${CONNECTED_COUNT}/${TOTAL_COUNT} suppliers${SOURCE:+, source: ${SOURCE}})" >> "$LOG_FILE"
    if [ -n "$SUPPLIER_SUMMARY" ]; then
        echo "${TIMESTAMP}    Suppliers: ${SUPPLIER_SUMMARY}" >> "$LOG_FILE"
    fi
    if [ "$SOURCE" = "nextjs" ] && [ -n "$CHECKED_AT" ]; then
        echo "${TIMESTAMP}    Checked at: ${CHECKED_AT}" >> "$LOG_FILE"
    fi
    echo "0" > "$STATE_FILE"
else
    # All SMSC suppliers are disconnected
    FAILURES=$((PREV_FAILURES + 1))
    echo "$FAILURES" > "$STATE_FILE"

    LOG_LINE="${TIMESTAMP} ⚠️ SMSC disconnected (attempt ${FAILURES})"
    if [ -n "$FETCH_ERROR" ]; then
        LOG_LINE="${LOG_LINE} — SMPP server unreachable"
    fi
    echo "${LOG_LINE}" >> "$LOG_FILE"
    if [ -n "$SUPPLIER_SUMMARY" ]; then
        echo "${TIMESTAMP}    Suppliers: ${SUPPLIER_SUMMARY}" >> "$LOG_FILE"
    fi

    if [ "$FAILURES" -ge "$SERVICE_RESTART_THRESHOLD" ]; then
        # Down for 1+ hour - escalate: restart the SMPP gateway
        echo "${TIMESTAMP} 🔴 ESCALATED: SMSC down for ${FAILURES} checks (${FAILURES}x5min). Restarting SMPP gateway..." >> "$LOG_FILE"
        systemctl restart net2app-smpp >> "$LOG_FILE" 2>&1
        echo "${TIMESTAMP} ✅ SMPP gateway restart issued" >> "$LOG_FILE"
        echo "0" > "$STATE_FILE"
    elif [ "$FAILURES" -ge "$CONSECUTIVE_ALERT_THRESHOLD" ]; then
        # Down for 30+ minutes - log a prominent alert
        echo "${TIMESTAMP} 🔴 ALERT: SMSC disconnected for ${FAILURES} consecutive checks (${FAILURES}x5min = $((FAILURES * 5))min)" >> "$LOG_FILE"
        # Log the last lines of the SMPP server log for context
        echo "${TIMESTAMP} 📋 Recent SMPP log:" >> "$LOG_FILE"
        tail -5 "$APP_DIR/logs/smpp_server.log" 2>/dev/null | sed "s/^/${TIMESTAMP}   /" >> "$LOG_FILE"
    fi

    # Log the raw status for debugging on first few failures
    if [ "$FAILURES" -le 3 ]; then
        echo "${TIMESTAMP} 📋 Raw status: $(echo "$RESPONSE" | head -c 300)" >> "$LOG_FILE"
    fi
fi
