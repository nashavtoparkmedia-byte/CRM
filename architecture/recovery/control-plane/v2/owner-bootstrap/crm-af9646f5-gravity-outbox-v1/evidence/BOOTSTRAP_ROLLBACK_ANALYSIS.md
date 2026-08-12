# Bootstrap rollback analysis

The bootstrap transaction has two phases.

Before `dpkg`, it verifies the exact host, payload file set and hashes,
predecessor package and installed hashes, Runtime V2 self-check, empty audit
digest, and a read-only Docker provenance snapshot. A failure in this phase
does not alter the installed package or production.

Immediately before `dpkg`, it persists root-only `0400` copies of both the new
and predecessor Debian packages under a digest-named `0700` runtime directory.
It also creates an exact root-owned, empty, mode-0400 guard which makes the
successor refuse every activation profile for the duration of the package
transaction.
If the successor install or any post-install validation fails, the exit trap
installs that persisted predecessor package and proves the exact predecessor
runtime, policy, install manifest and sudoers hashes. It also proves
`release-preflight` is disabled again and the new executable profile files are
absent.

The installer never invokes the activation profiles. Its only Docker reads
are the existing bounded `docker-provenance` primitive before and after the
package transaction; their semantic fingerprint, container IDs, image IDs,
started timestamps and restart counters must be identical. The Runtime audit
digest must also remain the all-zero empty digest. Consequently bootstrap
rollback has no database, service, container, image, production source, or
configuration rollback step.

If predecessor reinstallation itself cannot be proven, the installer returns
`YOKO_ACTIVATION_BOOTSTRAP_FAILED` with `rollback_restored:false`. It never
claims success from a partially validated successor or predecessor.

An untrappable interruption is recovered by rerunning the same pinned command.
The installer safely completes missing or partial root-store copies, restores
an unproven successor, and only reports `ALREADY_INSTALLED` when the successor,
empty audit, predecessor rollback package and root store are all exact. A
remaining exact guard continues to deny activation until reconciliation.
