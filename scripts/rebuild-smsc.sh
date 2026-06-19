#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════════════════╗
# ║  Net2App Blast - SMSC Gateway Auto-Rebuild                                ║
# ║                                                                            ║
# ║  Usage:  scripts/rebuild-smsc.sh [options]                                ║
# ║                                                                            ║
# ║  Auto-detects any source under java-smsc-gateway/src/                      ║
# ║  (java, config, resources, pom.xml) that is newer than the deployed JAR,   ║
# ║  and if so runs:                                                           ║
# ║      1) mvn package  (rebuilds the JAR — `mvn compile` does NOT do this;  ║
# ║                       skipping it is the root cause of the stale-jar bug)  ║
# ║      2) pm2 restart net2app-smsc  (hot-reloads the running gateway)        ║
# ║                                                                            ║
# ║  Options:                                                                  ║
# ║    --force         Always run mvn package + pm2 restart (no detection).   ║
# ║    --skip-maven    Skip the mvn step (debug).                              ║
# ║    --skip-pm2      Run mvn but do NOT touch PM2 (for CI/no-PM2 hosts).     ║
# ║    --status        Dry-run: print BUILD/NOOP. ALWAYS exits 0; the         ║
# ║                    rebuild decision is exposed via stdout marker so CI     ║
# ║                    can grep rather than rely on rc.                         ║
# ║    --quiet         Only emit green/red action lines + rc (cron-friendly).  ║
# ║    --jar <path>    Override the target JAR path.                           ║
# ║    --gateway <dir> Override the gateway module directory.                 ║
# ║    -h | --help     Print this help.                                        ║
# ║                                                                            ║
# ║  Env vars:                                                                 ║
# ║    SMSC_PORT              port to probe for SMSC readiness (default 2775)  ║
# ║    REBUILD_PORT_TIMEOUT   seconds to wait for port bind (default 30)       ║
# ║                                                                            ║
# ║  Exit codes:                                                               ║
# ║     0  ok (built or no-op; pm2 restart issued / not required)              ║
# ║         — with --status, ALWAYS exits 0; decision is on stdout            ║
# ║           (`STATUS: BUILD (...)` / `STATUS: NOOP (...)`).                  ║
# ║     2  pre-flight failure (missing mvn / pm2 / source dir)                 ║
# ║    10  maven build failed                                                  ║
# ║    11  new JAR not produced after a successful mvn                         ║
# ║    12  another rebuild is in progress (flock lock held)                    ║
# ║    20  pm2 (re)start failed                                                ║
# ╚═════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── Colors (match install-net2app.sh) ────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── Defaults + arg parsing ───────────────────────────────────────────────────
GATEWAY_DIR="${PROJECT_ROOT}/java-smsc-gateway"
JAR="${GATEWAY_DIR}/target/java-smsc-gateway-1.0.0.jar"

FORCE=0; SKIP_MAVEN=0; SKIP_PM2=0; STATUS_ONLY=0; QUIET=0

usage() { sed -n '2,32p' "$0"; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)         FORCE=1 ;;
    --skip-maven)    SKIP_MAVEN=1 ;;
    --skip-pm2)      SKIP_PM2=1 ;;
    --status)        STATUS_ONLY=1; QUIET=1 ;;
    --quiet)         QUIET=1 ;;
    --jar)
      [[ -z "${2:-}" ]] && { echo -e "${RED}✗ --jar requires a path${NC}" >&2; exit 2; }
      JAR="$2"; shift ;;
    --gateway)
      [[ -z "${2:-}" ]] && { echo -e "${RED}✗ --gateway requires a path${NC}" >&2; exit 2; }
      GATEWAY_DIR="$2"; JAR="${2}/target/java-smsc-gateway-1.0.0.jar"; shift ;;
    -h|--help)       usage ;;
    *)               echo -e "${RED}✗ Unknown arg: $1${NC}" >&2; exit 2 ;;
  esac
  shift
done

