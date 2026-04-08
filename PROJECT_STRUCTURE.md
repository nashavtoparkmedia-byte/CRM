# Project Structure

Internal CRM for managing drivers and analytics (NashAvtoParkMedia).

## Modules

| Module | Directory | Stack | Port | Purpose |
|--------|-----------|-------|------|---------|
| CRM | `gravity-mvp/` | Next.js 16, React 19, Prisma, Tailwind | 3002 | Main CRM — UI, API, message pipeline, AI |
| MAX Scraper | `max-web-scraper/` | Node.js, Express, Playwright | 3005 | Web scraper for MAX messenger |
| TG Bot | `tg-bot/` | Node.js, Telegraf, Express, Prisma | 3001 | Telegram bot + handlers |
| TG Bot Frontend | `tg-bot/tg-bot-frontend/` | Next.js 14 | 3004 | Telegram bot admin panel |
| Yandex Scraper | `yandex-fleet-scraper/` | Fastify, BullMQ, Playwright, Prisma | .env | Yandex.Fleet data scraper |

## Launch

All services at once:
```
start-all.bat
```

Individual (from project root):
```
cd gravity-mvp && npm run dev
cd yandex-fleet-scraper && npm run start:api
cd yandex-fleet-scraper && npm run start:worker
cd max-web-scraper && node index.js
cd tg-bot && npm start
cd tg-bot/tg-bot-frontend && npm run dev
```

## Claude Integration

All Claude-specific files are inside `.claude/`:

```
.claude/
  skills/         10 automation skills (db-check, health, deploy-check, etc.)
  knowledge/      Domain knowledge base (anti-ghost logic, messenger reference)
  workflows/      Service launch documentation
  launch.json     Preview server config
```

Key files in project root:
- `CLAUDE.md` — primary instructions for Claude Code
- `.cursorrules` — instructions for Cursor/Antigravity

## Configuration

| File | Purpose |
|------|---------|
| `.env` (per module) | Environment variables, secrets, DB URLs |
| `.mcp.json` | MCP server config (Context7, PostgreSQL) |
| `.vscode/tasks.json` | VS Code task runner (launch all services) |
| `.gitignore` | Excludes node_modules, .env, browser sessions, worktrees |

## Database

PostgreSQL via Prisma ORM. Schema: `gravity-mvp/prisma/schema.prisma`.

Core entities: Contact, ContactIdentity, Chat, Message, Driver.

## Channels

- **WhatsApp** — whatsapp-web.js + Puppeteer
- **Telegram** — GramJS + SOCKS5 proxy
- **MAX** — web scraper (CDP + WebSocket intercept)
- **Yandex.Pro** — read-only fleet data
