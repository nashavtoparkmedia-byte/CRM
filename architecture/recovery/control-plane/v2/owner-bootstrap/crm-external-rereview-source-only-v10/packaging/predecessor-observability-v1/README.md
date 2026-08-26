# Predecessor observability interim package

This directory builds the smallest privileged control-plane change needed to
capture the exact current Gravity and Telegram predecessor recreation state.
It does not install anything and does not invoke the new observation command.

The package preserves the installed `crm-08b9145945b2-gravity-source-v1`
activation profile implementation and all five immutable profile artifacts.
The profile manifest changes only because it must bind the new Runtime core;
activation and rollback semantics are otherwise byte-identical.

The install-scope delta is finite:

- replace `/usr/local/sbin/yoko-privileged-runtime` with a wrapper that
  integrity-pins the observer;
- replace `/usr/local/libexec/yoko-privileged-runtime/core-2.0.0.py` with the
  parser/installed-identity extension;
- add `/usr/local/libexec/yoko-privileged-runtime/predecessor-observability-v1.py`;
- replace `/usr/local/share/yoko-privileged-runtime/install-manifest.v1.json`;
- replace the installed profile `manifest.v1.json` only to bind the new core;
- replace `/etc/sudoers.d/92-yoko-privileged-runtime` with the old finite
  allowlist plus exactly `yoko-privileged-runtime predecessor-observe`.

The policy remains byte-identical. The privilege delta has no arguments, no
shell, no arbitrary path, no generic Docker command and no socket delegation.
The observer uses only fixed `docker compose config` and fixed inspect calls.
It emits no environment values or per-value digests and never enumerates the
contents of `crm_tg_bot_data`.

`build-package.sh` requires the exact installed first repair package, a clean
Git commit, and the exact root-private original rollback package identity. The
narrow amendment changes only the fixed production-file ancestry check: both
leaves remain root-owned and exact-mode while the established Runtime boundary
proves the `crm`-owned project chain is not writable by `codexbot`. The
builder emits the same package twice and compares the bytes, audits every
package member, runs the staged Runtime self-check/capabilities contract, and
emits a checksum-bound installer plus a machine-readable manifest under ignored
`dist/`.

Installation is idempotent: the generated installer exits successfully if all
new file identities are already installed. It accepts only the exact original
Runtime or the exact first repair as its prestate. On any installation or
verification failure it reinstalls the exact original root-private package.
Deliberate rollback uses that same exact package; removing the package is not
used because it would remove the shared Runtime instead of restoring it.
