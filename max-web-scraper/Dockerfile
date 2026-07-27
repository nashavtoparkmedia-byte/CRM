# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# max-web-scraper — скрапер мессенджера MAX (web.max.ru)
#
# Playwright-based, single process (node index.js).
# Профиль браузера монтируется как volume для сохранения сессии между рестартами.
# ─────────────────────────────────────────────────────────────────────────────

FROM mcr.microsoft.com/playwright:v1.62.0-noble@sha256:baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07 AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM mcr.microsoft.com/playwright:v1.62.0-noble@sha256:baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07 AS sanitized-runtime
WORKDIR /app

ARG SOURCE_COMMIT=uncommitted
ARG BUILD_TIMESTAMP=unknown
LABEL org.opencontainers.image.title="max-web-scraper" \
      org.opencontainers.image.description="Single-owner MAX scraper with default-off durable shadow capture" \
      org.opencontainers.image.stage="8B1R" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.created="${BUILD_TIMESTAMP}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends tini=0.19.0-1 \
    && apt-get purge -y gstreamer1.0-plugins-bad libgstreamer-plugins-bad1.0-0 \
    && rm -rf /ms-playwright/firefox-* /ms-playwright/webkit-* \
        /root/.npm /usr/lib/node_modules/npm \
    && rm -f /usr/bin/npm /usr/bin/npx \
    && test ! -e /usr/lib/node_modules/npm \
    && test "$(find /ms-playwright -maxdepth 4 -type f -name chrome -perm /111 | wc -l)" -ge 1 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV TZ=Europe/Moscow

COPY --from=deps --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --chown=pwuser:pwuser . .

# Профиль и runtime-стейт — монтируются volume на VPS
RUN mkdir -p /app/userData \
    && chown -R pwuser:pwuser /app

USER pwuser

# Скрапер не слушает HTTP-порт — общается через CRM_WEBHOOK_URL.
# Healthcheck — наличие процесса.
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
    CMD pgrep -f "node.*index" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "index.js"]

# Flatten the sanitized root filesystem into a fresh image so files deleted from
# the Playwright base do not remain recoverable from lower OCI layers.
FROM scratch AS runner

ARG SOURCE_COMMIT=uncommitted
ARG BUILD_TIMESTAMP=unknown

COPY --from=sanitized-runtime / /
RUN /usr/bin/chown -R 1001:1001 /app /home/pwuser

LABEL org.opencontainers.image.title="max-web-scraper" \
      org.opencontainers.image.description="Single-owner MAX scraper with default-off durable shadow capture" \
      org.opencontainers.image.stage="8B1R" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.created="${BUILD_TIMESTAMP}" \
      org.opencontainers.image.base.name="mcr.microsoft.com/playwright:v1.62.0-noble" \
      org.opencontainers.image.base.digest="sha256:baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07"

ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_GC=1 \
    TZ=Europe/Moscow

WORKDIR /app
USER pwuser

HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
    CMD pgrep -f "node.*index" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "index.js"]
