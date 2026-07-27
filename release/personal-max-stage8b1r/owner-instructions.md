# Root preflight owner instruction

The first approved root action is read-only:

`sudo /opt/codex-work/crm-personal-max-stage8b1r-release-hardening-20260727T205938Z/release/personal-max-stage8b1r/root-preflight/probe-readonly-production.sh`

Expected output is one redacted JSON object with production service/image digest/user/mount-source/network/restart/health metadata, safe PostgreSQL version/migration/table/index/timeout facts, an explicit pending duplicate-scan marker and disk availability. It does not create, load, restart, migrate or change anything.

The isolated executable probe is a separate later approval. Its exact single command, including both verified registry digests, is generated as `owner-isolated-probe-command.txt` in the successful Actions evidence artifact. Expected output is one JSON object proving internal-only execution, migration, actual hook, outage/restart recovery, zero provider/browser effects, production container-ID equality and cleanup. Do not combine the two scripts and do not run either automatically.

Before that separate approval, the root Docker client must already have read access to the two exact GHCR packages through an owner-approved authentication mechanism. The probe neither accepts nor prints registry credentials and fails closed if either digest pull is unauthorized. This authentication prerequisite is not deploy authorization; the probe exposes no public port and contains no production deploy command.
