# Exact blockers

Decision: `SCRAPER_DEFAULT_OFF_PACKAGE_BLOCKED`.

The accepted root preflight proves container/image/mount/network/port/restart/health and runtime UID metadata, but it deliberately did not obtain Docker top/listener ownership and did not preserve actual entrypoint, command, workdir, complete environment-name set, full labels/dependencies, or profile filesystem UID/GID/modes. The tracked Compose file is not authoritative because `/opt/crm` has accepted dirty state and cannot substitute for an inspect snapshot.

The UID transition from 1000 to 1001 is a concrete incompatibility risk. A guessed `docker run`, Compose recreation from unresolved `.env.production`, second scraper/browser, profile permission change, or profile copy would cross prohibited boundaries. Therefore this package contains no rollout script and no root command template. Independent Phase E continues.
