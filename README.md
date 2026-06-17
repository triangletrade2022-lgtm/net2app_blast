# Net2App Blast — Enterprise SMS Gateway Platform

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white" alt="Next.js"/>
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" alt="React"/>
  <img src="https://img.shields.io/badge/PostgreSQL-16-336791?logo=postgresql&logoColor=white" alt="PostgreSQL"/>
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white" alt="Node.js"/>
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License"/>
  <img src="https://img.shields.io/badge/SMPP-v5.0%2Fv3.4%2Fv3.3-8B5CF6?logo=datadog&logoColor=white" alt="SMPP"/>
</p>

An enterprise-grade SMS gateway platform with SMPP/HTTP API support, real-time DLR tracking, dynamic routing, client & supplier management, invoicing, and a built-in monitoring dashboard.

## Architecture Overview

```
┌─────────────┐     SMPP/HTTP      ┌──────────────────┐
│   ESME      │◄──────────────────►│  Net2App Blast   │
│  Clients    │     (port 2775)    │                  │
│ (SMPP Apps) │                    │  ┌────────────┐  │
└─────────────┘                    │  │  ESMC      │  │
                                   │  │ (smppy)    │  │
┌─────────────┐                    │  └────────────┘  │
│   Web App   │◄──── HTTP ───────►│  ┌────────────┐  │
│  Dashboard  │    (port 3000)    │  │Next.js API │  │
│  (React/TS) │                    │  │ (REST)     │  │
└─────────────┘                    │  └────────────┘  │
                                   │  ┌────────────┐  │
┌─────────────┐                    │  │  SMSC      │  │
│   SMSC      │◄──── SMPP ───────►│  │ Manager    │  │
│  Suppliers  │    (dynamic)      │  └────────────┘  │
│ (Upstream)  │                    │  ┌────────────┐  │
└─────────────┘                    │  │PostgreSQL  │  │
                                   │  │  (DB)      │  │
                                   │  └────────────┘  │
                                   └──────────────────┘
```

## Features

### Core
- **SMPP ESMC Server** — Accepts SMPP client connections (bind_transceiver/transmitter/receiver) on port 2775
- **SMSC Supplier Manager** — Dynamic multi-supplier connections with auto-reconnect and keepalive
- **HTTP API** — RESTful SMS sending API for non-SMPP clients
- **Message Routing** — Configurable route→trunk→supplier chains with priority and weight-based routing

### Management
- **Client Management** — SMPP & HTTP clients with IP whitelisting, TPS limits, and balance tracking
- **Supplier Management** — SMPP & HTTP API suppliers with rate configuration and priority ordering
- **Route Management** — MCC-MNC based routing with fallback chains
- **Rate Management** — Per-client and per-supplier rates with currency support
- **Balance & Credit** — Top-up, credit limits, and automated balance deduction

### Monitoring
- **SMSC Connection Monitor** — Real-time status page at `/smpp/status` with auto-refresh (5s)
- **Supplier Connection Status** — Live bound/unbound indicators per SMSC supplier
- **ESME Session List** — Active client connections with system ID and remote address
- **Dashboard** — Live SMS volume, DLR rates, hourly stats, and recent activity
- **SMS Logs** — Searchable message logs with send/deliver results, costs, and profit analysis

### Operations
- **Invoice Generation** — Per-client/supplier invoicing with MCC-MNC breakdown and PDF export
- **Reporting** — Daily, by-client, by-supplier, and profit analysis reports with CSV export
- **DLR Handling** — Real-time delivery receipts with force-DLR timeout and queuing
- **Email Notifications** — SMTP-based invoice delivery and alerts

## Quick Start

### One-Line Install (Ubuntu 22.04/24.04)

```bash
git clone https://github.com/triangletrade2022-lgtm/net2app_blast.git && cd net2app_blast && sudo bash install-net2app.sh
```

This installs everything automatically: Node.js 22, PostgreSQL 16, Python SMPP gateway, PM2, and the full application with database schema and seed data.

