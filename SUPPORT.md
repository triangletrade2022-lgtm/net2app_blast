# Support

## How to Get Help

If you need help with Net2App Blast, here's the best way to get it sorted:

### 1. Documentation (self-service)
Start here — most questions are already answered:

| Resource | Description |
|----------|-------------|
| [README.md](README.md) | Project overview, features, architecture, API reference |
| [INSTALLATION-GUIDE.md](INSTALLATION-GUIDE.md) | Step-by-step deployment instructions |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, coding guidelines, PR process |

### 2. GitHub Issues
Open a [GitHub Issue](https://github.com/triangletrade2022-lgtm/net2app_blast/issues) for:

- **Bug reports** — Include steps to reproduce, logs, and environment details
- **Feature requests** — Describe the use case and proposed solution
- **Questions** — Tag with `question` label

### 3. Security Vulnerabilities
**Do not** open a public issue for security vulnerabilities. Report privately via:
- https://github.com/triangletrade2022-lgtm/net2app_blast/security/advisories

See [SECURITY.md](SECURITY.md) for the full disclosure policy.

---

## Frequently Asked Questions

### Installation & Deployment

**Q: What are the minimum system requirements?**

- **OS**: Ubuntu 22.04 or 24.04 LTS
- **CPU**: 2 cores (4 recommended for production)
- **RAM**: 2 GB minimum, 4 GB recommended
- **Disk**: 10 GB free
- **Node.js**: 22.x
- **PostgreSQL**: 16
- **Python**: 3.10+

**Q: Does the one-line installer work on non-Ubuntu systems?**

No — the automated installer (`install-net2app.sh`) is designed for Ubuntu 22.04/24.04 LTS only. For other distributions, follow the manual setup steps in the README.

**Q: Can I use Docker instead of the installer?**

Docker support is not built-in yet but planned for a future release. For now, the installer handles all dependencies, services, and firewall configuration automatically.

**Q: How do I update to the latest version?**

```bash
cd /home/ubuntu/net2app
git pull origin master
npm ci --omit=dev
npm run build
pm2 restart net2app-blast
pm2 save
```

If the SMPP gateway has changes:
```bash
source smpp_env/bin/activate
pip install smppy smpp.pdu aiohttp psycopg2-binary
deactivate
systemctl restart net2app-smpp
```

### SMS & SMPP

**Q: SMS is not being sent. What should I check?**

Follow this checklist in order:

1. **Supplier status** — `curl http://localhost:3000/api/smpp/status` — verify a supplier is connected/bound
2. **Client balance** — Check `clients` table: `current_balance + credit_limit >= message cost`
3. **Rates** — Client rate must be **higher than** supplier rate (otherwise blocked to prevent loss)
4. **Route configuration** — A route must connect the client → trunk → supplier
5. **SMSC monitor logs** — `tail -f logs/smsc-monitor.log` — shows connection health
6. **SMPP gateway logs** — `tail -f logs/smpp_server.log` — shows SMPP protocol errors

**Q: What ports need to be open?**

| Port | Service | Required |
|------|---------|----------|
| 22 | SSH | Yes (remote access) |
| 80 | HTTP | Yes (reverse proxy / certbot) |
| 443 | HTTPS | Recommended |
| 3000 | Web dashboard/API | Yes |
| 2775 | SMPP ESMC server | Only if accepting SMPP client connections |
| 9000 | SMPP REST API (internal) | **No** — localhost only |

**Q: How do I configure a new SMSC supplier?**

1. Add the supplier via the dashboard or API: `POST /api/suppliers`
2. Set the supplier's `connection_type` to `"smpp"` for SMPP or `"http"` for HTTP API
3. For SMPP: configure `smpp_host`, `smpp_port`, `smpp_system_id`, `smpp_password`
4. For HTTP: configure `api_url`, `api_key`, and `api_params`
5. Add supplier rates: `POST /api/rates/supplier`
6. Create a trunk pointing to the supplier
7. Create a route with the trunk, and assign it to the client

The SMPP gateway will auto-discover new SMPP suppliers within 10 seconds.

**Q: What is ESMC vs SMSC?**

- **ESMC** (External Short Message Entity Controller) — The SMPP server that accepts connections from your client applications. Listens on port 2775.
- **SMSC** (Short Message Service Centre) Manager — Manages connections to upstream suppliers who deliver the actual SMS. Connects out to supplier SMPP servers.

**Q: ESME clients can connect but SMS doesn't arrive at the handset?**

This usually means the ESMC is working (SMPP binding OK) but no SMSC supplier is connected to forward the message. Check:

- `curl http://localhost:3000/api/smpp/status` — look at `suppliers` array
- `tail -f logs/smpp_server.log` — look for supplier connect/disconnect messages
- The SMSC monitor script will also log this

**Q: What is "force DLR"?**

Force DLR simulates a delivery receipt when the supplier doesn't send one. This is useful for HTTP API suppliers that don't support real-time DLR callbacks. Configure it per-client or per-supplier. When enabled, the SMS is marked as delivered after a configurable timeout.

### Monitoring

**Q: How do I check if everything is running?**

```bash
# Web app
pm2 status

# SMPP gateway
systemctl status net2app-smpp

# SMSC connection health
tail -f /home/ubuntu/net2app/logs/smsc-monitor.log

# Real-time status page (in browser)
# http://YOUR_SERVER:3000/smpp/status
```

**Q: The SMSC monitor keeps logging "disconnected". What's wrong?**

This means the SMPP gateway cannot connect to any upstream SMSC supplier. Common causes:

- Supplier credentials are incorrect
- The supplier's SMPP server is down or unreachable
- Firewall rules are blocking outbound SMPP connections
- The supplier's IP address/port is misconfigured

After 12 consecutive failures (~60 minutes), the monitor will automatically restart the SMPP gateway.

**Q: How do I view logs?**

```bash
tail -f /home/ubuntu/net2app/logs/output.log          # PM2 stdout
tail -f /home/ubuntu/net2app/logs/error.log           # PM2 errors
tail -f /home/ubuntu/net2app/logs/smpp_server.log     # SMPP gateway
tail -f /home/ubuntu/net2app/logs/smsc-monitor.log    # SMSC health monitor
```

### Database

**Q: How do I backup the database?**

```bash
pg_dump -U net2app_user -h 127.0.0.1 net2app_db > backup_$(date +%Y%m%d_%H%M%S).sql
```

**Q: How do I restore from a backup?**

```bash
psql -U net2app_user -h 127.0.0.1 net2app_db < backup.sql
```

**Q: The database schema has changed. How do I migrate?**

```bash
cd /home/ubuntu/net2app
npx drizzle-kit push --force
pm2 restart net2app-blast
```

### Security

**Q: I see "Bad credentials" when trying to push to GitHub?**

The token may be expired or lack the `repo` scope. Regenerate at:
GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)

