# Selection

The resumed Architecture Lead gate selected the enforcement defect before any new owner-command slice. Twelve direct-write findings represented constant, owner-local DDL whose table identity the scanner failed to resolve. The source behavior and data ownership were already unambiguous; only the fail-closed evidence parser and strict registry are changed.

Affected owner-local tables:

- Configuration: `config_change_log`.
- Operations Observability: `cron_health_log`, `execution_lock`, `integrity_check_log`, `perf_log`, and `stability_check_log`.

Runtime-selected SQL, interpolation in table position, concatenation, aliases, mutable or shadowed bindings, unresolved identifiers, and mixed-owner statements remain violations.

The stronger fail-closed parser also surfaced 48 previously hidden sites: three unsafe fragment builders and 45 tagged execute templates whose interpolated runtime values cannot be proven incapable of carrying a Prisma SQL object. They remain explicit architecture debt. The corrected pre-retirement population is therefore 115 sites: 67 previously registered plus 48 newly surfaced; retiring the 12 constant owner-local DDL ambiguities leaves 103 genuine foreign or fail-closed dynamic sites.

Each raw write fingerprint is bound to the SHA-256 of its named AST scope plus exact call/tag site. A remaining byte-identical same-scope duplicate set is additionally salted by the complete source-file digest. Retiring one same-subject sibling therefore cannot transfer its exception identity to a later sibling through ordinal renumbering.
