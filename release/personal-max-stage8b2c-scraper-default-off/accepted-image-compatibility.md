# Accepted-image compatibility

Offline source evidence proves the accepted image keeps `/app` as workdir, `/usr/bin/tini --` plus `node index.js`, the existing `/app/user_data` profile path, the process health pattern, Chromium persistent-context ownership in the existing scraper, and legacy MAX/CRM behavior. The live-capture factory returns `NoopCaptureAdapter` before reading or creating a spool whenever the account-scoped flag is absent; therefore capture-off adds no spool, drain timer, gateway request, or database access.

Compatibility is not sufficient for rollout: the observed current process is UID/GID `1000:1000`, while the accepted image is `1001:1001`. The root preflight did not collect ownership/mode for existing profile contents. Recreating the scraper with UID 1001 could lose read/write access or provoke ownership drift and profile lock failure. No chown is safe without a separately reviewed ownership plan.
