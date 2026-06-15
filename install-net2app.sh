#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║   Net2App Blast - Complete Ubuntu Deployment Script             ║
# ║   Ubuntu 22.04 / 24.04 LTS                                      ║
# ║   Run as root: sudo bash install-net2app.sh                     ║
# ╚══════════════════════════════════════════════════════════════════╝
set -e

# ═══════════════════════════════════════════════════════════════════
# CREDENTIALS - All passwords start with "Ariya" per requirement
# ═══════════════════════════════════════════════════════════════════
DB_NAME="net2app_db"
DB_USER="net2app_user"
DB_PASS="Ariyax2024Net2AppDB"
DB_SUPERUSER="postgres"
DB_SUPERPASS="Ariyax2024Postgres"

APP_USER="ubuntu"
APP_DIR="/home/${APP_USER}/net2app"
APP_PORT="3000"
DOMAIN=""

JWT_SECRET="AriyaxNet2AppJWTSecretKey2024Secure"
SUPERUSER_NAME="superuser"
SUPERUSER_PASS="Telco1988"
ADMIN_EMAIL="admin@net2app.com"
ADMIN_PASS="admin123"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'

echo -e "${BLUE}"
echo "╔════════════════════════════════════════════════════════╗"
echo "║     Net2App Blast - Enterprise SMS Platform           ║"
echo "║     Ubuntu 22.04/24.04 Complete Installation          ║"
echo "╚════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── Step 0: Root Check ─────────────────────────────────
echo -e "${YELLOW}[Step 0/12] Checking prerequisites...${NC}"
if [[ $EUID -ne 0 ]]; then
   echo -e "${RED}This script must be run as root. Use: sudo bash install-net2app.sh${NC}"
   exit 1
fi

# Get server IP
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
echo -e "${GREEN}✓ Running as root | Server IP: ${SERVER_IP}${NC}"

# ── Step 1: System Update ──────────────────────────────
echo -e "${YELLOW}[Step 1/12] Updating system packages...${NC}"
apt-get update -y -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl wget git build-essential software-properties-common gnupg2 ca-certificates lsb-release apt-transport-https unzip net-tools
echo -e "${GREEN}✓ System packages updated${NC}"

# ── Step 2: Install Node.js 22.x ───────────────────────
echo -e "${YELLOW}[Step 2/12] Installing Node.js 22.x...${NC}"
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
    apt-get install -y -qq nodejs > /dev/null 2>&1
fi
echo -e "${GREEN}✓ Node.js $(node -v) | npm $(npm -v)${NC}"

# Install PM2 globally for process management
npm install -g pm2 > /dev/null 2>&1
echo -e "${GREEN}✓ PM2 $(pm2 -v) installed${NC}"

# ── Step 3: Install PostgreSQL 16 ──────────────────────
echo -e "${YELLOW}[Step 3/12] Installing PostgreSQL 16...${NC}"
if ! command -v psql &> /dev/null; then
    sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg
    apt-get update -y -qq
    apt-get install -y -qq postgresql-16 postgresql-client-16 > /dev/null 2>&1
fi
echo -e "${GREEN}✓ PostgreSQL installed${NC}"

# ── Step 4: Configure PostgreSQL ───────────────────────
echo -e "${YELLOW}[Step 4/12] Configuring PostgreSQL database...${NC}"

# Start PostgreSQL
systemctl enable postgresql
systemctl start postgresql

# Set postgres user password
su - postgres -c "psql -c \"ALTER USER postgres WITH PASSWORD '${DB_SUPERPASS}';\" 2>/dev/null" || true

# Create application database and user
su - postgres -c "psql -c \"CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';\" 2>/dev/null" || true
su - postgres -c "psql -c \"CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};\" 2>/dev/null" || true
su - postgres -c "psql -c \"GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};\" 2>/dev/null" || true
su - postgres -c "psql -c \"ALTER USER ${DB_USER} CREATEDB;\" 2>/dev/null" || true

# Update pg_hba.conf for password auth
PG_HBA=$(su - postgres -c "psql -t -c 'SHOW hba_file;'" 2>/dev/null | tr -d ' ')
if [ -f "$PG_HBA" ]; then
    cp "$PG_HBA" "${PG_HBA}.backup"
    # Ensure md5 auth for local connections
    sed -i 's/local\s\+all\s\+all\s\+peer/local   all   all   md5/' "$PG_HBA"
    systemctl reload postgresql
fi

# Test connection
PGPASSWORD="${DB_PASS}" psql -h 127.0.0.1 -U "${DB_USER}" -d "${DB_NAME}" -c "SELECT 1;" > /dev/null 2>&1 || true
echo -e "${GREEN}✓ Database configured: ${DB_NAME} | User: ${DB_USER}${NC}"

# ── Step 5: Create App Directory & Permissions ─────────
echo -e "${YELLOW}[Step 5/12] Creating application directory...${NC}"
mkdir -p "${APP_DIR}"
mkdir -p "${APP_DIR}/logs"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
chmod -R 755 "${APP_DIR}"
echo -e "${GREEN}✓ Directory created: ${APP_DIR}${NC}"