# `say` MUST always return rc=0 — even when QUIET=1 — because `set -e` is
# active at the top of the script and a non-zero return would abort
# before the `--status` block (and `--status` is documented as
# ALWAYS exiting 0). The bare `&&` short-circuit form returns the rc of
# the `[[ ]]` test on suppression, which is 1; we use an explicit `if` so
# the function's last statement returns 0 unconditionally.
say()    { if [[ "${QUIET}" -eq 0 ]]; then echo -e "$@"; fi; }
say_ln() { echo -e "$@"; }  # always printed (rc lines, final summary)
SMSC_PORT="${SMSC_PORT:-2775}"

# Probe the SMSC port without needing CAP_NET_ADMIN — bash's /dev/tcp
# redirect works in any unprivileged shell. The subshell forks-and-exits,
# which automatically closes FD 3; no parent-side cleanup is needed.
port_open() {
  local host="${REBUILD_SMSC_HOST:-127.0.0.1}" port="${1:?missing port}"
  (exec 3<>/dev/tcp/"${host}"/"${port}") 2>/dev/null
}

# ── Banner ───────────────────────────────────────────────────────────────────
say_ln "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
say_ln "${BLUE}║     Net2App Blast - SMSC Gateway Auto-Rebuild                 ║${NC}"
say_ln "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"
say "${BLUE}  gateway:  ${YELLOW}${GATEWAY_DIR}${NC}"
say "${BLUE}  jar:      ${YELLOW}${JAR}${NC}"

# ── Pre-flight ───────────────────────────────────────────────────────────────
if [[ ! -d "${GATEWAY_DIR}" ]]; then
  say_ln "${RED}✗ Gateway source dir not found: ${GATEWAY_DIR}${NC}"
  exit 2
fi
if [[ ! -d "${GATEWAY_DIR}/src/main/java" ]]; then
  say_ln "${RED}✗ src/main/java missing under ${GATEWAY_DIR} — wrong module tree?${NC}"
  exit 2
fi
if ! command -v mvn >/dev/null 2>&1; then
  say_ln "${RED}✗ mvn not in PATH. Install Maven (sudo apt-get install maven) and retry.${NC}"
  exit 2
fi
say "${GREEN}  ✓ mvn $(mvn -v | awk '/Apache Maven/ {print $3}' | head -1) found${NC}"

if [[ "${SKIP_PM2}" -eq 0 ]] && ! command -v pm2 >/dev/null 2>&1; then
  say_ln "${RED}✗ pm2 not in PATH. Pass --skip-pm2 for CI/no-PM2 hosts.${NC}"
  exit 2
fi

# ── Mutex (flock) ────────────────────────────────────────────────────────────
LOCK_FILE="${GATEWAY_DIR}/.rebuild.lock"
mkdir -p "$(dirname "${LOCK_FILE}")" 2>/dev/null || true
if command -v flock >/dev/null 2>&1; then
  exec 9>"${LOCK_FILE}"
  if ! flock -n 9; then
    say_ln "${YELLOW}⚠ Another rebuild already in progress (lock: ${LOCK_FILE})${NC}"
    exit 12
  fi
  say "${GREEN}  ✓ Acquired rebuild lock${NC}"
else
  say "${YELLOW}  ⚠ flock unavailable — concurrent invocations not guarded${NC}"
fi

# ── Stale detection ──────────────────────────────────────────────────────────
# Sweep over ALL build inputs (java source + resources/config + pom).
newer_than_jar() {
  # $1 = path (file or dir), $2 = jar. Echoes "1" if any tracked source under
  # $1 is newer than $2, else "0".
  if [[ -f "$1" && "$1" -nt "$2" ]]; then echo 1; return; fi
  if [[ -d "$1" ]]; then
    local hit
    hit=$(find "$1" -type f \
      \( -name '*.java' -o -name '*.properties' -o -name '*.xml' \
         -o -name '*.yml'  -o -name '*.yaml' -o -name '*.json' \
         -o -name '*.cfg'  -o -name '*.conf' -o -name '*.sql' \) \
      -newer "$2" -print -quit 2>/dev/null || true)
    [[ -n "${hit}" ]] && { echo 1; return; }
  fi
  echo 0
}

NEEDS_BUILD="${FORCE}"
REASON=""

