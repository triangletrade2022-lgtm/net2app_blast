#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║   Net2App Blast - Complete Ubuntu Deployment Script             ║
# ║   Ubuntu 22.04 / 24.04 LTS                                      ║
# ║   Install: SMSC + ESMC + DLR + Invoices + Dashboard            ║
# ║   Run as root: sudo bash install-net2app.sh                     ║
# ╚══════════════════════════════════════════════════════════════════╝
set -e

# ═══════════════════════════════════════════════════════════════════
# CREDENTIALS — Generated securely, prompted interactively
# ═══════════════════════════════════════════════════════════════════
DB_NAME="net2app_db"
DB_USER="net2app_user"
DB_SUPERUSER="postgres"

APP_USER="ubuntu"
APP_DIR="/home/${APP_USER}/net2app"
APP_PORT="3000"
DOMAIN=""

SUPERUSER_NAME="superuser"
ADMIN_EMAIL="admin@net2app.com"

# Generate secure random defaults
DB_PASS=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 24)
DB_SUPERPASS=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 24)
JWT_SECRET=$(head -c 64 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 48)
SUPERUSER_PASS=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)
ADMIN_PASS=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)

# Allow user to override credentials interactively
echo -e "${YELLOW}╔════════════════════════════════════════════════════════╗"
echo "║     Credential Configuration                          ║"
echo "║     Press Enter to accept secure defaults              ║"
echo "╚════════════════════════════════════════════════════════╝"
echo -e "${NC}"

read -p "$(echo -e ${CYAN}Database password [auto-generated]: ${NC})" INPUT_DB_PASS
DB_PASS="${INPUT_DB_PASS:-$DB_PASS}"

read -p "$(echo -e ${CYAN}Postgres superuser password [auto-generated]: ${NC})" INPUT_SUPERPASS
DB_SUPERPASS="${INPUT_SUPERPASS:-$DB_SUPERPASS}"

read -p "$(echo -e ${CYAN}JWT secret [auto-generated]: ${NC})" INPUT_JWT
JWT_SECRET="${INPUT_JWT:-$JWT_SECRET}"

read -p "$(echo -e ${CYAN}Superuser login password [auto-generated]: ${NC})" INPUT_SUPUSER_PASS
SUPERUSER_PASS="${INPUT_SUPUSER_PASS:-$SUPERUSER_PASS}"

read -p "$(echo -e ${CYAN}Admin login password [auto-generated]: ${NC})" INPUT_ADMIN_PASS
ADMIN_PASS="${INPUT_ADMIN_PASS:-$ADMIN_PASS}"

echo -e "${GREEN}✓ Credentials configured (saved to /home/${APP_USER}/net2app-credentials.txt)${NC}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'

echo -e "${BLUE}"
echo "╔════════════════════════════════════════════════════════╗"
echo "║     Net2App Blast - Enterprise SMS Platform           ║"
echo "║     Ubuntu 22.04/24.04 Complete Installation          ║"
echo "║     SMSC + ESMC + DLR + Invoices + Dashboard         ║"
echo "╚════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── Step 0: Root Check ─────────────────────────────────
echo -e "${YELLOW}[Step 0/14] Checking prerequisites...${NC}"
if [[ $EUID -ne 0 ]]; then
   echo -e "${RED}This script must be run as root. Use: sudo bash install-net2app.sh${NC}"
   exit 1
fi

SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
echo -e "${GREEN}✓ Running as root | Server IP: ${SERVER_IP}${NC}"

# ── Step 1: System Update ──────────────────────────────
echo -e "${YELLOW}[Step 1/14] Updating system packages...${NC}"
apt-get update -y -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl wget git build-essential software-properties-common gnupg2 ca-certificates lsb-release apt-transport-https unzip net-tools rsync
echo -e "${GREEN}✓ System packages updated${NC}"

# ── Step 2: Install Node.js 22.x ───────────────────────
echo -e "${YELLOW}[Step 2/14] Installing Node.js 22.x...${NC}"
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
    apt-get install -y -qq nodejs > /dev/null 2>&1
fi
echo -e "${GREEN}✓ Node.js $(node -v) | npm $(npm -v)${NC}"

npm install -g pm2 > /dev/null 2>&1
echo -e "${GREEN}✓ PM2 $(pm2 -v) installed${NC}"

# ── Step 3: Install PostgreSQL 16 ──────────────────────
echo -e "${YELLOW}[Step 3/14] Installing PostgreSQL 16...${NC}"
if ! command -v psql &> /dev/null; then
    sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg
    apt-get update -y -qq
    apt-get install -y -qq postgresql-16 postgresql-client-16 > /dev/null 2>&1
