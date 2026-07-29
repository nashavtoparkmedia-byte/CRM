# Failed-run residual cleanup contract

The failed `57d7cba75198c002de902d1ef569681eb14d89e594ca9488214cd99fb3ec4d38` probe stopped in `storage_gate`, before production snapshot, image acquisition, disposable network/volume creation, or container creation. It left one observed root-owned path:

`/var/tmp/personal-max-stage8b1i.fee32e594eba.NKiRfY`

Observed metadata is `root:root`, mode `0700`, directory. Codex did not read, change, or remove its contents. This path belongs to the old `57d7cba75198c002de902d1ef569681eb14d89e594ca9488214cd99fb3ec4d38` storage-gate run. It is not the temporary directory of the later `6ebdbd0221c4fb395f5a255ded0f18a3e63b6f677baa644e5b0dd0296992f1f3` run. The accepted later failure report, SHA-256 `0203c1287fc2415367e10852fb83bb8001f558f2484c8e6cafe14d86c7d3dd67`, correctly records zero temporary files remaining for its own run; that value does not describe or contradict this older residual.

The origin failure report for the old script is absent. The later accepted report bound to `6ebdbd0221c4fb395f5a255ded0f18a3e63b6f677baa644e5b0dd0296992f1f3` is unrelated provenance and must not authorize removal of this historical path. The previous cross-run binding is withdrawn.

The next isolated probe does not source or invoke `residual-cleanup.sh`, does not inspect this directory, and does not remove it. The historical residual does not block creation of a new unique run because its name does not collide with a fresh run ID. `residual-cleanup.sh` remains only as a dormant, non-runtime evidence artifact describing the previously considered checks; it is not a consumed hard-bound artifact and grants no authority.

Cleanup, if later desired, requires a separate controlled privileged runner job and a new approval contract tied to the old run by valid provenance. No wildcard deletion, global `/var/tmp` cleanup, Docker prune, production-label operation, or unrelated cleanup is permitted. No cleanup has been executed during this repair.
