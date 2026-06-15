#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Net2App Blast - SMS Gateway Platform Deployment Script
# Supports: Ubuntu 20.04+, Debian 11+
# ═══════════════════════════════════════════════════════════════

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'
APP_DIR="/opt/net2app-blast"
NODE_VERSION="22"

echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     Net2App Blast - Deployment Script   ║${NC}"
echo -e "${BLUE}║        Enterprise SMS Gateway Platform   ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"
echo ""

# ── Check root ──────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
   echo -e "${RED}This script must be run as root. Use: sudo ./deploy.sh${NC}"
   exit 1
fi

# ── System Update ───────────────────────────────────────
echo -e "${YELLOW}[1/9] Updating system packages...${NC}"
apt-get update -qq && apt-get upgrade -y -qq
echo -e "${GREEN}✓ System updated${NC}"

# ── Install Dependencies ────────────────────────────────
echo -e "${YELLOW}[2/9] Installing dependencies...${NC}"
apt-get install -y -qq curl wget git build-essential nginx certbot python3-certbot-nginx ufw > /dev/null 2>&1
echo -e "${GREEN}✓ Dependencies installed${NC}"

# ── Install Node.js ─────────────────────────────────────
echo -e "${YELLOW}[3/9] Installing Node.js ${NODE_VERSION}...${NC}"
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - > /dev/null 2>&1
    apt-get install -y -qq nodejs > /dev/null 2>&1
fi
echo -e "${GREEN}✓ Node.js $(node -v) installed${NC}"

# ── Install PostgreSQL ──────────────────────────────────
echo -e "${YELLOW}[4/9] Installing PostgreSQL...${NC}"
if ! command -v psql &> /dev/null; then
    apt-get install -y -qq postgresql postgresql-contrib > /dev/null 2>&1
fi

# Configure PostgreSQL
DB_NAME="net2app_db"
DB_USER="net2app"
DB_PASS=$(openssl rand -base64 24 | tr -d '+/=')

su - postgres -c "psql -c \"CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';\" 2>/dev/null" || true
su - postgres -c "psql -c \"CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};\" 2>/dev/null" || true
su - postgres -c "psql -c \"GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};\" 2>/dev/null" || true
su - postgres -c "psql -c \"ALTER USER ${DB_USER} CREATEDB;\" 2>/dev/null" || true
echo -e "${GREEN}✓ PostgreSQL configured${NC}"

# ── Setup Application ───────────────────────────────────
echo -e "${YELLOW}[5/9] Setting up Net2App Blast...${NC}"

# Create app directory
mkdir -p ${APP_DIR}

