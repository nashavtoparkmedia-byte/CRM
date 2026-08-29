# OWNER PRIVILEGE ACTION REQUIRED

The installed `yoko-crm-arch-evidence 1.0.2-1` broker has an acceptance-critical
Docker/runtime defect. All unaffected checks are complete. The reviewed,
reproducible successor is staged and sealed but cannot be installed through the
current caller-bound four-command privilege surface.

- Artifact: `/opt/codex-work/crm-arch-000-capability-v3/dist/yoko-crm-arch-evidence_1.2.0-1_all.deb`
- SHA-256: `af6512b446a662734f292fda3f3f861500dd9610657bfd7f9cbfcca4551a9e47`
- Broker SHA-256: `00bbd2a7fdc93a653db2f2891426d43185a33dd236b631feca83b2e2ef226306`
- Root-owned target: `/var/lib/yoko-crm-arch-evidence-af6512b446a662734f292fda3f3f861500dd9610657bfd7f9cbfcca4551a9e47.deb`

Run this one installation command as `codexbot`:

```bash
sudo /usr/bin/install -o root -g root -m 0444 /opt/codex-work/crm-arch-000-capability-v3/dist/yoko-crm-arch-evidence_1.2.0-1_all.deb /var/lib/yoko-crm-arch-evidence-af6512b446a662734f292fda3f3f861500dd9610657bfd7f9cbfcca4551a9e47.deb && sudo /usr/bin/dpkg --install /var/lib/yoko-crm-arch-evidence-af6512b446a662734f292fda3f3f861500dd9610657bfd7f9cbfcca4551a9e47.deb
```

The command performs only the root-owned copy and package installation, without a
root shell. No broker, Docker, Git, or filesystem inspection is delegated to the
Owner. After installation is reported, Codex will automatically verify the target
SHA/metadata, installed version, broker/companion/sudoers identities, and exact
`self-check`, then run the remaining fixed evidence commands itself.
