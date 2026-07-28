# Managed standalone lifecycle

The future rollout copies the checksum-bound service definition into `/var/lib/personal-max-stage8b2b` as `root:root:0600` and manages it as the separate Compose project `personal-max-stage8b2b`. It never parses the production Compose file or `.env.production`. The deterministic container and internal network have Stage 8B2B labels, no volumes, no public ports, and `unless-stopped` restart policy. The checksum-bound rollback targets only that project after verifying its labels; it uses no prune and preserves the root-owned definition and sanitized evidence.