# Copy application files (run from project root)
if [ -f "./package.json" ]; then
    echo "Copying application files from current directory..."
    cp -r ./* ${APP_DIR}/ 2>/dev/null || true
    cp -r ./.env* ${APP_DIR}/ 2>/dev/null || true
    cp -r ./src ${APP_DIR}/ 2>/dev/null || true
    cp -r ./public ${APP_DIR}/ 2>/dev/null || true
else
    echo -e "${RED}Error: package.json not found. Run from project root.${NC}"
    exit 1
fi

# Create .env file
cat > ${APP_DIR}/.env << EOF
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}
JWT_SECRET=$(openssl rand -base64 48 | tr -d '+/=')
NODE_ENV=production
EOF

echo -e "${GREEN}✓ Environment configured${NC}"

# ── Install NPM Dependencies ────────────────────────────
echo -e "${YELLOW}[6/9] Installing NPM dependencies...${NC}"
cd ${APP_DIR}
npm install --production > /dev/null 2>&1
echo -e "${GREEN}✓ NPM dependencies installed${NC}"

# ── Build Application ───────────────────────────────────
echo -e "${YELLOW}[7/9] Building application...${NC}"
npm run build 2>&1 | tail -1
echo -e "${GREEN}✓ Build complete${NC}"

# ── Push Database Schema ────────────────────────────────
echo -e "${YELLOW}[8/9] Setting up database schema...${NC}"
npx drizzle-kit push --force 2>&1 | tail -1
echo -e "${GREEN}✓ Database schema applied${NC}"

# ── Setup Systemd Service ───────────────────────────────
echo -e "${YELLOW}[9/9] Configuring systemd service...${NC}"

cat > /etc/systemd/system/net2app-blast.service << EOF
[Unit]
Description=Net2App Blast SMS Gateway
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node ${APP_DIR}/node_modules/.bin/next start -p 3000
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PORT=3000
StandardOutput=append:/var/log/net2app-blast.log
StandardError=append:/var/log/net2app-blast-error.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable net2app-blast
systemctl start net2app-blast

echo -e "${GREEN}✓ Service configured and started${NC}"

# ── Nginx Reverse Proxy ─────────────────────────────────
read -p "Enter your domain name (or leave blank for IP-only): " DOMAIN_NAME
read -p "Enter admin email: " ADMIN_EMAIL

if [ -n "$DOMAIN_NAME" ]; then
    cat > /etc/nginx/sites-available/net2app-blast << EOF
server {
    listen 80;
    server_name ${DOMAIN_NAME};

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
    }
}
EOF

    ln -sf /etc/nginx/sites-available/net2app-blast /etc/nginx/sites-enabled/
    rm -f /etc/nginx/sites-enabled/default
    nginx -t && systemctl reload nginx

    # SSL with Certbot
    certbot --nginx -d ${DOMAIN_NAME} --non-interactive --agree-tos -m ${ADMIN_EMAIL} 2>/dev/null || true
    echo -e "${GREEN}✓ Nginx + SSL configured for ${DOMAIN_NAME}${NC}"
else
    echo -e "${YELLOW}⚠ No domain specified. App running at http://YOUR_IP:3000${NC}"
    echo -e "${YELLOW}  To configure Nginx, edit /etc/nginx/sites-available/net2app-blast${NC}"
fi

# ── Firewall ────────────────────────────────────────────
echo -e "${YELLOW}Configuring firewall...${NC}"
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3000/tcp
ufw --force enable
echo -e "${GREEN}✓ Firewall configured${NC}"

# ── Done ────────────────────────────────────────────────
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Net2App Blast Deployment Complete!     ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Access URL:     ${GREEN}http://${SERVER_IP}:3000${NC}"
if [ -n "$DOMAIN_NAME" ]; then
    echo -e "${BLUE}  HTTPS URL:      ${GREEN}https://${DOMAIN_NAME}${NC}"
fi
echo -e "${BLUE}  App Directory:  ${APP_DIR}${NC}"
echo -e "${BLUE}  Database:       postgresql://${DB_USER}@localhost:5432/${DB_NAME}${NC}"
echo -e "${BLUE}  Logs:           /var/log/net2app-blast.log${NC}"
echo -e "${BLUE}  Service:        systemctl status net2app-blast${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${YELLOW}First steps:${NC}"
echo -e "  1. Open ${GREEN}http://${SERVER_IP}:3000${NC}"
echo -e "  2. Click \"Initialize Database\" to seed data"
echo -e "  3. Login: ${GREEN}superuser${NC} / ${GREEN}Telco1988${NC}"
echo ""
echo -e "${YELLOW}Service Commands:${NC}"
echo -e "  ${GREEN}systemctl restart net2app-blast${NC} - Restart app"
echo -e "  ${GREEN}systemctl stop net2app-blast${NC}    - Stop app"
echo -e "  ${GREEN}journalctl -u net2app-blast -f${NC}  - View logs"
echo ""
echo -e "${YELLOW}Database Backup:${NC}"
echo -e "  ${GREEN}pg_dump ${DB_NAME} > backup_\$(date +%Y%m%d).sql${NC}"
echo ""
echo -e "${GREEN}Happy SMS Blasting! 🚀📡${NC}"