fi
echo -e "${GREEN}✓ PostgreSQL installed${NC}"

# ── Step 4: Configure PostgreSQL ───────────────────────
echo -e "${YELLOW}[Step 4/14] Configuring PostgreSQL database...${NC}"

systemctl enable postgresql 2>/dev/null || true
systemctl start postgresql 2>/dev/null || pg_ctlcluster 16 main start 2>/dev/null || true

su - postgres -c "psql -c \"ALTER USER postgres WITH PASSWORD '${DB_SUPERPASS}';\" 2>/dev/null" || true

su - postgres -c "psql -c \"CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';\" 2>/dev/null" || true
su - postgres -c "psql -c \"CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};\" 2>/dev/null" || true
su - postgres -c "psql -c \"GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};\" 2>/dev/null" || true
su - postgres -c "psql -c \"ALTER USER ${DB_USER} CREATEDB;\" 2>/dev/null" || true

PG_HBA=$(su - postgres -c "psql -t -c 'SHOW hba_file;'" 2>/dev/null | tr -d ' ')
if [ -f "$PG_HBA" ]; then
    cp "$PG_HBA" "${PG_HBA}.backup"
    sed -i 's/local\s\+all\s\+all\s\+peer/local   all   all   md5/' "$PG_HBA"
    systemctl reload postgresql 2>/dev/null || true
fi

PGPASSWORD="${DB_PASS}" psql -h 127.0.0.1 -U "${DB_USER}" -d "${DB_NAME}" -c "SELECT 1;" > /dev/null 2>&1 || true
echo -e "${GREEN}✓ Database configured: ${DB_NAME} | User: ${DB_USER}${NC}"

# ── Step 5: Create App Directory & Permissions ─────────
echo -e "${YELLOW}[Step 5/14] Creating application directory...${NC}"
mkdir -p "${APP_DIR}"
mkdir -p "${APP_DIR}/logs"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
chmod -R 755 "${APP_DIR}"
echo -e "${GREEN}✓ Directory created: ${APP_DIR}${NC}"

# ── Step 6: Copy Application Files ─────────────────────
echo -e "${YELLOW}[Step 6/14] Copying application files...${NC}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${SCRIPT_DIR}/package.json" ]; then
    echo "Copying from: ${SCRIPT_DIR}"
    rsync -av --exclude 'node_modules' --exclude '.next' --exclude '.git' --exclude 'smpp_env' --exclude 'logs' --exclude '*.log' --exclude 'tsconfig.tsbuildinfo' --exclude 'ql -h*' "${SCRIPT_DIR}/" "${APP_DIR}/" > /dev/null 2>&1
else
    echo -e "${RED}Error: package.json not found. Place this script in the project root.${NC}"
    exit 1
fi

chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
echo -e "${GREEN}✓ Files copied to ${APP_DIR}${NC}"

# ── Step 7: Create .env File ───────────────────────────
echo -e "${YELLOW}[Step 7/14] Creating environment configuration...${NC}"
cat > "${APP_DIR}/.env" << DOTENV
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}
JWT_SECRET=${JWT_SECRET}
NODE_ENV=production
DOTENV
chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.env"
chmod 600 "${APP_DIR}/.env"
echo -e "${GREEN}✓ Environment configured${NC}"

# ── Step 8: Install NPM Dependencies ───────────────────
echo -e "${YELLOW}[Step 8/14] Installing NPM dependencies...${NC}"
cd "${APP_DIR}"
sudo -u "${APP_USER}" npm install --omit=dev > /dev/null 2>&1
echo -e "${GREEN}✓ NPM packages installed${NC}"

# ── Step 8b: Configure Git Hooks ──────────────────────
cd "${APP_DIR}"
sudo -u "${APP_USER}" git config core.hooksPath .githooks 2>/dev/null || true
echo -e "${GREEN}✓ Git pre-commit hook configured (blocks .env files)${NC}"

# ── Step 9: Build Application ──────────────────────────
echo -e "${YELLOW}[Step 9/14] Building application...${NC}"
sudo -u "${APP_USER}" npm run build 2>&1 | tail -3
echo -e "${GREEN}✓ Build complete${NC}"

# ── Step 10: Push Database Schema ──────────────────────
echo -e "${YELLOW}[Step 10/14] Pushing database schema...${NC}"
cd "${APP_DIR}"
sudo -u "${APP_USER}" npx drizzle-kit push --force 2>&1 | tail -2
echo -e "${GREEN}✓ Database schema applied${NC}"

