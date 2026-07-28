# Recreation evidence contract

A deterministic future rollback specification requires the current image ID and sanitized repository metadata, entrypoint, command, workdir, configured/runtime user, healthcheck hash, restart policy, exact Compose labels, networks and aliases, mounts, ports, security options, capabilities, namespace modes, environment-name set, and environment-source provenance. Values from env files or container environment are never emitted.

The report may state `RECREATION_EVIDENCE_COMPLETE` only when every mandatory field is present and the current container identity is stable before and after collection. Otherwise it states `RECREATION_EVIDENCE_INCOMPLETE` and no rollout script may be derived from it. This package intentionally contains no scraper rollout or rollback executable.
