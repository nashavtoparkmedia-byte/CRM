# Compose/service diff

Apply `deploy/docker-compose.production.yml` plus `deploy/docker-compose.stage8b1.shadow.yml` only in an approved Stage 8B2.

- `max-web-scraper` remains the sole Chromium/profile owner and receives one producer-only persistent spool bind mount.
- `max-personal-gateway` is a new non-root, read-only, browserless service on `crm_internal` with no host port, profile mount or provider dependency.
- PostgreSQL remains private on `crm_internal`; the gateway receives a dedicated explicit connection variable and never reads generic `DATABASE_URL`.
- No nginx route, sender, CRM projection, Route Registry mutation or provider transport is added.
- All four feature allowlists default empty. Merely starting the dormant gateway performs no DB connection or capture-ingress work.