### Prerequisites
- Ubuntu 22.04 or 24.04 LTS
- Root access (sudo)
- 2GB+ RAM, 20GB+ disk

### What Gets Installed
| Component | Version | Purpose |
|-----------|---------|---------|
| Node.js | 22.x | Application runtime |
| PostgreSQL | 16 | Database |
| PM2 | Latest | Process manager |
| Python | 3.x | SMPP gateway (ESMC + SMSC) |
| SMPP Libraries | smppy, smpp.pdu | SMPP v3.3/v3.4/v5.0 protocol support |

### After Installation
1. Open `http://YOUR_SERVER_IP:3000`
2. Login: `superuser` / `Telco1988`
3. Go to **Suppliers** → Configure your SMSC suppliers
4. Go to **SMSC Status** (`/smpp/status`) → Verify supplier connections
5. Send a test SMS via **Test SMS** page

See [INSTALLATION-GUIDE.md](INSTALLATION-GUIDE.md) for detailed manual setup instructions.

### Manual Setup

```bash
# 1. Install dependencies
npm install

# 2. Create virtual environment for SMPP gateway
python3 -m venv smpp_env
source smpp_env/bin/activate
pip install smppy smpp.pdu aiohttp psycopg2-binary
deactivate

# 3. Configure environment
cp .env.example .env  # or create manually:
# DATABASE_URL=postgresql://net2app_user:password@127.0.0.1:5432/net2app_db
# JWT_SECRET=your-secret-key
# NODE_ENV=production

# 4. Push database schema
npx drizzle-kit push --force

# 5. Build and start
npm run build
pm2 start ecosystem.config.js
```

## API Endpoints

### Authentication
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | User login (returns JWT) |
| GET | `/api/auth/me` | Get current user |

### SMPP Gateway (Internal, port 9000)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/smpp/status` | Real-time SMSC + ESME connection status |
| POST | `/api/smpp/send` | Send SMS via HTTP bridge |
| POST | `/api/smpp/dlr` | Update delivery receipt |
| POST | `/api/smpp/rebind` | Force-disconnect and reconnect a session |

