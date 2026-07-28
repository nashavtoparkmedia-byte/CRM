# Production immutability

Before and after rollout, the root script compares `/opt/crm` HEAD/status, all `crm` project container state hashes, and restart-count hashes. The new standalone project is not attached to `crm_internal`, production volumes, PostgreSQL, scraper, or MAX profile. No production service is restarted and no database connection is configured.
