# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# tg-bot — Telegram бот для опросов водителей
#
# Простой Node.js бот, работает через polling (по умолчанию).
# Не нужен HTTP-порт наружу — общается только с api.telegram.org и Postgres.
#
# Multi-stage: deps → runner (без отдельного build, .js файлы напрямую).
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
# Только production-зависимости — бот не нужен dev tooling
RUN npm ci --omit=dev --no-audit --no-fund

# ─── Runner ──────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates openssl tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV TZ=Europe/Moscow

# Непривилегированный пользователь
RUN groupadd -r app && useradd -r -g app -d /app -s /sbin/nologin app

COPY --from=deps --chown=app:app /app/node_modules ./node_modules
# Копируем только то, что нужно в runtime — исключаем debug-скрипты,
# database.sqlite (используем общий Postgres), логи
COPY --chown=app:app start.js package.json ./
COPY --chown=app:app src ./src
COPY --chown=app:app prisma ./prisma

# prisma generate — иначе @prisma/client не инициализирован при require.
# Делаем до USER чтобы у root были права записать .prisma/client.
RUN npx prisma generate && chown -R app:app /app/node_modules /app/prisma

USER app

# Healthcheck — проверяем что Node-процесс жив через файл-маркер,
# который бот трогает при успешном polling iteration (см. heartbeat watchdog
# в коммите 0b478da). Если бот делал heartbeat watchdog, файл /tmp/bot-alive
# должен обновляться. Пока — простая проверка процесса.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD pgrep -f "node.*bot" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "start.js"]
