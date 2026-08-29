# CRM-ARCH-000R mutation ledger

Authorized evidence and capability-preparation writes only:

- Existing production-only snapshot created at
  `/opt/codex-work/crm-arch-000-evidence/20260808T070726Z` (27 copied files,
  one metadata-only exclusion, manifest and package ledgers).
- Initial broker outputs created at
  `/opt/codex-work/crm-arch-000r-closure/20260808T120034Z`.
- This continuation evidence tree created at
  `/opt/codex-work/crm-arch-000-evidence/crm-arch-000r/20260808T122923Z`.
- The unsafe-for-acceptance v1 runtime artifact was restricted from mode `0664`
  to `0600`; a sanitized derivative was created. No source artifact was deleted.
- Owner previously installed package `yoko-crm-arch-evidence 1.0.2-1`, creating
  the root-owned broker, companion, sudoers fragment and pinned package copy.
- Hardened successor packages were staged locally outside production. The final
  candidate is `1.2.0-1`, package SHA-256
  `af6512b446a662734f292fda3f3f861500dd9610657bfd7f9cbfcca4551a9e47`;
  no successor package has been installed yet. Two earlier uninstalled
  `1.2.0-1` candidate archives were retained under `build/obsolete/` after
  review found that their privileged Git surface was too broad.
- The final successor deliberately removes privileged Git execution and the
  Messages traversal after the v1 broker outputs for both states were captured.
  It adds only a fixed, FD-bound `production-index-metadata` observation plus
  the corrected Docker/runtime commands needed for the remaining closure.
- Unit tests and Python compilation created or refreshed `__pycache__` files only
  inside capability staging/test directories.
- A prior rootless disposable `dpkg` test failed inside a local analysis fixture;
  it did not install a host package. Final payload overlay validation uses
  `build/upgrade-extract-final`.
- Canonical staged artifacts were mode-sealed where reported. They are Codex-owned,
  not root-immutable; `/opt/codex-work` remains owner-writable.
- At finalization every write bit was removed from this continuation evidence
  tree. Directory modes became `0555`; ordinary files became `0444`; files that
  were already private retained private read scope as mode `0400`.

Broker invocations create mandatory root-only append audit entries. During the
current run, two `self-check` calls, one failed-closed `docker-provenance`, one
`production-git-state`, and one `messages-worktree-state` call were made. Each valid
invocation writes start/end entries. Earlier closure calls also wrote their required
entries. Exact log-line identities are unavailable because the narrow broker does
not expose the root-only audit log.

Codex-internal turn-diff object/ref materialization remains covered by the
Architecture Lead waiver and was not used as product authority.

Confirmed absent:

- no `/opt/crm` or linked-worktree source edit;
- no Git index refresh or mutation;
- no ordinary product ref creation, update, deletion, fetch or push;
- no container/image creation, stop, restart, exec, copy or filesystem mutation;
- no service, systemd, firewall, FreeSWITCH or Nginx change;
- no database, schema, volume or migration change;
- no CRM architecture implementation, build or deployment.
