# YOKO CRM one-time Owner bootstrap

This sealed payload installs `yoko-privileged-runtime` `2.0.0-9` and the one
finite `crm-af9646f5-gravity-outbox-v1` profile. It contains the exact
`2.0.0-8` predecessor package for bootstrap rollback.

The successor preserves Runtime ABI `2.0.0` and preserves the existing
sudoers bytes. It enables only five existing zero-argument commands:
`database-status`, `release-preflight`, `database-migrate`,
`release-activate`, and `rollback`. `config-activate` remains disabled.

It grants no shell, generic command, arbitrary path, SQL, Docker, service,
image, environment, package-install, or rollback-target selection. It does
not delegate the Docker socket and does not add a new sudo wildcard.

Bootstrap installs and validates the root-owned control plane only. It does
not execute an activation profile, build an image, access or mutate the CRM
database, change `/opt/crm`, restart a service, or deploy production.

The already-applied outbox migration remains bound by exact database identity,
ledger digest, catalog shape, backup hash/size and isolated restore/preview
proof. The successor never converts this recovery path into a second database
mutation. It rejects unrelated state, database, backup, source, image or
production identity.

The target release health gate remains strict: HTTP 200, valid JSON
`status: "ok"`, infrastructure HTTP 200, and outbox startup evidence without
an outbox startup-failure marker. Runtime `2.0.0-9` repeats that full strict
gate for at most 90 seconds and accepts only two consecutive successes. This
bounded window accounts for persisted messaging-session restoration; it does
not admit `degraded`, partial, malformed or unavailable target health. If the
window expires, activation fails closed and automatic rollback runs.

The sealed predecessor rollback check is separate: it permits only HTTP 200
with valid JSON `ok` or `degraded`, while still requiring the exact predecessor
image, process semantics and already-migrated database. `down`, malformed or
unavailable predecessor health fails closed.

The retry source is the exact Runtime `2.0.0-8` terminal `ROLLED_BACK` state
after corrected target image `baf442f8…` failed the immediate gate and exact
predecessor container `53557ce8…` was restored. The applied production state is
exactly 62 active migrations, database
identity `ed88dfe…1c9`, ledger digest `a50f1a89…5dfc`, backup
`31bc2261…5d41` / 194477048 bytes, and exact outbox catalog. The successor
source is commit `7aea2823…`, tree `dbb380be…`, archive `be616b7d…`.

The encompassing tar is checksum-pinned by the one Owner command. The command
copies it to a root-only path and hashes that root-owned copy before
extraction, closing mutable-source replacement after verification.

The installer is interruption-reconcilable. It stores both exact package
versions under a root-only digest path, blocks every activation profile while
the package transaction is in progress, accepts only a fully proven exact
successor as already installed, and otherwise restores the embedded exact
predecessor before retrying. A partial root package copy is replaced only
after proving its fixed root ownership, mode, link count and name.

Only `YOKO_ACTIVATION_BOOTSTRAP_OK` is success.
