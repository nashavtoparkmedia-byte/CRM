# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# audio-bridge — Node.js WebSocket server для FreeSWITCH mod_audio_fork
#
# Принимает аудиостримы от FreeSWITCH, прогоняет через STT/LLM/TTS,
# отдаёт TTS обратно в звонок. Hold in-memory CallSession state.
#
# Без браузера/Chromium — чистый Node.js + ws + fetch.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund --omit=dev

FROM node:20-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV AUDIO_BRIDGE_PORT=3030

# Non-root user
RUN groupadd -r app && useradd -r -g app -d /app -s /sbin/nologin app

COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app . .

USER app
EXPOSE 3030

# Healthcheck: bridge сам отдаёт /health на main HTTP port
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:3030/health', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "start"]
