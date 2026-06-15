# Contributing to Net2App Blast

Thank you for considering contributing to Net2App Blast! We welcome contributions of all kinds — code, documentation, bug reports, and feature requests.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Coding Guidelines](#coding-guidelines)
- [Commit Conventions](#commit-conventions)
- [Pull Request Process](#pull-request-process)
- [Testing](#testing)
- [Reporting Issues](#reporting-issues)

## Code of Conduct

This project is governed by a simple code of conduct:

- **Be respectful** — Disagreements happen, but keep discussions constructive
- **Be inclusive** — Welcome contributors of all backgrounds and experience levels
- **Be collaborative** — Help others learn and grow
- **Focus on the code** — Keep discussions technical and productive

Violations can be reported to the maintainers via GitHub.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork**:
   ```bash
   git clone https://github.com/YOUR_USERNAME/net2app_blast.git
   cd net2app_blast
   ```
3. **Add the upstream remote**:
   ```bash
   git remote add upstream https://github.com/triangletrade2022-lgtm/net2app_blast.git
   ```
4. **Create a branch** for your work:
   ```bash
   git checkout -b feat/your-feature-name
   ```

## Development Setup

### Prerequisites

- **Node.js** 22.x (use [nvm](https://github.com/nvm-sh/nvm) to manage versions)
- **PostgreSQL** 16
- **Python** 3.10+ (for the SMPP gateway)
- **npm** or **pnpm**

### Step-by-step

```bash
# 1. Install Node dependencies
npm install

# 2. Create Python virtual environment for SMPP gateway
python3 -m venv smpp_env
source smpp_env/bin/activate
pip install smppy smpp.pdu aiohttp psycopg2-binary
deactivate

# 3. Create a local .env file
cat > .env << EOF
DATABASE_URL=postgresql://net2app_user:password@127.0.0.1:5432/net2app_db
JWT_SECRET=local-dev-secret-change-in-production
NODE_ENV=development
EOF

# 4. Create and seed the database
npx drizzle-kit push --force

# 5. Start the development servers
# Terminal 1: Next.js dev server
npm run dev

# Terminal 2: SMPP gateway
source smpp_env/bin/activate && python smpp_gateway/smpp_server.py
```

The development server will be at `http://localhost:3000`.

### Seed Data

To populate the database with sample data (countries, operators, admin user):

```bash
# With the dev server running on port 3000
curl -X POST http://localhost:3000/api/seed
```

Default seed credentials:
- Superuser: `superuser` / `Telco1988`
- Admin: `admin@net2app.com` / `admin123`

## Project Structure

```
net2app-platform/
├── src/
│   ├── app/
│   │   ├── page.tsx                    # Main SPA dashboard
│   │   ├── layout.tsx                  # Root layout (dark theme)
│   │   ├── smpp/status/page.tsx        # SMSC status UI
│   │   └── api/                        # Next.js API routes
│   ├── db/                             # Drizzle ORM schema + connection
│   └── lib/                            # Auth helpers, utilities
├── smpp_gateway/
│   └── smpp_server.py                  # SMPP ESMC + SMSC manager
├── scripts/                            # Monitoring + deployment scripts
├── drizzle/                            # Database migrations
├── install-net2app.sh                  # Automated installer
├── SECURITY.md                         # Security policy
├── CONTRIBUTING.md                     # Contribution guidelines
├── .github/workflows/ci.yml            # CI/CD workflows
└── smpp_gateway/                       # SMPP gateway (Python)
```

## Coding Guidelines

### TypeScript / Next.js

- **TypeScript strict mode** is enabled — use strict types everywhere. No `any` types.
- **Formatting**: Use the project's ESLint config. Run `npm run lint` before committing.
- **Naming**: Use `camelCase` for variables/functions, `PascalCase` for components/types, `UPPER_CASE` for constants.
- **Imports**: Use the `@/` path alias for local imports (e.g., `@/db/schema`).
- **API Routes**: Each route file exports named `GET`, `POST`, `PUT`, `DELETE` functions. Use the `ApiError` class for error responses.
- **Components**: Prefer Server Components by default. Use `'use client'` only when interactivity is needed.
- **CSS**: Use Tailwind CSS utility classes. Avoid custom CSS files unless absolutely necessary.

### Python (SMPP Gateway)

- **Target**: Python 3.10+
- **Style**: Use `ruff` for linting. Run `ruff check smpp_gateway/` before committing.
- **Async**: The SMPP gateway uses `asyncio` throughout. Use `async/await` for all I/O operations.
- **Error handling**: Log errors with context. Don't silently swallow exceptions.
- **DB access**: Use `psycopg2` directly. Keep queries in the gateway file.

### Bash Scripts

- **Shebang**: Use `#!/bin/bash` (not `#!/bin/sh`)
- **Safety**: Use `set -e` for error handling
- **Style**: Use `[[ ]]` for conditionals, quote all variables

## Commit Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short description>

[optional body]

[optional footer]
```

### Types

| Type       | Usage                                    |
|------------|------------------------------------------|
| `feat`     | A new feature                            |
| `fix`      | A bug fix                                |
| `docs`     | Documentation changes                    |
| `style`    | Formatting, whitespace (no code change)  |
| `refactor` | Code restructuring (no behavior change)  |
| `perf`     | Performance improvement                  |
| `test`     | Adding or updating tests                 |
| `chore`    | Build process, tooling, dependencies     |
| `ci`       | CI/CD configuration changes              |

### Examples

```
feat(api): add rate limiting to SMS endpoints
fix(monitor): handle null session list in status endpoint
docs(readme): update installation instructions
ci(actions): add Python lint job to workflow
```

## Pull Request Process

1. **Keep PRs focused** — One feature/fix per PR. Break large changes into smaller, reviewable PRs.
2. **Write good descriptions** — Explain what the change does, why it's needed, and how to test it.
3. **Link issues** — Reference any related GitHub issues (e.g., `Closes #42`).
4. **Pass CI** — Ensure all CI checks pass (typecheck, lint, build).
5. **Review** — Maintainers will review your PR. Be responsive to feedback.
6. **Squash merge** — PRs are squash-merged into `master` with a clean commit message.

### Before Submitting

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes (no new warnings)
- [ ] `npm run build` succeeds
- [ ] `ruff check smpp_gateway/` passes (if Python changes)
- [ ] You've updated documentation if needed
- [ ] You've added or updated tests if applicable

## Testing

We aim for comprehensive test coverage. The CI pipeline runs:

1. **TypeScript typecheck** (`npm run typecheck`) — catches type errors
2. **ESLint** (`npm run lint`) — catches code quality issues
3. **Next.js build** (`npm run build`) — catches build errors
4. **Python lint** (`ruff check`) — catches Python issues
5. **Bash syntax** (`bash -n`) — validates shell scripts

If you add a new feature, consider including:
- Unit tests for API route handlers
- Integration tests for the SMPP gateway
- TypeScript type guards for new data structures

## Reporting Issues

### Bug Reports

When filing a bug report, include:

- **Description** — What happened vs. what you expected
- **Steps to reproduce** — Minimal, reproducible steps
- **Environment** — OS, Node.js version, PostgreSQL version, deployment method
- **Logs** — Relevant log output from `pm2 logs`, `smpp_server.log`, or `smsc-monitor.log`
- **Screenshots** — If applicable

### Feature Requests

Feature requests are welcome! Include:

- **Use case** — What problem does this solve?
- **Proposed solution** — How should it work?
- **Alternatives** — Any workarounds you've considered
- **Priority** — Nice-to-have vs. blocking

---

Thank you for contributing! Every issue, PR, and discussion helps make this project better. 🚀
