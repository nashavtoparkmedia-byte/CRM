# syntax=docker/dockerfile:1.7
FROM node:22.22.2-alpine3.23@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS dependencies
WORKDIR /app
COPY max-personal-gateway/package.json max-personal-gateway/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY gravity-mvp/prisma /app/prisma
RUN npx prisma generate --schema /app/prisma/schema.prisma \
    && npm prune --omit=dev \
    && npm cache clean --force

FROM node:22.22.2-alpine3.23@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS runtime
ARG SOURCE_COMMIT=uncommitted
ARG BUILD_TIMESTAMP=unknown
LABEL org.opencontainers.image.title="max-personal-gateway" \
      org.opencontainers.image.description="Browserless authenticated MAX shadow capture gateway" \
      org.opencontainers.image.stage="8B1R" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.created="${BUILD_TIMESTAMP}"
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-proto=throw
RUN apk add --no-cache libcrypto3=3.5.7-r0 libssl3=3.5.7-r0 \
    && rm -rf /root/.npm /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx \
    && test ! -e /usr/local/lib/node_modules/npm
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node max-personal-gateway/package.json ./package.json
COPY --chown=node:node max-personal-gateway/src ./src
COPY --chown=node:node gravity-mvp/prisma ./prisma
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "src/runtime/main.ts"]
