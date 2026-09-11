# Production release topology

One release authority: the checkout at `/opt/crm`, the compose file
`deploy/docker-compose.production.yml`, and `scripts/deploy.sh`. Nothing else
should deploy this project.

## Compose project and overlays

Every container in the project carries
`com.docker.compose.project=crm`, and `docker inspect` on a running container is
the authoritative answer to "which compose files define this service" — read
`com.docker.compose.project.config_files` rather than assuming.

A host may run project services from overlay compose files kept outside this
repository. `deploy.sh` performs `docker compose up -d --remove-orphans`, and
compose cannot distinguish "this service was deleted from the file" from "this
service is not in the file I was given" — so an undeclared service is removed.

Declare such files in `.env.production`:

```sh
COMPOSE_OVERLAY_FILES="/srv/releases/example/deploy/example.yml"
```

Each path is passed to every compose invocation. A missing path fails the
deploy rather than silently proceeding.

**Only additive overlays belong here.** An overlay that also re-pins the image
of a canonical service (`image:` together with `pull_policy: never`) freezes
that service and would defeat every subsequent deploy. A release freeze like
that is applied deliberately, not on every deploy.

## Orphan guard

Before `up --remove-orphans`, `deploy.sh` compares the services the compose
files define against the containers actually running in the project. If a
running service is not defined, the deploy stops and names it. Resolve it by
either declaring its overlay in `COMPOSE_OVERLAY_FILES` or making it a service
in the canonical compose file — never by removing the guard.

## What stays out of Git

`.env.production` (all secrets and host-specific values), rendered
`deploy/nginx/conf.d/*.conf` (generated from the tracked templates by envsubst
at deploy time), and every named volume. Volumes are independent of the
checkout and survive a branch switch; the checkout carries no data.

## Schema

The gravity-mvp image runs `prisma migrate deploy` at start, so the schema
advances only through committed migration files. Migrations applied on a host
that no longer exist in the repository are tolerated: `migrate deploy` applies
only what is pending and does not fail on extra recorded rows, nor on a
checksum that has drifted for an already-applied migration.
