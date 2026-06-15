# Net2App Blast - Complete Installation Guide
## Ubuntu 22.04 / 24.04 LTS Deployment

---

## ✅ Option A: Automated Installation (Recommended)

```bash
# 1. Upload project to server
scp -r ./net2app-blast ubuntu@YOUR_SERVER_IP:/home/ubuntu/

# 2. SSH into server and run
ssh ubuntu@YOUR_SERVER_IP
cd /home/ubuntu/net2app-blast
sudo bash install-net2app.sh

# 3. Follow the prompts (domain optional)
# 4. All credentials saved to: /home/ubuntu/net2app-credentials.txt
```

---

## 📖 Option B: Step-by-Step Manual Installation

### Step 1: System Update
```bash
sudo apt-get update -y
sudo apt-get upgrade -y
sudo apt-get install -y curl wget git build-essential software-properties-common gnupg2 ca-certificates lsb-release apt-transport-https unzip net-tools
```

### Step 2: Install Node.js 22.x
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v    # Verify: v22.x.x
npm -v     # Verify: 10.x.x

# Install PM2 globally
sudo npm install -g pm2
pm2 -v     # Verify
```

### Step 3: Install PostgreSQL 16
```bash
sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg
sudo apt-get update -y
sudo apt-get install -y postgresql-16 postgresql-client-16
```

### Step 4: Configure PostgreSQL
```bash
# Start PostgreSQL
sudo systemctl enable postgresql
sudo systemctl start postgresql

# Set postgres superuser password
sudo -u postgres psql -c "ALTER USER postgres WITH PASSWORD 'Ariyax2024Postgres';"

# Create database and user
sudo -u postgres psql -c "CREATE USER net2app_user WITH PASSWORD 'Ariyax2024Net2AppDB';"
sudo -u postgres psql -c "CREATE DATABASE net2app_db OWNER net2app_user;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE net2app_db TO net2app_user;"
sudo -u postgres psql -c "ALTER USER net2app_user CREATEDB;"

# Update authentication (find pg_hba.conf location)
PG_HBA=$(sudo -u postgres psql -t -c "SHOW hba_file;" | tr -d ' ')
sudo sed -i 's/local\s\+all\s\+all\s\+peer/local   all   all   md5/' "$PG_HBA"
sudo systemctl reload postgresql

# Test connection
PGPASSWORD='Ariyax2024Net2AppDB' psql -h 127.0.0.1 -U net2app_user -d net2app_db -c "SELECT 1;"
```

### Step 5: Create App Directory
```bash
sudo mkdir -p /home/ubuntu/net2app
sudo mkdir -p /home/ubuntu/net2app/logs
sudo chown -R ubuntu:ubuntu /home/ubuntu/net2app
sudo chmod -R 755 /home/ubuntu/net2app
```

### Step 6: Copy Application Files
```bash
# From your local machine:
scp -r ./src ./public ./package.json ./tsconfig.json ./next.config.ts ./postcss.config.mjs ./drizzle.config.json ./eslint.config.mjs ubuntu@YOUR_SERVER_IP:/home/ubuntu/net2app/

# Or if you have a zip:
unzip net2app-blast.zip -d /home/ubuntu/net2app/
```

### Step 7: Create .env File
```bash
sudo tee /home/ubuntu/net2app/.env << 'EOF'
DATABASE_URL=postgresql://net2app_user:Ariyax2024Net2AppDB@127.0.0.1:5432/net2app_db
JWT_SECRET=AriyaxNet2AppJWTSecretKey2024Secure
NODE_ENV=production
EOF

sudo chown ubuntu:ubuntu /home/ubuntu/net2app/.env
sudo chmod 600 /home/ubuntu/net2app/.env
```

### Step 8: Install NPM Dependencies
```bash
cd /home/ubuntu/net2app
npm install
```

### Step 9: Build Application
```bash
cd /home/ubuntu/net2app
npm run build
```

### Step 10: Push Database Schema
```bash
cd /home/ubuntu/net2app
npx drizzle-kit push --force
```

### Step 11: Seed Database
```bash
# Start app temporarily for seeding
cd /home/ubuntu/net2app
npm run start -- -p 3999 &
sleep 5

