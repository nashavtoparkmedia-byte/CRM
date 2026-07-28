# Owner handoff — do not execute without architect approval

The package is prepared but the isolated root probe has not been authorized or executed. It does not deploy, restart production, connect to the production database, use Docker Compose, mount production resources, launch Chromium, connect to MAX, or perform provider actions.

The command below contains the prepared script SHA-256. The one separately approved action will be checksum-bound, verify the whole package, create only uniquely labelled disposable resources, restore the accepted root-only dump, apply migrations only to that restore, run synthetic tests, clean up, and hand off `/var/tmp/personal-max-stage8b1i-isolated-release-proof.json` as `root:codexbot:0640` without overwrite.

Exact command (prepared, not authorized):

`sudo /bin/bash /opt/codex-work/crm-personal-max-stage8b1r-release-hardening-20260727T220905Z/release/personal-max-stage8b1i/isolated-release-probe.sh 7d28be58f2f9815d5d349c32775e51e5d1e72bff9c0fd9b61b9fc2e00fd89219`

Expected success marker: `ISOLATED_RELEASE_PROOF_COMPLETED`. Any nonzero result must be reviewed through the sanitized failure report before another attempt; fixed report paths are no-clobber.
