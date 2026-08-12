# Installation and validation procedure

The single checksum-pinned Owner command creates a new root-only tar copy and
stage, verifies the root copy, extracts only that copy, fixes exact root
ownership and modes, and executes `payload/install.sh` with zero arguments
from its fixed directory.

The installer checks the exact host and payload, the current `2.0.0-8`
package and installed-file hashes, Runtime V2 self-check, audit digest and a
read-only Docker identity snapshot. It copies both Debian packages to a
root-only digest directory and installs only the local `2.0.0-9` package.

Before `dpkg`, it creates a fixed root-owned, empty, mode-0400 bootstrap guard.
The successor Runtime refuses all five activation profiles while that guard is
present, but still permits self-check, capabilities and read-only provenance
validation. Successful installation clears only an exact root-owned guard.

Post-install validation proves package identity, installed hashes, profile
identity, finite capabilities, unchanged sudoers semantics, effective sudo
negative probes, unchanged Docker/container identity and unchanged audit.
No profile is executed during bootstrap.

After the Owner returns the success marker, database/release use remains a
separate Codex-controlled phase. It accepts only the exact terminal Runtime
`2.0.0-8` `ROLLED_BACK` state, rehashes the existing backup, rechecks the exact
applied database/catalog, rebuilds only the sealed `7aea2823…` candidate and
activates it. No second production migration is authorized. Target activation
accepts only HTTP 200 with JSON status `ok`, infrastructure HTTP 200 and outbox
startup evidence, twice consecutively within a bounded 90-second stabilization
window. Expiry automatically restores the exact predecessor again.

The installer emits one machine-readable result followed by either
`YOKO_ACTIVATION_BOOTSTRAP_OK` or `YOKO_ACTIVATION_BOOTSTRAP_FAILED`.
