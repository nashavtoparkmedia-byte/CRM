# Production immutability

Before and after rollout, the root script compares `/opt/crm` HEAD/status, all `crm` project container state hashes, and restart-count hashes. The canonical status binding hashes the raw byte stream from `git status --porcelain=v2 --untracked-files=all`; it never sorts the 134-entry accepted stream. The new standalone project is not attached to `crm_internal`, production volumes, PostgreSQL, scraper, or MAX profile. No production service is restarted and no database connection is configured.
