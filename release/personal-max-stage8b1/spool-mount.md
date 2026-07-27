# Persistent spool mount contract

The producer-only host path is `/var/lib/crm/max-personal-capture`, mounted at `/var/lib/max-personal-capture` only in `max-web-scraper`. It is outside the source tree and Chromium profile. It is never mounted into `max-personal-gateway`.

Stage 8B2 root setup action, not executed by Stage 8B1:

```sh
install -d -o 1000 -g 1000 -m 0700 /var/lib/crm/max-personal-capture
test "$(stat -c '%u:%g:%a' /var/lib/crm/max-personal-capture)" = "1000:1000:700"
```

Segments and watermarks are mode `0600`; directories are `0700`. The spool is bounded by configured maximum bytes with warning and critical thresholds. It survives container restart/recreation. No segment is removed before contiguous journal ACK. Rollback preserves the directory and all pending records.
