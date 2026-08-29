# Owner Bootstrap Manifest

Status: **accepted; waiting for the one-time Owner bootstrap**.

Final bootstrap artifact: `/opt/codex-work/crm-architecture-dod-recovery/architecture/recovery/control-plane/v2/owner-bootstrap/crm-7aea2823-gravity-outbox-stabilization-v2/dist/yoko-crm-activation-stabilization-7aea2823-v4.tar`

Final SHA-256: `c7823d66ebabc57df7da4bb54c40ee8d78a05964cb7ac7f63bcf04941f7fc048`

Runtime package: `2.0.0-8` → `2.0.0-9`; ABI remains `2.0.0`.

The package enables exactly five zero-argument profiles: `database-status`,
`release-preflight`, `database-migrate`, `release-activate`, and `rollback`.
It preserves the predecessor sudoers file byte-for-byte and keeps
`config-activate` disabled. It grants no generic shell, command, path, SQL,
Docker, service, image, environment, package-install, or rollback-target
selection.

Bootstrap installs and validates the finite root-owned control plane only. It
does not deploy Gravity, access or migrate PostgreSQL, restart a service,
activate outbox, change `/opt/crm`, or invoke any activation profile.

Automatic bootstrap rollback reinstalls and proves the embedded exact
`2.0.0-8` predecessor after any ordinary failure following successor install.
An interrupted run is reconciled by rerunning the same checksum-pinned command.

After installation, release retry is admitted only from the exact Runtime
`2.0.0-8` terminal `ROLLED_BACK` state and the same corrected target identity.
The application, infrastructure and outbox predicates remain strict and must
all pass twice consecutively within 90 seconds. Timeout still fails closed and
invokes automatic production rollback; no database mutation is repeated.

Independent final critic: **PASS**. Owner command authorized:
**YES**.