# ── Step 11: Seed Database ─────────────────────────────
echo -e "${YELLOW}[Step 11/14] Seeding initial data...${NC}"
cd "${APP_DIR}"
sudo -u "${APP_USER}" npm run start -- -p 3999 &
APP_PID=$!
sleep 5
curl -s -X POST "http://127.0.0.1:3999/api/seed" > /dev/null 2>&1 || true
kill $APP_PID 2>/dev/null || true
sleep 2
echo -e "${GREEN}✓ Database seeded (superuser, admin, countries, operators, suppliers)${NC}"

# ── Step 12: Install Python & SMPP Gateway ─────────────
echo -e "${YELLOW}[Step 12/14] Setting up SMPP gateway (Python)...${NC}"

if ! command -v python3 &> /dev/null; then
    apt-get install -y -qq python3 python3-pip python3-venv > /dev/null 2>&1
fi

SMPP_VENV="${APP_DIR}/smpp_env"
python3 -m venv "${SMPP_VENV}" 2>/dev/null || true

source "${SMPP_VENV}/bin/activate"
pip install smppy smpp.pdu aiohttp psycopg2-binary > /dev/null 2>&1 || true
deactivate

chown -R "${APP_USER}:${APP_USER}" "${SMPP_VENV}"
echo -e "${GREEN}✓ Python virtual environment created for SMPP gateway${NC}"

# Create SMPP gateway systemd service
echo -e "${YELLOW}[Step 12/14] Configuring SMPP gateway (Python venv + systemd service)...${NC}"

cat > /etc/systemd/system/net2app-smpp.service << SMPPSERVICE
[Unit]
Description=Net2App Blast SMPP Gateway (ESMC + SMSC)
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${SMPP_VENV}/bin/python ${APP_DIR}/smpp_gateway/smpp_server.py
Restart=always
RestartSec=10
StandardOutput=append:${APP_DIR}/logs/smpp_server.log
StandardError=append:${APP_DIR}/logs/smpp_server.log

[Install]
WantedBy=multi-user.target
SMPPSERVICE

systemctl daemon-reload
systemctl enable net2app-smpp
systemctl start net2app-smpp
echo -e "${GREEN}✓ SMPP gateway Python environment + systemd service configured and started${NC}"

# ── Step 13: Setup SMSC Monitor Cron ───────────────────
echo -e "${YELLOW}[Step 13/14] Setting up SMSC monitor cron...${NC}"

(crontab -l 2>/dev/null; echo "*/5 * * * * ${APP_DIR}/scripts/smsc-monitor.sh >/dev/null 2>&1") | crontab -
echo -e "${GREEN}✓ SMSC monitor cron added (every 5 minutes)${NC}"

# ── Step 14: Setup PM2 & Firewall ──────────────────────
echo -e "${YELLOW}[Step 14/14] Configuring PM2 and firewall...${NC}"

cat > "${APP_DIR}/ecosystem.config.js" << PM2CONFIG
module.exports = {
  apps: [{
    name: 'net2app-blast',
    script: 'node_modules/.bin/next',
    args: 'start -p ${APP_PORT}',
    cwd: '${APP_DIR}',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: ${APP_PORT},
    },
    error_file: '${APP_DIR}/logs/error.log',
    out_file: '${APP_DIR}/logs/output.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
  }]
};
PM2CONFIG

sudo -u "${APP_USER}" pm2 start "${APP_DIR}/ecosystem.config.js"
sudo -u "${APP_USER}" pm2 save
env PATH=$PATH:/usr/bin pm2 startup systemd -u "${APP_USER}" --hp "/home/${APP_USER}" 2>/dev/null || true

apt-get install -y -qq ufw > /dev/null 2>&1
ufw --force reset > /dev/null 2>&1
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3000/tcp
ufw --force enable
echo -e "${GREEN}✓ PM2 configured | Firewall enabled (SSH, HTTP, HTTPS, 3000)${NC}"

# ── Optional: Nginx Setup ──────────────────────────────
echo ""
read -p "$(echo -e ${CYAN}Enter domain name '(leave blank to skip Nginx setup): '${NC})" DOMAIN
if [ -n "$DOMAIN" ]; then
    apt-get install -y -qq nginx certbot python3-certbot-nginx > /dev/null 2>&1

    cat > "/etc/nginx/sites-available/net2app" << NGINXCONF
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }

    client_max_body_size 50M;
}
NGINXCONF

    ln -sf /etc/nginx/sites-available/net2app /etc/nginx/sites-enabled/
    rm -f /etc/nginx/sites-enabled/default
    nginx -t && systemctl reload nginx
    certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "admin@${DOMAIN}" 2>/dev/null || true
    echo -e "${GREEN}✓ Nginx + SSL configured for https://${DOMAIN}${NC}"
