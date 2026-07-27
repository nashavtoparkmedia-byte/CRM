# Owner approval gate

Stage 8B2 remains prohibited until the architect and owner explicitly approve:

- exact Stage 8B1R commit and remote SHA;
- successful GitHub Actions run and downloadable checksum-verified evidence;
- both GHCR image refs by digest and pull-by-digest equality;
- final SBOM and vulnerability reports, including explicit acceptance of any `SECURITY_ACCEPTANCE_REQUIRED` item;
- read-only production metadata probe output;
- isolated root image-execution probe output;
- exact production runtime UID/GID/profile ownership and one-browser-owner evidence;
- verified database backup, migration ledger/table facts, timeout/window plan and rollback;
- exact one-account canary, observation window and health gates.

Approval of this package is not approval to deploy. No Stage 8B2 command is included.
