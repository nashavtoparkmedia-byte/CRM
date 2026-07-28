# Cleanup contract

Every disposable Docker object carries both `personal-max.stage=8b1i` and a unique `personal-max.run-id`. Names use the `personal-max-stage8b1i-<run-id>` prefix and are collision-checked before mutation.

The EXIT trap removes only containers, the internal network, and the PostgreSQL and spool volumes matching both exact labels for the current run. It removes only validated Stage 8B1I temporary paths. Every inventory/removal operation has a deadline of at most 60 seconds and the cleanup sequence has one 300-second global deadline. It never runs a global prune, generic image cleanup, Compose, or a production-label cleanup.

Success requires zero labelled containers, networks, volumes, and temporary files after cleanup. Accepted gateway and scraper images remain by design after success or failure. A failure report records bounded remaining counts, a cleanup classification, pre-existing/acquired image facts, disk gates, and the original failure without including commands, SQL, raw stderr, credentials, logs, message content, or provider payloads.