**Q: How do I change the JWT secret?**

1. Update `.env`: `JWT_SECRET=new-secret-key`
2. Restart: `pm2 restart net2app-blast`
3. All existing sessions will be invalidated — users must log in again

**Q: Should I expose the SMPP port (2775) to the internet?**

No. Run the SMPP gateway behind a firewall. Only allow trusted ESME client IPs. Use a VPN or private network for production deployments.

---

## Troubleshooting Quick Reference

### Common HTTP Status Codes from the API

| Code | Meaning | Likely Cause |
|------|---------|-------------|
| 400 | Bad Request | Missing field, invalid rate, or rate validation failure |
| 401 | Unauthorized | Invalid or missing API key |
| 402 | Payment Required | Insufficient client or supplier balance |
| 403 | Forbidden | License expired, client inactive, or volume exceeded |
| 500 | Internal Error | Check PM2 logs for details |

### Quick Health Check

```bash
# Run this to verify all services
echo "=== Web App ==="
curl -s -o /dev/null -w 'Health: %{http_code}' http://127.0.0.1:3000/api/health
echo ""
echo "=== SMSC Status ==="
curl -s http://127.0.0.1:3000/api/smpp/status | python3 -m json.tool
echo "=== SMPP Gateway ==="
curl -s http://127.0.0.1:9000/api/smpp/status | python3 -m json.tool
echo "=== Database ==="
pg_isready -h 127.0.0.1
```

---

## Still Stuck?

If the FAQ and docs above didn't help:

1. **Search existing issues** — https://github.com/triangletrade2022-lgtm/net2app_blast/issues
2. **Open a new issue** — Provide logs, steps to reproduce, and environment details
3. **Security issues only** — Use the private advisory form linked in [SECURITY.md](SECURITY.md)

GitHub is the primary support channel. Response times vary but we aim to acknowledge issues within 2 business days.
