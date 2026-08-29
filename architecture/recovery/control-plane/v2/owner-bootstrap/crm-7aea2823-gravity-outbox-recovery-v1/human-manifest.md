# Owner Bootstrap Manifest

Status: **accepted; waiting for the one-time Owner bootstrap**.

Final bootstrap artifact: `/opt/codex-work/crm-architecture-dod-recovery/architecture/recovery/control-plane/v2/owner-bootstrap/crm-7aea2823-gravity-outbox-recovery-v1/dist/yoko-crm-activation-recovery-7aea2823-v3.tar`

Final SHA-256: `b9a5d5f250e9d2a96ef4199200f1f6db52bdbe5fb9c23d74c45d2cce4bc63df7`

Runtime package: `2.0.0-7` → `2.0.0-8`; ABI remains `2.0.0`.

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
`2.0.0-7` predecessor after any ordinary failure following successor install.
An interrupted run is reconciled by rerunning the same checksum-pinned command.

Independent final critic: **PASS**. Owner command authorized:
**YES**.