if [[ ! -f "${JAR}" ]]; then
  NEEDS_BUILD=1; REASON="JAR missing"
else
  if [[ "$(newer_than_jar "${GATEWAY_DIR}/pom.xml" "${JAR}")" == "1" ]]; then
    NEEDS_BUILD=1; REASON="pom.xml updated"
  fi
  if [[ "$(newer_than_jar "${GATEWAY_DIR}/src/main" "${JAR}")" == "1" ]]; then
    NEEDS_BUILD=1; REASON="${REASON:+$REASON + }java sources / config newer"
  fi
fi

# ── --status dry-run gate (CI-friendly: rc=0, signal on stdout) ──────────────
if [[ "${STATUS_ONLY}" -eq 1 ]]; then
  if [[ "${NEEDS_BUILD}" -eq 1 ]]; then
    say_ln "${YELLOW}STATUS: BUILD (${REASON:-forced})${NC}"
  else
    say_ln "${GREEN}STATUS: NOOP (jar current)${NC}"
  fi
  exit 0  # Always exit 0 — let CI grep the marker, not rc.
fi

# ── Report decision + (optional) stale-file listing ──────────────────────────
if [[ "${NEEDS_BUILD}" -eq 1 ]]; then
  say "${YELLOW}  ⚠ Build required: ${REASON:-forced}${NC}"
else
  say "${GREEN}  ✓ JAR appears current vs src/main + pom.xml${NC}"
fi

if [[ "${QUIET}" -eq 0 && -f "${JAR}" ]]; then
  STALE=$(find "${GATEWAY_DIR}/src/main" "${GATEWAY_DIR}/pom.xml" -type f \
          \( -name '*.java' -o -name '*.properties' -o -name '*.xml' \
             -o -name '*.yml' -o -name '*.yaml' -o -name '*.json' \
             -o -name '*.cfg' -o -name '*.conf' -o -name '*.sql' \) \
          -newer "${JAR}" 2>/dev/null || true)
  if [[ -n "${STALE}" ]]; then
    say "${YELLOW}  ⚠ $(echo "${STALE}" | wc -l) newer source(s):${NC}"
    echo "${STALE}" | head -10 | sed 's/^/      /'
    [[ $(echo "${STALE}" | wc -l) -gt 10 ]] && say "      … ($(echo "${STALE}" | wc -l) total)"
  fi
fi

# ── Step 1/2: rebuild JAR ────────────────────────────────────────────────────
if [[ "${SKIP_MAVEN}" -eq 1 ]]; then
  say_ln "${YELLOW}[1/2] Skipping mvn package (--skip-maven)${NC}"
elif [[ "${NEEDS_BUILD}" -eq 1 ]]; then
  say_ln "${YELLOW}[1/2] Running: cd ${GATEWAY_DIR} && mvn -DskipTests -Dmaven.javadoc.skip=true package${NC}"
  # Drive mvn's stdout/stderr to a temp log, capture mvn's rc into the
  # PARENT shell scope via `|| MAVEN_RC=$?`. The previous subshell +
  # PIPESTATUS dance was broken: variable assignments inside `(...)` are
  # local to the subshell and never reach the parent, so `exit 10` was
  # unreachable. This pattern: (a) runs `set -e` cleanly because the `||`
  # chain returns 0 even when mvn fails, (b) keeps MAVEN_RC in parent scope,
  # (c) avoids the PIPESTATUS-doesn't-cross-subshells bash quirk entirely.
  # Plain `mktemp` (let GNU coreutils pick the name) is more portable across
  # BSD / older systems than the `-t TEMPLATE.XXXXXX.log` form.
  MVN_LOG="$(mktemp)"
  MAVEN_RC=0
  ( cd "${GATEWAY_DIR}" && mvn -DskipTests -Dmaven.javadoc.skip=true package ) \
    > "${MVN_LOG}" 2>&1 || MAVEN_RC=$?
  tail -25 "${MVN_LOG}"
  rm -f "${MVN_LOG}"
  if [[ "${MAVEN_RC}" -ne 0 ]]; then
    say_ln "${RED}✗ mvn package failed (rc=${MAVEN_RC}). NOT restarting net2app-smsc — old JAR still on disk.${NC}"
    exit 10
  fi
  if [[ ! -f "${JAR}" ]]; then
    say_ln "${RED}✗ mvn package 'succeeded' but ${JAR} missing. Check pom.xml artifactId/version.${NC}"
    exit 11
  fi
  say "${GREEN}  ✓ JAR rebuilt: $(stat -c '%y %s bytes' "${JAR}")${NC}"
