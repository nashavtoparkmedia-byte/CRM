# Bootstrap rollback

Any failure before `dpkg` leaves the installed runtime and production
unchanged. A root-only guard prevents activation-profile execution during the
package transaction. Any ordinary failure after successor installation is
attempted triggers
reinstallation of the embedded exact `2.0.0-5` package.

Rollback is accepted only after the predecessor package version, runtime,
policy, install manifest, sudoers, self-check and `PROFILE_DISABLED` behavior
all match the pinned predecessor, and the new executable profile files are
absent. Each assertion returns failure explicitly; the failure handler cannot
turn a failed rollback assertion into success through shell `errexit`
semantics.

Bootstrap never invokes activation profiles. Therefore rollback performs no
database, Docker, service, configuration, source, or production action.

SIGKILL or power loss cannot execute a shell trap. The same checksum-pinned
Owner command is therefore deliberately rerunnable: it reconciles a partial
root package store, restores an unproven partial successor, or accepts an
exact successor only after full identity, empty-audit and stored-rollback
proof. The exact guard remains fail-closed until that reconciliation succeeds.
