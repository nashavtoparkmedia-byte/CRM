# YOKO CRM one-time Owner bootstrap

This sealed payload installs `yoko-privileged-runtime` `2.0.0-7` and the one
finite `crm-af9646f5-gravity-outbox-v1` profile. It contains the exact
`2.0.0-6` predecessor package for bootstrap rollback.

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

The later fixed migration profile recognizes only one unfinished row whose
name and checksum equal the accepted outbox migration. It refuses cleanup if
the new table contains data; otherwise it removes only the fixed additive
table/type without CASCADE, marks only that migration rolled back through a
fixed named runner, proves the prior ledger/catalog state, and retries. The
release health gate requires HTTP 200 plus valid JSON body `status: "ok"`;
`degraded`, `error`, malformed or unavailable health triggers failure and the
pinned automatic application rollback.

The production pre-outbox ledger is bound as an exact normalized observation:
61 active rows, database identity `ed88dfe…1c9`, and SHA-256
`f8e57fd9…7201`. Normalization removes only the fixed outbox target row and
its finite recovery counters. Any unrelated migration name, checksum, row or
database identity changes the digest and fails closed.

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
