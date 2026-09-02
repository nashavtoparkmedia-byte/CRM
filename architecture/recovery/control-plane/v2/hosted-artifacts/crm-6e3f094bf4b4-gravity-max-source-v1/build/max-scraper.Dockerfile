# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM mcr.microsoft.com/playwright:v1.58.2-jammy@sha256:02627380acd41aa17ec78d3fb554be2fffd1f3c603d659aadafbdd6fb34289b0 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM mcr.microsoft.com/playwright:v1.58.2-jammy@sha256:02627380acd41aa17ec78d3fb554be2fffd1f3c603d659aadafbdd6fb34289b0 AS runner
WORKDIR /app

# Ubuntu jammy universe, frozen at the coordinated release snapshot. The
# repository metadata binds this exact package to the checksum below; remote
# ADD verifies the payload again before dpkg installs it. No mutable apt index
# participates in this release build.
ADD --checksum=sha256:91119fce795e668bb4db2c94d1416127688242e1856f2fcf8cf2112dde8da57d \
    https://snapshot.ubuntu.com/ubuntu/20260801T000000Z/pool/universe/t/tini/tini_0.19.0-1_amd64.deb \
    /tmp/tini.deb
RUN dpkg -i /tmp/tini.deb && rm -f /tmp/tini.deb

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV TZ=Europe/Moscow

COPY --from=deps --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --chown=pwuser:pwuser package.json package-lock.json index.js ./
COPY --chown=pwuser:pwuser contacts ./contacts
COPY --chown=pwuser:pwuser lib ./lib
COPY --chown=pwuser:pwuser media ./media
COPY --chown=pwuser:pwuser parser ./parser
COPY --chown=pwuser:pwuser session ./session
COPY --chown=pwuser:pwuser sync ./sync
COPY --chown=pwuser:pwuser transport ./transport

RUN mkdir -p /app/user_data && chown -R pwuser:pwuser /app

USER pwuser

HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
    CMD pgrep -f "node.*index" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "index.js"]
