# Changelog

All notable changes to Net2App Blast are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [v1.0.1] — 2025-06-17

### Added

- **SMPP v5.0 / v3.4 / v3.3 auto-detection** — Both Python and Node.js SMSC clients now auto-negotiate the SMPP version (v5.0 → v3.4 → v3.3) for maximum supplier compatibility
- **Bind type fallback** — Tries transceiver first, falls back to transmitter for each version (6 attempts max)
- **Unicode SMS support** — UCS-2/Bangla encoding with automatic GSM-7/UCS-2 detection, correct byte sizing, and encoding display in logs
- **Character counter** — Test SMS form shows encoding type and remaining characters
- **SMS logs API** — Pagination, search, date range filtering, and connection type filter
- **Real-time balance monitoring** — Auto-refresh with change highlighting
- **One-line clone-and-deploy** — `git clone ... && cd net2app_blast && sudo bash install-net2app.sh`
- **HTTP supplier support** — Added HTTP supplier client to Java gateway for SMS Sheba routing
- **`.env.example`** — Documents all 7 environment variables for manual setup users
- **Pre-commit hook** — Blocks `.env` files from being committed (allows `.env.example`)
- **Open-source docs** — LICENSE, SECURITY.md, SUPPORT.md, CONTRIBUTING.md, ISSUE_TEMPLATE/

### Fixed

- **PDU decode error** — Replaced failing `PDUEncoder.decode()` with a robust manual PDU parser; fixes connection failures with strict SMSC servers (EIMS, etc.)
- **TLS misconfiguration** — Corrected `smpp_tls` for suppliers using plain TCP
- **Bind status DB error** — Replaced failing `ON CONFLICT` upsert with reliable UPDATE+INSERT pattern for `smpp_sessions` table
- **DLR billing asymmetry** — Force DLR now correctly charges client but not supplier
- **Failed SMS status** — Shows correct status without charging client/supplier
- **Next.js crash loop** — Prevented crash loop during startup
- **Port conflict** — Resolved port conflict and fixed SMPP status route
- **Status comparison** — Normalized status values to raw integers for consistent comparison

### Changed

- **`drizzle.config.ts`** — Reads `DATABASE_URL` from env instead of hardcoded credentials
- **`ecosystem.config.js`** — Uses dynamic `process.cwd()` paths instead of hardcoded paths
- **Install script** — Added `pg_ctlcluster` fallback when `systemctl` fails; resilient `systemctl reload`
- **README** — Updated with one-line install, full env vars table, and SMPP v5.0 docs
- **INSTALLATION-GUIDE.md** — Updated to reference `.env.example` and `drizzle.config.ts`
- **Database migration** — Added `sender_id` column to suppliers table

---

## [v1.0.0] — 2025-06-10

### Added

- **SMPP ESMC Server** — Accepts SMPP client connections (bind_transceiver/transmitter/receiver) on port 2775
- **SMSC Supplier Manager** — Dynamic multi-supplier connections with auto-reconnect and keepalive
- **HTTP API** — RESTful SMS sending API for non-SMPP clients
- **Message Routing** — Configurable route→trunk→supplier chains with priority and weight-based routing
- **Client Management** — SMPP & HTTP clients with IP whitelisting, TPS limits, and balance tracking
- **Supplier Management** — SMPP & HTTP API suppliers with rate configuration and priority ordering
- **Route Management** — MCC-MNC based routing with fallback chains
- **Rate Management** — Per-client and per-supplier rates with currency support
- **Balance & Credit** — Top-up, credit limits, and automated balance deduction
- **SMSC Connection Monitor** — Real-time status page at `/smpp/status` with auto-refresh
- **Dashboard** — Live SMS volume, DLR rates, hourly stats, and recent activity
- **SMS Logs** — Searchable message logs with send/deliver results, costs, and profit analysis
- **Invoice Generation** — Per-client/supplier invoicing with MCC-MNC breakdown and PDF export
- **Reporting** — Daily, by-client, by-supplier, and profit analysis reports with CSV export
- **DLR Handling** — Real-time delivery receipts with force-DLR timeout and queuing
- **Email Notifications** — SMTP-based invoice delivery and alerts
- **JWT Authentication** — Secure API access with bcrypt password hashing
- **Tech Stack** — Next.js 16, React 19, PostgreSQL 16, Drizzle ORM, PM2, Python (smppy)
