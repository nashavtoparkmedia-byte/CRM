# Exact Stage 8B2 execution sequence

These commands are templates requiring explicit owner approval and secret provisioning. Stage 8B1 does not execute them.

1. Record production HEAD/status, running image digests, Compose checksum, DB version and single profile owner.
2. Create and verify a database backup without printing credentials:

   ```sh
   install -d -m 0700 /var/backups/crm-stage8b2
   docker exec crm-postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /tmp/pre-stage8b2.dump'
   docker exec crm-postgres pg_restore --list /tmp/pre-stage8b2.dump >/dev/null
   docker cp crm-postgres:/tmp/pre-stage8b2.dump /var/backups/crm-stage8b2/pre-stage8b2.dump
   test -s /var/backups/crm-stage8b2/pre-stage8b2.dump
   sha256sum /var/backups/crm-stage8b2/pre-stage8b2.dump
   ```

3. Save exact current Compose and image-digest metadata; provision HMAC keys and the dedicated gateway DB URL through the existing protected secret mechanism.
4. Run the spool setup commands from `spool-mount.md`.
5. Load or pull only the reviewed immutable Stage 8B1 image digests and verify them.
6. Run the migration exactly once, without gateway auto-migration:

   ```sh
   docker run --rm --network crm_internal --env MAX_PERSONAL_GATEWAY_DATABASE_URL \
     --entrypoint sh <approved-gateway-image-digest> \
     -c 'DATABASE_URL="$MAX_PERSONAL_GATEWAY_DATABASE_URL" npx prisma migrate deploy --schema /app/prisma/schema.prisma'
   ```

7. Start the gateway dormant and require `dormant-ready`.
8. Enable raw journal, normalizer, comparison and capture only for one approved existing account; recreate only the two approved services.
9. Run smoke checks and observe for the owner-approved window.
10. Roll back immediately on any trigger from `rollback.md`; preserve the additive migration, spool and evidence.
