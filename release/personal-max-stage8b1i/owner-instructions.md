# Owner handoff — do not execute without architect approval

The package is prepared but the isolated root probe has not been authorized or executed. It does not deploy, restart production, connect to the production database, use Docker Compose, mount production resources, launch Chromium, connect to MAX, or perform provider actions.

The command below contains the prepared script SHA-256. That script is the trust anchor: before any package helper is sourced, executed, or mounted, it requires regular non-symlink exact paths and hardcoded SHA-256 values for all eight consumed runtime artifacts (`failure-diagnostics.sh`, `bounded-operations.sh`, `probe-output-helpers.sh`, both migration SQL gate inputs, the Prisma legacy-diff gate, and both executable harnesses). `SHA256SUMS` remains a complete package ledger, but cannot replace those embedded bindings and is deliberately not circularly self-bound. A paired malicious helper plus matching substituted `SHA256SUMS` is refused before helper execution.

The one separately approved action will also use centralized deadlines, print only safe phase names, and fail before accepted-image inspection or acquisition unless `/opt/crm` still has accepted HEAD `e6a0a833fbb756216b058bfe326f9f9c77c4cc6d` and raw unsorted porcelain-v2 SHA-256 `2958f4cc4849e2248b73cff4d0aa779f33f0008d602bb5294326eb01ba44a60b`. It will create only uniquely labelled disposable resources, restore the accepted root-only dump, bind the exact eight migration SQL files by SHA-256, apply them only to that restore, accept only the documented two-column legacy `DriverTelegram` Prisma drift, run synthetic tests, perform bounded cleanup, validate the success report, and hand off `/var/tmp/personal-max-stage8b1i-isolated-release-proof.json` as `root:codexbot:0640` without overwrite. Raw production status, raw Prisma diff text, and production data values are not included in the report.

Exact command (prepared, not authorized):

`sudo /bin/bash /opt/codex-work/crm-personal-max-stage8b1r-release-hardening-20260727T220905Z/release/personal-max-stage8b1i/isolated-release-probe.sh dbbdaf7a33e3d7bf0e81a6471e5f2461d7042b7b3efdc993f3100d6ff927b053`

Expected success marker: `ISOLATED_RELEASE_PROOF_COMPLETED`. Any nonzero result must be reviewed through the sanitized primary or emergency failure report before another attempt; fixed report paths are no-clobber. The prior failed attempt left the exact root-owned temporary directory documented in `failed-run-residual-cleanup-contract.md`; this corrected command does not implicitly delete that unrelated run.
