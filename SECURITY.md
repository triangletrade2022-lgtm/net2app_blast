# Security Policy

## Supported Versions

We release patches for security vulnerabilities in the following versions:

| Version | Supported          |
|---------|--------------------|
| 1.x     | ✅ Active support  |
| < 1.0   | ❌ Not supported   |

## Reporting a Vulnerability

We take the security of Net2App Blast seriously. If you discover a security vulnerability, please **do not** open a public GitHub issue. Instead, report it privately.

### How to Report

1. **Email**: Send details to the repository maintainer via GitHub's private vulnerability reporting at:
   `https://github.com/triangletrade2022-lgtm/net2app_blast/security/advisories`

2. **Encrypted communication**: If the issue is sensitive, please encrypt your report using the GPG key available in the maintainer's GitHub profile.

### What to Include

- Type of vulnerability (e.g., SQL injection, XSS, authentication bypass)
- Full steps to reproduce the issue
- Affected components and versions
- Any proof-of-concept code (if applicable)
- Potential impact and suggested fix (if known)

### Response Timeline

- **48 hours**: Initial acknowledgment of your report (typically within 24 hours on weekdays)
- **5–7 days**: Assessment and confirmation of the vulnerability
- **14 days**: Release of a fix (depending on severity, may be expedited)
- **30 days**: Public disclosure after the fix is released

We aim to release patches within 14 days of confirmation. Critical vulnerabilities may be patched sooner.

## Security Best Practices

### Production Deployment

1. **Credentials**
   - Change all default passwords immediately after installation
   - Store credentials file (`net2app-credentials.txt`) in a secure, encrypted location
   - Rotate JWT secrets and database passwords regularly

2. **Network Security**
   - Run the SMPP gateway (port 2775) behind a firewall — do not expose it directly to the internet
   - Restrict REST API port 9000 to localhost (`127.0.0.1`) only
   - Use HTTPS (TLS 1.2+) for the web dashboard on port 3000
   - Use a reverse proxy (Nginx/Caddy) in front of the Next.js app
   - Enable UFW/iptables to restrict access to essential ports only

3. **Database**
   - Use strong, unique passwords for PostgreSQL users
   - Restrict PostgreSQL to `127.0.0.1` — do not expose to the network
   - Take regular encrypted backups
   - Apply PostgreSQL security patches promptly

4. **SMPP Gateway**
   - Configure IP whitelisting for ESME clients
   - Use strong system_id/password combinations for SMPP binds
   - Monitor connection logs for unauthorized bind attempts
   - Set TPS (transactions-per-second) limits per client

5. **Authentication**
   - Use strong JWT secrets (minimum 32 random characters)
   - Set appropriate token expiration times
   - Enable rate limiting on login endpoints (if behind a reverse proxy)

### Disclosure Policy

- We follow **coordinated disclosure**: vulnerabilities are reported privately, fixed, and then publicly disclosed after users have had reasonable time to update
- We credit researchers who report valid vulnerabilities (with their consent)
- We do not have a bug bounty program at this time, but we appreciate and acknowledge all serious reports

## Known Security Considerations

This platform handles SMS traffic which may contain sensitive data. Operators should:

- Ensure compliance with local telecommunications regulations (SMS interception laws, data protection)
- Log access to the dashboard and API endpoints for audit trails
- Review supplier and client activity regularly for abuse
- Use the balance/credit system to prevent runaway spending

## Dependencies

We use automated dependency scanning via Dependabot (when enabled on the repository). Security patches for direct dependencies are prioritized for backporting to supported versions.

For questions or concerns, please open a [security advisory](https://github.com/triangletrade2022-lgtm/net2app_blast/security/advisories) or contact the maintainers through GitHub.