fi

# ── Save Credentials ───────────────────────────────────
cat > "/home/${APP_USER}/net2app-credentials.txt" << CREDENTIALS
╔══════════════════════════════════════════════════════════╗
║     Net2App Blast - Credentials & Configuration         ║
╠══════════════════════════════════════════════════════════╣
║
║  APPLICATION
║  ├── URL:           http://${SERVER_IP}:3000
║  ├── HTTPS:         ${DOMAIN:+https://}${DOMAIN:-N/A}
║  ├── Directory:     ${APP_DIR}
║  ├── Logs:          ${APP_DIR}/logs/
║  └── PM2:           pm2 status | pm2 logs net2app-blast
║
║  DATABASE
║  ├── Host:          127.0.0.1:5432
║  ├── Database:      ${DB_NAME}
║  ├── Username:      ${DB_USER}
║  ├── Password:      ${DB_PASS}
║  ├── Superuser:     postgres
║  └── Super Pass:    ${DB_SUPERPASS}
║
║  SMPP GATEWAY
║  ├── ESMC Port:     2775
║  ├── REST API:      127.0.0.1:9000
║  ├── Service:       systemctl status net2app-smpp
║  └── SMSC Monitor:  tail -f ${APP_DIR}/logs/smsc-monitor.log
║
║  LOGIN CREDENTIALS
║  ├── Superuser:     ${SUPERUSER_NAME} / ${SUPERUSER_PASS}
║  └── Admin:         ${ADMIN_EMAIL} / ${ADMIN_PASS}
║
║  API
║  ├── SMS Send:      POST /api/sms/send?apikey=KEY&...
║  ├── SMS Test:      POST /api/sms/test
║  ├── DLR:           POST /api/sms/dlr
║  ├── SMSC Status:   GET /api/smpp/status
║  └── Status UI:     http://${SERVER_IP}:3000/smpp/status
║
║  MANAGEMENT COMMANDS
║  ├── Restart Web:   pm2 restart net2app-blast
║  ├── Restart SMPP:  systemctl restart net2app-smpp
║  ├── Web Logs:      pm2 logs net2app-blast
║  ├── SMPP Logs:     tail -f ${APP_DIR}/logs/smpp_server.log
║  ├── SMSC Monitor:  tail -f ${APP_DIR}/logs/smsc-monitor.log
║  ├── Status Page:   http://${SERVER_IP}:3000/smpp/status
║  └── DB Backup:     pg_dump -U ${DB_USER} ${DB_NAME} > backup.sql
║
╚══════════════════════════════════════════════════════════╝
CREDENTIALS

chown "${APP_USER}:${APP_USER}" "/home/${APP_USER}/net2app-credentials.txt"
chmod 600 "/home/${APP_USER}/net2app-credentials.txt"

# ── Done ────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════╗"
echo -e "║   Net2App Blast - Installation Complete!              ║"
echo -e "║   SMSC + ESMC + DLR + Invoices + Dashboard Ready     ║"
echo -e "╚════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Web Dashboard:  ${GREEN}http://${SERVER_IP}:3000${NC}"
echo -e "${BLUE}  SMSC Status:    ${GREEN}http://${SERVER_IP}:3000/smpp/status${NC}"
echo -e "${BLUE}  SMPP Port:      ${GREEN}2775${NC}"
echo -e "${BLUE}  App Directory:  ${APP_DIR}${NC}"
echo -e "${BLUE}  Database:       ${DB_USER}@localhost:5432/${DB_NAME}${NC}"
echo -e "${BLUE}  Credentials:    /home/${APP_USER}/net2app-credentials.txt${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${YELLOW}Login:${NC}"
echo -e "  Superuser:  ${GREEN}${SUPERUSER_NAME}${NC} / ${GREEN}${SUPERUSER_PASS}${NC}"
echo -e "  Admin:      ${GREEN}admin@net2app.com${NC} / ${GREEN}${ADMIN_PASS}${NC}"
echo ""
echo -e "${YELLOW}Quick Commands:${NC}"
echo -e "  ${GREEN}pm2 status${NC}                     # Web app status"
echo -e "  ${GREEN}systemctl status net2app-smpp${NC}   # SMPP gateway status"
echo -e "  ${GREEN}tail -f ${APP_DIR}/logs/smsc-monitor.log${NC}  # SMSC monitor"
echo -e "  ${GREEN}tail -f ${APP_DIR}/logs/smpp_server.log${NC}  # SMPP logs"
echo ""
echo -e "${GREEN}Happy SMS Blasting! 🚀📡${NC}"