# Seed via API
curl -X POST http://127.0.0.1:3999/api/seed

# Stop temp server
kill $(lsof -t -i:3999) 2>/dev/null
```

### Step 12: Configure PM2 & Start
```bash
# Create PM2 ecosystem file
sudo tee /home/ubuntu/net2app/ecosystem.config.js << 'EOF'
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
  }]
};
EOF

# Start with PM2
cd /home/ubuntu/net2app
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u ubuntu --hp /home/ubuntu
```

### Step 13: Configure Firewall
```bash
sudo ufw --force reset
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3000/tcp
sudo ufw --force enable
```

### Step 14: (Optional) Nginx Reverse Proxy
```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx

sudo tee /etc/nginx/sites-available/net2app << 'EOF'
server {
    listen 80;
    server_name YOUR_DOMAIN.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
    client_max_body_size 50M;
}
EOF

sudo ln -sf /etc/nginx/sites-available/net2app /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# SSL:
sudo certbot --nginx -d YOUR_DOMAIN.com
```

---

## 🔧 Post-Installation

### Verify Installation
```bash
# Check app status
pm2 status

# View logs
pm2 logs net2app-blast

# Test API
curl http://localhost:3000/api/health
```

### Login
1. Open `http://YOUR_SERVER_IP:3000`
2. Login as **superuser** / **Telco1988**

### First-Time Setup
1. Go to **SMTP Config** → Configure your email settings
2. Go to **API Providers** → Manage Bangladeshi SMS APIs
3. Go to **Clients** → Add clients with rates
4. Go to **Suppliers** → Verify SMS Sheba is active
5. Go to **Test SMS** → Send a test message
6. Go to **SMSC Status** (`/smpp/status`) → Verify supplier connections

### SMSC Monitoring

```bash
# Add SMSC monitor to crontab (checks every 5 minutes)
crontab -e
# Add this line:
*/5 * * * * /home/ubuntu/net2app-platform/scripts/smsc-monitor.sh

# Monitor logs
tail -f /home/ubuntu/net2app-platform/logs/smsc-monitor.log
```

The SMSC status page at `/smpp/status` provides a real-time dashboard showing:
- Overall SMSC health indicator (all bound → green, partial → yellow, none → red)
- Per-supplier connection status cards with bound/unbound indicators
- ESME client session list (IP, system ID, bind status)
- Auto-refreshes every 5 seconds

---

## 📁 Directory Structure
```
/home/ubuntu/net2app/
├── .env                        # Environment config
├── package.json                # NPM config
├── ecosystem.config.js         # PM2 config
├── src/
│   ├── app/
│   │   ├── page.tsx           # Main dashboard
│   │   ├── layout.tsx         # Root layout
│   │   └── api/               # All API routes
│   ├── db/
│   │   ├── schema.ts          # Database schema
│   │   └── index.ts           # DB connection
│   └── lib/
│       ├── auth.ts            # Authentication
│       └── helpers.ts         # Utilities
├── logs/
│   ├── output.log
│   └── error.log
└── node_modules/
```

---

## 🔄 Database Backup & Restore

```bash
# Backup
PGPASSWORD='Ariyax2024Net2AppDB' pg_dump -U net2app_user -h 127.0.0.1 net2app_db > net2app_backup_$(date +%Y%m%d_%H%M%S).sql

# Restore
PGPASSWORD='Ariyax2024Net2AppDB' psql -U net2app_user -h 127.0.0.1 net2app_db < net2app_backup_YYYYMMDD_HHMMSS.sql
```

---

## 🆘 Troubleshooting

| Issue | Solution |
|-------|----------|
| Port 3000 not accessible | `sudo ufw allow 3000/tcp` |
| Database connection failed | Check `pg_hba.conf` has `md5` auth |
| PM2 app not starting | `pm2 logs net2app-blast --lines 50` |
| Build errors | `cd /home/ubuntu/net2app && npm run build` |
| Schema push fails | Drop schema: `sudo -u postgres psql -c "DROP DATABASE net2app_db; CREATE DATABASE net2app_db OWNER net2app_user;"` then re-push |
| Nginx 502 error | App may not be running: `pm2 status` |
