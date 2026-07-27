# Rollback plan

Trigger on lost-before-spool, envelope collision, wrong-account difference, critical semantic regression, second browser owner, critical spool, legacy transport regression, failed authenticated ingress or gateway failure affecting the legacy owner.

Order: disable flag → stop drain → preserve spool → keep legacy scraper running → stop browserless gateway only when safe → retain additive migration and journal/comparison data → verify legacy health and one owner. Never replay uncertain outbound work.

Stage 8B2 execution template, not executed now:

```sh
cd /opt/crm
# Update only the approved secret store so MAX_PERSONAL_LIVE_CAPTURE_ENABLED is empty.
docker compose -f deploy/docker-compose.production.yml -f deploy/docker-compose.stage8b1.shadow.yml up -d --no-deps max-web-scraper
docker compose -f deploy/docker-compose.production.yml -f deploy/docker-compose.stage8b1.shadow.yml stop -t 10 max-personal-gateway
test -d /var/lib/crm/max-personal-capture
test "$(stat -c '%a' /var/lib/crm/max-personal-capture)" = "700"
docker ps --filter name=crm-max-scraper --format '{{.Names}} {{.Status}}'
```

Expected: legacy scraper remains healthy, gateway is stopped, spool still exists, no DB schema rollback occurs and no second browser owner exists. Estimated control-plane rollback is under five minutes, excluding diagnosis; pending spool data remains preserved indefinitely for reviewed recovery.
