# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# yandex-fleet-scraper — API + Worker для скрапинга диспетчерской Yandex Fleet
#
# Один Dockerfile, два сервиса в compose:
#   - api    : CMD ["npm","run","start:api"]    (HTTP-сервер для CRM-callbacks)
#   - worker : CMD ["npm","run","start:worker"] (Playwright + браузер)
#
# Базовый образ — официальный Playwright (Microsoft), уже содержит:
#   - Chromium с зависимостями (no need to install libnss3, libatk, etc.)
#   - Шрифты для рендеринга
#   - Правильные политики песочницы
# ─────────────────────────────────────────────────────────────────────────────

# Playwright 1.58.2 — версия из package.json
FROM mcr.microsoft.com/playwright:v1.58.2-jammy AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

FROM mcr.microsoft.com/playwright:v1.58.2-jammy AS runner
WORKDIR /app

# tini для корректного SIGTERM (Playwright не любит SIGKILL — оставит зомби-браузеры)
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_HEADLESS=true
ENV TZ=Europe/Moscow

# pwuser (UID 1000) — уже есть в официальном образе Playwright.
# Профили монтируются с правами 1000:1000 на хосте.
COPY --from=deps --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --chown=pwuser:pwuser . .

# Каталоги для профилей браузера + SQLite — будут смонтированы как volume на VPS.
# Заранее создаём + chown — иначе при mount volume будет owned by root и
# pwuser не сможет писать (Prisma "unable to open database file").
RUN mkdir -p /app/chrome_profile /app/chrome_user_data /app/data \
    && chown -R pwuser:pwuser /app

# prisma generate под pwuser — чтобы .prisma/client писалось в правильное место.
USER pwuser
RUN npx prisma generate

# API использует PORT из .env (по умолчанию 3003)
EXPOSE 3003

# Healthcheck — для API проверяем /health endpoint;
# для Worker — наличие Node-процесса (worker не слушает порт)
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:3003/health', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))" \
        || pgrep -f "tsx.*worker" >/dev/null \
        || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
# Дефолтный command — API. Worker переопределяется в compose:
#   command: ["npm","run","start:worker"]
CMD ["npm", "run", "start:api"]
