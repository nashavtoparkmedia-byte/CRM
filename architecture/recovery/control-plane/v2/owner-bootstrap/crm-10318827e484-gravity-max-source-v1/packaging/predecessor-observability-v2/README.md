# Predecessor observation v2 interim package

This directory builds the smallest privileged control-plane change needed to
capture the exact current layered Gravity, tg-bot and MAX predecessor
recreation state. It follows the August interim precedent
(`crm-external-rereview-source-only-v10/packaging/predecessor-observability-v1/`).

The installed Runtime 2.0.0-21 (DEB `17b97c40…`) observer resolves only the
base compose and `.env.production`, so it rejects every predecessor activated
through a sealed Runtime overlay. No fresh production snapshot, and therefore
no successor seal, can be produced while it is installed.

The package keeps version `2.0.0-21` and preserves the installed
`crm-ba90ed4b6717-gravity-max-source-v1` activation profile byte-identically
(profile runtime, `manifest.v1.json`, `profile.v1.json`,
`sealed-inputs.v1.json`), together with the core, policy and sudoers file.
The install-scope delta is exactly three files:

- `/usr/local/libexec/yoko-privileged-runtime/predecessor-observability-v1.py`
  — observation v2 (`src/predecessor-observability-v1.py`); the slot name is
  fixed by the pinned core's install-manifest file set;
- `/usr/local/sbin/yoko-privileged-runtime` — the installed wrapper with only
  the `PREDECESSOR_OBSERVABILITY_SHA256` line changed (the builder proves the
  one-line delta);
- `/usr/local/share/yoko-privileged-runtime/install-manifest.v1.json` — the
  installed record with only those two digests moved.

There is no new command, argument, sudo grant, path or Docker capability.

`build-package.sh` runs as the unprivileged builder from a clean exact commit
of `codex/predecessor-observability-v2-10318827`. It verifies every installed
identity, builds the package twice and compares the bytes, audits every data
member, runs the staged self-check/capabilities/argument-rejection contract in
test-root mode, and emits a checksum-bound installer and `package-manifest.json`
under ignored `dist/`.

The root installer takes no arguments and holds the coordinated bootstrap
lock. It is idempotent and accepts only the exact original 2.0.0-21 as its
prestate. It stores the interim DEB at its content-addressed path under
`/var/lib/yoko-privileged-runtime/activation-bootstraps/`, where a successor
Runtime requires its direct rollback package. It requires Gravity, tg-bot,
MAX, PostgreSQL and the audit ledger to be identical before and after. On any
failure it reinstalls the exact original 2.0.0-21 package. It never touches a
container, a Compose file or the database.