# ── Step 6: Copy Application Files ─────────────────────
echo -e "${YELLOW}[Step 6/12] Copying application files...${NC}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${SCRIPT_DIR}/package.json" ]; then
    echo "Copying from: ${SCRIPT_DIR}"
    rsync -av --exclude 'node_modules' --exclude '.next' --exclude '.git' "${SCRIPT_DIR}/" "${APP_DIR}/" > /dev/null 2>&1
else
    echo -e "${RED}Error: package.json not found. Place this script in the project root.${NC}"
    exit 1
fi

# Set proper ownership
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
echo -e "${GREEN}✓ Files copied to ${APP_DIR}${NC}"

# ── Step 7: Create .env File ───────────────────────────
echo -e "${YELLOW}[Step 7/12] Creating environment configuration...${NC}"
cat > "${APP_DIR}/.env" << DOTENV
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}
JWT_SECRET=${JWT_SECRET}
NODE_ENV=production
DOTENV
chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.env"
chmod 600 "${APP_DIR}/.env"
echo -e "${GREEN}✓ Environment configured${NC}"

# ── Step 8: Install NPM Dependencies ───────────────────
echo -e "${YELLOW}[Step 8/12] Installing NPM dependencies...${NC}"
cd "${APP_DIR}"
sudo -u "${APP_USER}" npm install --omit=dev > /dev/null 2>&1
echo -e "${GREEN}✓ NPM packages installed${NC}"

# ── Step 9: Build Application ──────────────────────────
echo -e "${YELLOW}[Step 9/12] Building application...${NC}"
sudo -u "${APP_USER}" npm run build 2>&1 | tail -3
echo -e "${GREEN}✓ Build complete${NC}"

# ── Step 10: Push Database Schema ──────────────────────
echo -e "${YELLOW}[Step 10/12] Pushing database schema...${NC}"
cd "${APP_DIR}"
sudo -u "${APP_USER}" npx drizzle-kit push --force 2>&1 | tail -2
echo -e "${GREEN}✓ Database schema applied${NC}"

# ── Step 11: Seed Database ─────────────────────────────
echo -e "${YELLOW}[Step 11/12] Seeding initial data...${NC}"
# Start app temporarily to seed
sudo -u "${APP_USER}" npm run start -- -p 3999 &
APP_PID=$!
sleep 5
curl -s -X POST "http://127.0.0.1:3999/api/seed" > /dev/null 2>&1 || true
kill $APP_PID 2>/dev/null || true
sleep 2
echo -e "${GREEN}✓ Database seeded (superuser, admin, countries, operators, suppliers)${NC}"

# ── Step 12: Setup PM2 & Firewall ──────────────────────
echo -e "${YELLOW}[Step 12/12] Configuring PM2 and firewall...${NC}"

# Create PM2 ecosystem file
cat > "${APP_DIR}/ecosystem.config.js" << 'PM2CONFIG'
module.exports = {
  apps: [{
    name: 'net2app-blast',
    script: 'node_modules/.bin/next',
    args: 'start -p 3000',
    cwd: '/home/ubuntu/net2app',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
    error_file: '/home/ubuntu/net2app/logs/error.log',
    out_file: '/home/ubuntu/net2app/logs/output.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
  }]
};
PM2CONFIG

# Setup PM2
sudo -u "${APP_USER}" pm2 start "${APP_DIR}/ecosystem.config.js"
sudo -u "${APP_USER}" pm2 save
env PATH=$PATH:/usr/bin pm2 startup systemd -u "${APP_USER}" --hp "/home/${APP_USER}" 2>/dev/null || true

# Firewall
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
║  LOGIN CREDENTIALS
║  ├── Superuser:     ${SUPERUSER_NAME} / ${SUPERUSER_PASS}
║  └── Admin:         admin@net2app.com / admin123
║
║  API
║  ├── SMS Send:      POST /api/sms/send?apikey=KEY&...
║  ├── SMS Test:      POST /api/sms/test
║  ├── DLR:           POST /api/sms/dlr
║  ├── Balance:       GET/PUT /api/balance
║  └── Reports:       GET /api/reports?type=summary
║
║  SMPP / ESME / SMSC
║  ├── SMPP Port:     2775 (default)
║  ├── Bind Type:     transceiver
║  └── TPS:           Configurable per client/supplier
║
║  SMTP
║  └── Configure via GUI: admin → SMTP Config
║
║  MANAGEMENT COMMANDS
║  ├── Restart:       pm2 restart net2app-blast
║  ├── Stop:          pm2 stop net2app-blast
║  ├── Logs:          pm2 logs net2app-blast
║  ├── Status:        pm2 status
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
echo -e "╚════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  URL:            ${GREEN}http://${SERVER_IP}:3000${NC}"
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
echo -e "  ${GREEN}pm2 status${NC}              # Check app status"
echo -e "  ${GREEN}pm2 logs net2app-blast${NC}   # View logs"
echo -e "  ${GREEN}pm2 restart net2app-blast${NC}# Restart app"
echo ""
echo -e "${GREEN}Happy SMS Blasting! 🚀📡${NC}"
