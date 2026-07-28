# Failed-run residual cleanup contract

The failed `57d7cba75198c002de902d1ef569681eb14d89e594ca9488214cd99fb3ec4d38` probe stopped in `storage_gate`, before production snapshot, image acquisition, disposable network/volume creation, or container creation. It left one observed root-owned path:

`/var/tmp/personal-max-stage8b1i.fee32e594eba.NKiRfY`

Observed metadata is `root:root`, mode `0700`, directory. Codex did not read, change, or remove it. Docker residual counts are `unknown` because `codexbot` cannot read `/var/run/docker.sock`; they must never be represented as zero.

Any future cleanup is a separate root-authorized action. It must first re-stat the exact path without following symlinks, refuse any identity/type/path mismatch, verify that the run ID is exactly `fee32e594eba`, inventory Docker objects by both exact labels `personal-max.stage=8b1i` and `personal-max.run-id=fee32e594eba`, and remove only matching disposable objects and this exact path. Every operation must be bounded. Global prune, image removal, production labels, production networks/volumes, backups, and profiles are forbidden.

This contract is prepared evidence only. It contains no executable cleanup command, grants no cleanup authorization, and does not broaden the corrected isolated probe command.
