# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# tg-bot-frontend — Next.js 14 админка для управления опросами
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
# next.config.mjs bakes the /api/admin rewrite destination into routes-manifest
# at `next build` time — runtime env is too late. Without this the proxy froze
# to http://localhost:3001 → ECONNREFUSED in the container → bot creation 500.
# Default to the compose service name; override via --build-arg for other setups.
ARG TG_BOT_API_URL=http://tg-bot:3001
ENV TG_BOT_API_URL=${TG_BOT_API_URL}
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3004
ENV HOSTNAME=0.0.0.0

RUN groupadd -r app && useradd -r -g app -d /app -s /sbin/nologin app

COPY --from=builder --chown=app:app /app/package.json /app/package-lock.json* ./
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/.next ./.next
COPY --from=builder --chown=app:app /app/public ./public

RUN npm prune --omit=dev && npm cache clean --force

USER app
EXPOSE 3004

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:3004/', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npx", "next", "start", "-p", "3004"]