else
  say "${GREEN}[1/2] Skipping mvn package (JAR up-to-date)${NC}"
fi

# ── Step 2/2: PM2 (re)start ─────────────────────────────────────────────────
# Registration check via `pm2 describe <name>` — exits 1 if NOT registered in
# pm2's process list. (Note: `pm2 id <name>` is NOT reliable: it prints `[]`
# and exits 0 even when the app is absent, which masks the NOT-registered
# case the caller expects to distinguish.)
pm2_registered() {
  pm2 describe "${1}" >/dev/null 2>&1
}

if [[ "${SKIP_PM2}" -eq 1 ]]; then
  say_ln "${YELLOW}[2/2] Skipping pm2 restart (--skip-pm2)${NC}"
else
  if pm2_registered net2app-smsc; then
    say_ln "${YELLOW}[2/2] Running: pm2 restart net2app-smsc${NC}"
    pm2 restart net2app-smsc
  else
    say_ln "${YELLOW}[2/2] net2app-smsc not registered — starting fresh.${NC}"
    # Prefer the project's ecosystem.config.js so DB_PASS / DB_URL / SMSC_PORT /
    # API_PORT env vars are propagated exactly as in production. Fall back to
    # a raw `java -jar` invocation ONLY if ecosystem.config.js is missing.
    if [[ -f "${PROJECT_ROOT}/ecosystem.config.js" ]]; then
      # --name MUST come before the interpreter; -- separates pm2 args from
      # args forwarded to the interpreter. The `interpreter-args` flag is
      # deprecated in PM2 ≥ 5.2 and is rejected outright on some builds.
      pm2 start "${PROJECT_ROOT}/ecosystem.config.js" --only net2app-smsc || \
        pm2 start --name net2app-smsc java -- -jar "${JAR}" || {
          say_ln "${RED}✗ pm2 start failed. Run: pm2 logs net2app-smsc --lines 50${NC}"
          exit 20
        }
    else
      pm2 start --name net2app-smsc java -- -jar "${JAR}" || {
        say_ln "${RED}✗ pm2 start failed. Run: pm2 logs net2app-smsc --lines 50${NC}"
        exit 20
      }
    fi
  fi
  pm2 save >/dev/null 2>&1 || true

  # Probe SMSC_PORT (override via REBUILD_PORT_TIMEOUT — default 30s). Uses
  # bash /dev/tcp + a ss fallback for environments missing either tool.
  REBUILD_PORT_TIMEOUT="${REBUILD_PORT_TIMEOUT:-30}"
  PORT_OK=0
  for _ in $(seq 1 "${REBUILD_PORT_TIMEOUT}"); do
    if port_open "${SMSC_PORT}"; then
      PORT_OK=1; break
    elif command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -qE ":${SMSC_PORT}\b"; then
      PORT_OK=1; break
    fi
    sleep 1
  done

  if [[ "${PORT_OK}" -eq 1 ]]; then
    say "${GREEN}  ✓ SMSC listening on ${SMSC_PORT} (after ≤${REBUILD_PORT_TIMEOUT}s wait)${NC}"
  else
    say_ln "${RED}✗ SMSC not bound on ${SMSC_PORT} after ${REBUILD_PORT_TIMEOUT}s. pm2 logs net2app-smsc --lines 50${NC}"
    exit 20
  fi
fi

say_ln "${GREEN}╔════════════════════════════════════════════════════════════════╗${NC}"
say_ln "${GREEN}║   SMSC gateway rebuild complete ✓                             ║${NC}"
say_ln "${GREEN}╚════════════════════════════════════════════════════════════════╝${NC}"
