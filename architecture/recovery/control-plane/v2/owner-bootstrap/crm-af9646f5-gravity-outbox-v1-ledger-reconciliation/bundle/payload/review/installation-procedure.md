# Installation and validation procedure

The single checksum-pinned Owner command creates a new root-only tar copy and
stage, verifies the root copy, extracts only that copy, fixes exact root
ownership and modes, and executes `payload/install.sh` with zero arguments
from its fixed directory.

The installer checks the exact host and payload, the current `2.0.0-6`
package and installed-file hashes, Runtime V2 self-check, audit digest and a
read-only Docker identity snapshot. It copies both Debian packages to a
root-only digest directory and installs only the local `2.0.0-7` package.

Before `dpkg`, it creates a fixed root-owned, empty, mode-0400 bootstrap guard.
The successor Runtime refuses all five activation profiles while that guard is
present, but still permits self-check, capabilities and read-only provenance
validation. Successful installation clears only an exact root-owned guard.

Post-install validation proves package identity, installed hashes, profile
identity, finite capabilities, unchanged sudoers semantics, effective sudo
negative probes, unchanged Docker/container identity and unchanged audit.
No profile is executed during bootstrap.

After the Owner returns the success marker, database/release use remains a
separate Codex-controlled phase. Its database state machine persists intent
before production DDL, reconciles a single exact unfinished target with a
fixed empty-object cleanup and fixed Prisma resolve runner, and fails closed
for all other ledger/catalog states. Activation accepts only application
health HTTP 200 with JSON status `ok`.

The installer emits one machine-readable result followed by either
`YOKO_ACTIVATION_BOOTSTRAP_OK` or `YOKO_ACTIVATION_BOOTSTRAP_FAILED`.
