# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# ─────────────────────────────────────────────────────────────────────────────
# gravity-mvp — CRM фронтенд/бэкенд (Next.js 16.1.6 + Prisma 6)
#
# Multi-stage build:
#   1. deps     — установка зависимостей (кэш переиспользуется)
#   2. builder  — генерация Prisma + сборка Next.js
#   3. runner   — финальный образ (только то, что нужно в рантайме)
#
# Размер итогового образа: ~600 MB (Node 20 + Next standalone-like + ffmpeg).
# ─────────────────────────────────────────────────────────────────────────────

# ─── Stage 1: deps ───────────────────────────────────────────────────────────
FROM node:20-bookworm-slim@sha256:3d0f05455dea2c82e2f76e7e2543964c30f6b7d673fc1a83286736d44fe4c41c AS deps
WORKDIR /app
# OpenSSL нужен Prisma для генерации schema engine
RUN rm -f /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20260801T000000Z bookworm main' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20260801T000000Z bookworm-updates main' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20260801T000000Z bookworm-security main' \
      > /etc/apt/sources.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY prisma ./prisma
# npm ci быстрее install + воспроизводимо. ignore-scripts чтобы prisma generate
# выполнить осознанно ниже (а не как побочный эффект).
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci --ignore-scripts --no-audit --no-fund

# ─── Stage 2: builder ────────────────────────────────────────────────────────
FROM node:20-bookworm-slim@sha256:3d0f05455dea2c82e2f76e7e2543964c30f6b7d673fc1a83286736d44fe4c41c AS builder
WORKDIR /app
RUN rm -f /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20260801T000000Z bookworm main' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20260801T000000Z bookworm-updates main' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20260801T000000Z bookworm-security main' \
      > /etc/apt/sources.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Prisma client (генерируется под текущую платформу)
RUN ./node_modules/.bin/prisma generate
# Next build — нужны переменные NEXT_PUBLIC_* во время сборки.
# Передаются через --build-arg в compose, чтобы они вкомпилировались в client bundle.
ARG NEXT_PUBLIC_AVITO_LEADS_URL=""
ARG NEXT_PUBLIC_MAX_SCRAPER_PHONE=""
ARG NEXT_PUBLIC_FORCE_SHOW_ALL_CHANNELS=""
ENV NEXT_PUBLIC_AVITO_LEADS_URL=$NEXT_PUBLIC_AVITO_LEADS_URL
ENV NEXT_PUBLIC_MAX_SCRAPER_PHONE=$NEXT_PUBLIC_MAX_SCRAPER_PHONE
ENV NEXT_PUBLIC_FORCE_SHOW_ALL_CHANNELS=$NEXT_PUBLIC_FORCE_SHOW_ALL_CHANNELS
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN npm run build

# ─── Stage 3: runner ─────────────────────────────────────────────────────────
FROM node:20-bookworm-slim@sha256:3d0f05455dea2c82e2f76e7e2543964c30f6b7d673fc1a83286736d44fe4c41c AS runner
WORKDIR /app

# Runtime зависимости:
#   - openssl: Prisma engine
#   - ffmpeg: голосовые / видео-сообщения в чатах
#   - tini: правильный PID 1 (graceful shutdown SIGTERM)
#   - chromium + libs: whatsapp-web.js использует puppeteer и требует системный
#     Chromium с GUI-зависимостями. Без них instrumentation.ts whatsapp_warmup
#     падает с "Failed to launch the browser process".
#   - fonts-liberation: рендеринг шрифтов в Chromium (иначе emoji-крокозябры)
RUN rm -f /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20260801T000000Z bookworm main' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20260801T000000Z bookworm-updates main' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20260801T000000Z bookworm-security main' \
      > /etc/apt/sources.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates ffmpeg tini \
    chromium fonts-liberation \
    libnss3 libatk-bridge2.0-0 libxkbcommon0 libpangocairo-1.0-0 \
    libgbm1 libxss1 libasound2 libxshmfence1 libgtk-3-0 libdrm2 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3002
ENV HOSTNAME=0.0.0.0
# Подсказка puppeteer-у использовать системный Chromium вместо загрузки своего.
# whatsapp-web.js → puppeteer → читает эти переменные.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
# npm cache в /tmp — наш CMD делает `npx prisma migrate deploy` под
# непривилегированным USER app, который не может писать в /app/.npm.
ENV NPM_CONFIG_CACHE=/tmp/.npm

# Непривилегированный пользователь — стандартная практика безопасности
RUN groupadd -r app && useradd -r -g app -d /app -s /sbin/nologin app

# Копируем артефакты сборки + node_modules (production-only после prune)
COPY --from=builder --chown=app:app /app/package.json /app/package-lock.json* ./
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/.next ./.next
COPY --from=builder --chown=app:app /app/public ./public
COPY --from=builder --chown=app:app /app/prisma ./prisma
# Prisma migrate deploy consumes only ./prisma/migrations. Operational,
# historical and one-shot scripts are deliberately absent from the runtime
# image; production maintenance goes through the finite operator control plane.
# Runtime-data: user-service.ts читает src/data/users.json через fs.readFile
# (server action). Без этого dropdown «Войти...» пустой и залогиниться нельзя.
COPY --from=builder --chown=app:app /app/src/data ./src/data

# Удаляем dev-зависимости (npm prune вместо отдельной stage — экономит слой)
RUN npm prune --omit=dev --ignore-scripts && npm cache clean --force

# Pre-create writable cache + ensure /app сам по себе writable для app user.
# Без chown /app — npx prisma migrate deploy не может писать в /tmp/.npm,
# а приложение не может писать в свой WORKDIR (recordings/, .next/cache/).
RUN mkdir -p /tmp/.npm /app/recordings /app/whatsapp_auth \
    && chown -R app:app /app /tmp/.npm

USER app
EXPOSE 3002

# Healthcheck — Next.js отдаёт 200 на корень после старта
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:3002/', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
# Prod-style деплой схемы: история миграций восстановлена (см. миграции
# *_drift / 20260612000000_sync_schema_drift) и эквивалентна schema.prisma.
# Существующая БД должна быть забейслайнена один раз:
#   npx prisma migrate resolve --applied <name> для каждой миграции
# Existing databases are baselined through the finite operator profile; normal
# starts only deploy migrations already present under ./prisma/migrations.
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
