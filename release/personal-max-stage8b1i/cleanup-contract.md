# Cleanup contract

Every disposable Docker object carries both `personal-max.stage=8b1i` and a unique `personal-max.run-id`. Names use the `personal-max-stage8b1i-<run-id>` prefix and are collision-checked before mutation.

The EXIT trap removes only containers, the internal network, and the PostgreSQL and spool volumes matching both exact labels for the current run. It removes only the validated `/var/tmp/personal-max-stage8b1i.<run-id>.*` temporary directory. It never runs a global prune, generic image cleanup, Compose, or a production-label cleanup.

Success requires zero labelled containers, networks, volumes, and temporary files after cleanup. Accepted gateway and scraper images remain by design after a successful proof. A failure report records whether cleanup succeeded without including commands, SQL, credentials, logs, message content, or provider payloads.
