# Owner Bootstrap Manifest

Status: **accepted; waiting for the one-time Owner bootstrap**.

Final bootstrap artifact: `/opt/codex-work/crm-architecture-dod-recovery/architecture/recovery/control-plane/v2/owner-bootstrap/crm-af9646f5-gravity-outbox-v1/dist/yoko-crm-activation-bootstrap-af9646f5-v1.tar`  
Final SHA-256: `88a30f4fdf74c1f86d47f47c31edec824a887c172a69585c45eddceb85fb755e`  
Runtime package: `2.0.0-5` → `2.0.0-6`; ABI remains `2.0.0`.

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
`2.0.0-5` predecessor after any ordinary failure following successor install.
An interrupted run is reconciled by rerunning the same checksum-pinned command.

Independent final critic: **PASS**. Owner command authorized:
**YES**.
