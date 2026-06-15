#!/bin/bash
# Net2App Blast - SMPP Gateway Server Startup Script
# Starts the SMPP server with ESMC + SMSC + REST API bridge

APP_DIR="/home/ubuntu/net2app-platform"
VENV_DIR="${APP_DIR}/smpp_env"
PID_FILE="${APP_DIR}/logs/smpp_server.pid"
LOG_FILE="${APP_DIR}/logs/smpp_server.log"

# Ensure logs directory exists
mkdir -p "${APP_DIR}/logs"

case "$1" in
    start)
        echo "Starting SMPP Gateway Server..."
        if [ -f "$PID_FILE" ] && kill -0 $(cat "$PID_FILE") 2>/dev/null; then
            echo "SMPP Server is already running (PID: $(cat $PID_FILE))"
            exit 1
        fi
        cd "$APP_DIR"
        nohup "${VENV_DIR}/bin/python" "${APP_DIR}/smpp/smpp_server.py" >> "$LOG_FILE" 2>&1 &
        echo $! > "$PID_FILE"
        sleep 2
        if kill -0 $(cat "$PID_FILE") 2>/dev/null; then
            echo "SMPP Gateway Server started (PID: $(cat $PID_FILE))"
            echo "Log: $LOG_FILE"
        else
            echo "Failed to start SMPP Server. Check logs."
            rm -f "$PID_FILE"
        fi
        ;;
    stop)
        echo "Stopping SMPP Gateway Server..."
        if [ -f "$PID_FILE" ]; then
            kill $(cat "$PID_FILE") 2>/dev/null || true
            rm -f "$PID_FILE"
            echo "SMPP Server stopped"
        else
            echo "No PID file found"
        fi
        ;;
    restart)
        $0 stop
        sleep 2
        $0 start
        ;;
    status)
        if [ -f "$PID_FILE" ] && kill -0 $(cat "$PID_FILE") 2>/dev/null; then
            echo "SMPP Gateway Server is running (PID: $(cat $PID_FILE))"
            # Check if SMSC is connected
            curl -s http://127.0.0.1:9000/api/smpp/status 2>/dev/null || echo "REST API not responding"
        else
            echo "SMPP Gateway Server is NOT running"
        fi
        ;;
    logs)
        tail -f "$LOG_FILE"
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs}"
        exit 1
        ;;
esac