### Management API (port 3000)
| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/clients` | List / Create clients |
| GET/PUT/DELETE | `/api/clients/:id` | Get / Update / Delete client |
| GET/POST | `/api/suppliers` | List / Create suppliers |
| GET/PUT/DELETE | `/api/suppliers/:id` | Get / Update / Delete supplier |
| GET/POST | `/api/routes` | List / Create routes |
| GET/POST | `/api/rates/client` | Client rate management |
| GET/POST | `/api/rates/supplier` | Supplier rate management |
| GET/POST | `/api/invoices` | Invoice management |
| POST | `/api/invoices/:id/pdf` | Download invoice as PDF |
| POST | `/api/invoices/:id/email` | Email invoice |
| GET | `/api/reports` | Analytics reports |
| GET | `/api/dashboard` | Dashboard statistics |
| GET | `/api/smpp/status` | Enriched SMSC+ESME status with DB sync |
| GET/POST | `/api/smpp/sessions` | SMPP session history |
| POST | `/api/smpp/rebind` | Rebind client/supplier session |

## Project Structure

```
net2app-platform/
├── src/
│   ├── app/
│   │   ├── page.tsx              # Main SPA dashboard (React)
│   │   ├── layout.tsx            # Root layout (dark theme)
│   │   ├── globals.css           # Tailwind CSS + animations
│   │   ├── smpp/status/
│   │   │   └── page.tsx          # SMSC connection status page
│   │   └── api/                  # Next.js API routes
│   │       ├── auth/             # Authentication
│   │       ├── clients/          # Client CRUD
│   │       ├── suppliers/        # Supplier CRUD
│   │       ├── routes/           # Route management
│   │       ├── rates/            # Rate management
│   │       ├── invoices/         # Invoice generation
│   │       ├── reports/          # Analytics
│   │       ├── dashboard/        # Dashboard stats
│   │       ├── smpp/             # SMPP status, sessions, rebind
│   │       ├── sms/              # Send, test, DLR
│   │       ├── users/            # User management
│   │       ├── balance/          # Balance operations
│   │       └── health/           # Health check
│   ├── db/
│   │   ├── schema.ts             # Drizzle ORM schema
│   │   └── index.ts              # Database connection
│   └── lib/
│       ├── auth.ts               # JWT auth helpers
│       ├── helpers.ts            # Utility functions
│       └── api-error.ts          # Error handler
├── smpp_gateway/
│   ├── smpp_server.py            # SMPP gateway (ESMC + SMSC + REST bridge)
│   ├── start.sh                  # Gateway lifecycle script
│   └── __init__.py
├── scripts/
│   ├── smsc-monitor.sh           # SMSC connection health monitor
│   ├── health-check.sh           # Web server health check
│   └── seed-user.mjs             # Database seeder
├── drizzle/                      # Migration files
├── install-net2app.sh            # Automated installer
├── INSTALLATION-GUIDE.md         # Detailed installation docs
├── ecosystem.config.js           # PM2 configuration
├── next.config.ts                # Next.js config
└── package.json
```

## Configuration

### Environment Variables
| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `JWT_SECRET` | JWT signing secret | Required |
| `NODE_ENV` | Environment mode | `production` |

### SMPP Gateway (hardcoded in smpp_server.py)
| Setting | Value |
|---------|-------|
| ESMC Host | `0.0.0.0` |
| ESMC Port | `2775` |
| REST API Port | `9000` |
| DB Host | `127.0.0.1:5432` |

## Monitoring

### SMSC Status Page
Access the real-time SMSC connection monitor at:
```
http://YOUR_SERVER:3000/smpp/status
```
Features:
- Overall system health indicator (green/yellow/red)
- Per-supplier connection status cards
- ESME client session list
- Auto-refresh every 5 seconds
- Server info (ESMC host, port, API endpoint)

### SMSC Monitor Script
A cron-compatible script checks SMSC health every 5 minutes:
```bash
# Manual check
bash scripts/smsc-monitor.sh

# Add to crontab (every 5 minutes)
*/5 * * * * /home/ubuntu/net2app-platform/scripts/smsc-monitor.sh
```

If the SMSC is disconnected for 30+ minutes, alerts are logged.
If disconnected for 60+ minutes, the SMPP gateway is automatically restarted.

## SMPP Gateway Details

### ESMC Server (Port 2775)
- **Protocol**: SMPP v5.0 / v3.4 / v3.3 (auto-detected, using smppy framework)
- **Authentication**: Client credentials from `clients` table
- **IP Whitelisting**: Manual (allowed_ips) or auto-whitelist on first connection
- **Keepalive**: Enquire link every 30 seconds
- **DLR**: Force-DLR with configurable timeout (instant, N seconds, or random 0-5s)

### SMSC Supplier Manager
- **Discovery**: Reads active SMPP suppliers from database every 10 seconds
- **Connection**: Persistent TCP/TLS connections with auto-reconnect
- **SMPP Version**: Auto-detects v5.0 → v3.4 → v3.3 for maximum compatibility
- **Bind Fallback**: Tries transceiver first, falls back to transmitter
- **Retry**: Exponential backoff (5s + 2s × attempt, max 30s)
- **DLR Listening**: Each supplier has a dedicated listen loop
- **Enquire Link**: Every ~15 seconds per supplier connection

## Tech Stack

- **Frontend**: React 19, Next.js 16, Tailwind CSS 4
- **Backend**: Next.js API Routes, Drizzle ORM
- **Database**: PostgreSQL 16
- **SMPP**: Python (smppy, smpp.pdu), asyncio
- **Process Management**: PM2
- **Auth**: JWT (jsonwebtoken + bcryptjs)

## License

See [LICENSE](LICENSE) for details.

## Support

For issues and feature requests, please open an issue on the GitHub repository.
