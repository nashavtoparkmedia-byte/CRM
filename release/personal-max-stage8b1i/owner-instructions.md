# Owner handoff — do not execute without architect approval

The package is prepared but the isolated root probe has not been authorized or executed. It does not deploy, restart production, connect to the production database, use Docker Compose, mount production resources, launch Chromium, connect to MAX, or perform provider actions.

The command below contains the prepared script SHA-256. The one separately approved action will be checksum-bound, verify the whole package, use centralized deadlines, print only safe phase names, create only uniquely labelled disposable resources, restore the accepted root-only dump, apply migrations only to that restore, run synthetic tests, perform bounded cleanup, validate the success report, and hand off `/var/tmp/personal-max-stage8b1i-isolated-release-proof.json` as `root:codexbot:0640` without overwrite.

Exact command (prepared, not authorized):

`sudo /bin/bash /opt/codex-work/crm-personal-max-stage8b1r-release-hardening-20260727T220905Z/release/personal-max-stage8b1i/isolated-release-probe.sh 57d7cba75198c002de902d1ef569681eb14d89e594ca9488214cd99fb3ec4d38`

Expected success marker: `ISOLATED_RELEASE_PROOF_COMPLETED`. Any nonzero result must be reviewed through the sanitized failure report before another attempt; fixed report paths are no-clobber.
