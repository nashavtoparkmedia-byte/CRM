# CRM-ARCH-000R EXECUTIVE VERDICT

`BLOCKED_PRIVILEGE`

The installed `yoko-crm-arch-evidence 1.0.2-1` capability is authentic and its
self-check passes, but its `docker-provenance` command fails closed and its v1
runtime manifest cannot prove image-versus-writable origin; the FreeSWITCH part
also had to be quarantined for secret safety. Production Git state and the
protected Messages worktree were otherwise closed. A narrowed, independently
reviewed, reproducible `1.2.0-1` successor is sealed at SHA-256
`af6512b446a662734f292fda3f3f861500dd9610657bfd7f9cbfcca4551a9e47`,
but installing it is outside the caller-bound sudo surface.

## 1. Observation Window and Continuity

- Host: `jvxthcorvm`.
- Executor: `uid=998(codexbot) gid=998(codexbot) groups=998(codexbot)`.
- Start: `2026-08-08T12:29:23.745165602Z`.
- End continuity observation: `2026-08-08T12:59:12.762814381Z`.
- Repository identities were unchanged: production `e6a0a833fbb756216b058bfe326f9f9c77c4cc6d`, audit workspace `ee93f8e2e964e523c5f3922a906ce110e491b4e4`, AI Calls `b38b22d3e00b3fb43d05417131709b3d2c535b2b`, Messages `50ae48a5761ced6acb1639497fa80094b108f305`, MAX release `74657f827153babbe601a2765bf6c526efbb73d2`, and call release `2fdd44a3e7aa6af32d6c7dbf7e033477bc6201bf`.
- All 81 known modified production working-file hashes remained identical and the four known deletions remained absent.
- Installed capability identity and start/end self-check output were unchanged; both self-check outputs hash to `4014fb0668b841cf5ae731324f3a1b3574a3c6f61d005a8229ff4a2596f4bd93`.
- Verdict: known repository and working-file identities were unchanged. Exact ten-service runtime identity and FD-bound index identity remain unavailable until successor installation, so full start/end continuity is not claimed.
- Evidence: `continuity/start-continuity.json`, `continuity/end-continuity.json`.

## 2. Capability Installation and Verification

- Installed package: `yoko-crm-arch-evidence 1.0.2-1`, architecture `all`, dpkg state `ii`.
- Original staged package: `/opt/codex-work/crm-arch-000-capability/dist/yoko-crm-arch-evidence_1.0.2-1_all.deb`, SHA-256 `a9b1d524d94cb658c415f85c423dbaf1df4f45de0fdc2a38db1b6132484a188f`.
- Root-owned package copy: `/var/lib/yoko-crm-arch-evidence-a9b1d524d94cb658c415f85c423dbaf1df4f45de0fdc2a38db1b6132484a188f.deb`, same SHA, `root:root`, mode `0444`, one hardlink.
- Broker: `/usr/local/sbin/yoko-crm-arch-evidence`, SHA-256 `0a8f18bad0467056c3b7460827618b5d8df8ac8678da57040988478dba34ab18`, `root:root`, mode `0755`, one hardlink.
- Companion: `/usr/local/share/yoko-crm-arch-evidence/yoko-crm-arch-evidence.sha256`, file SHA-256 `a1504789325d15bab41864701ab895a5dafd761296dcd8ff71fc90d2cac2866c`, `root:root`, mode `0444`, one hardlink; it pins the broker SHA.
- Sudoers identity: packaged SHA-256 `6f3c84ec06d524105a9ff0860bc75bcfbcaca90b88de84c9c823afef3ec91ab2`; live bytes are unreadable to the executor, while both self-check and `sudo -l` validated the exact policy and `NOSETENV`.
- Installed allowed subcommands: `self-check`, `docker-provenance`, `runtime-content-manifest`, `production-git-state`, `messages-worktree-state`.
- Self-check: PASS at start and end, schema `CRM-ARCH-000R-1`; package and companion integrity: PASS.
- Audit behavior: every valid broker invocation appends root-only start/end records. This continuation made two initial self-checks, one failed-closed Docker call, one production Git call, one Messages call, and one end self-check. The fixed broker does not expose root-only audit-line identities.
- Successor: `/opt/codex-work/crm-arch-000-capability-v3/dist/yoko-crm-arch-evidence_1.2.0-1_all.deb`, package/rebuild SHA-256 `af6512b446a662734f292fda3f3f861500dd9610657bfd7f9cbfcca4551a9e47`, embedded broker SHA-256 `00bbd2a7fdc93a653db2f2891426d43185a33dd236b631feca83b2e2ef226306`.
- Successor verification: 24/24 tests, two independent security reviews, exact three-file root-owned archive payload, no maintainer scripts, companion/source equality, `visudo` PASS, reproducible rebuild PASS. Its four commands are `self-check`, `docker-provenance`, `runtime-content-manifest`, and `production-index-metadata`; privileged Git and Messages traversal were removed after the v1 captures.
- Canonical successor root/source/tests/dist directories are mode `0555`; canonical source/test/sudoers/deb files are mode `0444`. They are sealed by mode but remain Codex-owned, not root-immutable.

## 3. Production-Only Evidence Snapshot

- Evidence root: `/opt/codex-work/crm-arch-000-evidence`.
- Snapshot: `/opt/codex-work/crm-arch-000-evidence/20260808T070726Z`.
- Manifest: `manifest.json`, 28 paths, SHA-256 `b42c1e3bae282422694edcedbd5fe47dba529d0a5f86e8fc2df938510059cee4`.
- Contents: 27 exact preserved files plus metadata only for `deploy/docker-compose.production.yml`; three non-empty `ESL_PASSWORD` defaults caused content exclusion.
- Package ledger: `PACKAGE_CONTENTS.tsv`, SHA-256 `ba987cb23ebf6be8111b59f423ca6d2aadd6b508e82281365c60a870f1bc0a3c`; `PACKAGE_SHA256` SHA-256 `2973052a3179d3d44161e98848bc55ebce192795a67e63f13c4733b95aa2f4f9`.
- Current validation: zero source SHA drift, zero metadata drift, directories `0555`, files `0444`, zero writable members.
- Secret screening: PASS; no Compose secret value was copied.

## 4. Docker / OCI Provenance

The current command returned `FIXED_COMMAND_FAILED` (raw SHA-256
`e0180d12837a245362a85d72fc01ae673b289e8456541444de546aa00d069113`).
These are the last accepted/frozen image identities, not a current safe-OCI
recapture:

| Core service | Image identity | Current CRM-ARCH-000R OCI result |
|---|---|---|
| Gravity | `sha256:b36751e5a6d2b52e7a7676ee5babcd70f496111e9715e5056f6338d04b028f68` | successor recapture required |
| MAX scraper | `sha256:87835969ed6335a99d50e1cc2eaf70aa33fdbaf937f4cef658a926f55b26f365` | successor recapture required |
| Personal MAX | `sha256:1859c44327ba4e2264728534c334b81f8ee0cdbd56ebe28c50bb62dffadfc0c1` | frozen identity; current continuity pending |
| TG bot | `sha256:0849c4c9912aecf3cb7c35b51abba22cdb1c85a385afa6c2746000d14b9835f6` | successor recapture required |
| TG frontend | `sha256:87e2f3c70e11dd49e179889b8cacd6ebbc3ed188ed2787698b288a98b89b083d` | successor recapture required |
| YFS API | `sha256:7df77531470940da08a216e75ffbe1f17d44ce7f66747f1fc3dcf31094b1b5e4` | successor recapture required |
| YFS worker | `sha256:9a909f13f46f260cc490016be65b9d7923d3b29e5fe0493f6a1ba763474d8501` | successor recapture required |
| Audio Bridge | `sha256:ba83a60f43149d71f25fc1663dd32094ecff9b166bd59d2cacfa880869e86417` | successor recapture required |
| FreeSWITCH | `sha256:d5f8183e3754bda3f9d21dc69eb452ff98ec15bcf3b73264c25ef5fd0ee86947` | successor secret-safe recapture required |
| Nginx | `sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10` | frozen bind identity; current continuity pending |

## 5. Runtime Content Manifests

The secret-safe derivative is `runtime-manifests/runtime-content-manifest.v1.sanitized.json`, SHA-256 `1bd1d5100cabeb37277262179ee1119b3dcd9154b9774947dcf218d38e4d19fe`.
Because v1 recorded every origin as unknown, these manifests support content
comparison but not image/writable-layer proof.

| Service | Container ID | Files / bytes | Sanitized manifest SHA-256 | Result |
|---|---|---:|---|---|
| Gravity | `37ce24fdaf2421e3a8e655746c47e0f4faf920488097b65bd53317283ef692ee` | 3,948 / 126,817,476 | `169cf1de708113133ae827e37791a876dae87a8fcfbba8d127c43b16868d9410` | usable content; origin pending |
| MAX scraper | `d7283f76bed4eb3090c8a9a340de0f3bebf5c316ef6e67b30f67fef4fc9c312b` | 56 / 1,227,082 | `ce8776162979e648c43920fe1b1bf29beeca1f0b7e9e792430700046c36546b3` | usable content; origin pending |
| TG bot | `c3fae82f86726739c6e768cd524f5903a1d0a9a0e926f86d9cc559ac633c0f7a` | 43 / 239,811 | `72397e9c7e3c728b94d1e5645da825ddd75216bfacd13212b4671fe15f206d56` | usable content; origin pending |
| TG frontend | `951b7edb1355764ef19f2353ae8a4f9d5c162ea939e3534b240cea2d3f4c1490` | 79 / 2,123,176 | `9ede5e27b6d36c68d897f45d33423e4e22960f87ce1dee525ff790d9ad17b2f2` | usable content; origin pending |
| YFS API | `3a75ea182086b58d70049a7c9f298ff61e3b17d12838690fc94472ca4206e42e` | 25 / 438,793 | `fc3cdb14d8f0ad6766affd0b0d7391ecb6f755a44c138a73d7bc5bbc1d5048e1` | usable content; origin pending |
| YFS worker | `255bba82adbf2bbccf383e35dc1c4b5e4fd0a868b6888b1f0ed2e3a86eee1702` | 27 / 443,561 | `bbb9886d7ec3c379a84cbbecef7b42bbda268db5bda5332a69172346ee46e402` | usable content; origin pending |
| Audio Bridge | `2234ab2d1ea138b2e90cc530a5a9f7c8d6dd0d42c818c08a72c25ceaaa19136f` | 24 / 232,005 | `f4bb0545c50d4a0bd01aaaebf2b73ab7d8f4ee8a0d098d851102ce4fc6c4cfcb` | usable content; origin pending |
| FreeSWITCH | `431261ef7600f7ab0098a28ab4700bb6c69defa7b5572a799d982a121bec55b6` | 0 / 0 retained | quarantined | all 444 v1 records withheld; fixed-root recapture required |
| Personal MAX | frozen authority | N/A | N/A | state directories intentionally excluded; OCI continuity pending |
| Nginx | live bind authority | N/A | N/A | runtime content manifest not applicable; mount continuity pending |

## 6. Source Comparison Results

| Component | Exact/composite candidate | Unmatched or generated result | Classification |
|---|---|---|---|
| Gravity | 291 non-generated files map to production/release/snapshot composite | 3,657 generated `.next` records; 954 absent from candidate union | `UNRESOLVED` pending origin proof |
| MAX scraper | 56/56 application files equal the production composite | dependencies/caches excluded; none unmatched | `PROVEN_CONTENT_EQUIVALENT` |
| Personal MAX | revision `f97532cb6903f033c070856b4a8c207df8e35026` | current container continuity pending | `PROVEN_GIT_REVISION` frozen |
| TG bot | 43/43 application files equal the production composite | none unmatched | `PROVEN_CONTENT_EQUIVALENT` |
| TG frontend | 4 source/static files match production | 75 generated files absent from candidates | `UNRESOLVED` pending origin proof |
| YFS API | 24/25 files map to production/snapshot composite | `/app/src/worker.ts`, SHA-256 `c14327159069d8f49071d78209b380f1baf646577a00473bfc295f87bde6ce15` | `UNRESOLVED` pending origin proof |
| YFS worker | 27/27 application files map exactly | 15 runtime screenshots excluded | `PROVEN_CONTENT_EQUIVALENT` |
| Audio Bridge | 24/24 files equal production revision `e6a0a833fbb756216b058bfe326f9f9c77c4cc6d` | none unmatched | `PROVEN_CONTENT_EQUIVALENT` |
| FreeSWITCH | production/release telephony candidates known | v1 component quarantined; fixed non-secret roots not yet captured | `UNRESOLVED` |
| Nginx | `/opt/crm/deploy/nginx` live bind paths | no content gap; current mount continuity pending | `AUTHORITATIVE_PROVEN` frozen |

## 7. Production Git Index

- Repository/HEAD/branch/upstream: `/opt/crm`; `e6a0a833fbb756216b058bfe326f9f9c77c4cc6d`; `feature/ai-knowledge-core`; `origin/feature/ai-knowledge-core`.
- Index path: `/opt/crm/.git/index`; observed metadata is `root:root`, mode `0600`, one hardlink, device `64513`, inode `597105`, size `185309`, mtime/ctime epoch `1785623741`.
- Broker-parsed entries: 1,513. Staged count/additions/modifications/deletions: `0/0/0/0`; staged blob set is empty.
- Working state: 81 modified tracked files, four deleted tracked files, 102 untracked files totaling 3,230,796 bytes.
- Every one of the 85 dirty tracked paths has a stage-0 index blob equal to HEAD; 81 working blobs differ and four working files are absent. The four absent paths are `gravity-mvp/backfill_out.txt` (`2c14967c...`), `gravity-mvp/db_log.txt` (`89f8c103...`), `gravity-mvp/wa_diag.json` (`521cf4a9...`), and `gravity-mvp/wa_out.txt` (`4d646ec9...`).
- Index-only source: none. No older working version or meaningful source intent exists only in the parsed index.
- Missing acceptance field: v1 did not emit an FD-bound raw index SHA-256 or descriptor/name/path stability proof. The successor fixed command supplies exactly those metadata fields without Git execution or index modification.
- Raw and normalized v1 state SHA-256: `6318696f1d66d7bb7451d3a097b20846ace850fd954d1737905aeb33d4ce8f13`.

## 8. Protected Messages Worktree

- Worktree: `/opt/codex-work/crm-messages-remediation-clean`; HEAD `50ae48a5761ced6acb1639497fa80094b108f305`; branch/upstream `dev/messages-complete-remediation` / `origin/dev/messages-complete-remediation`.
- Complete status at `2026-08-08T12:31:50Z`: 1,719 index entries; staged `0`, unstaged `0`, untracked `0`; final classification `CLEAN`.
- Four formerly blocked roots were resolved: 12 root-owned mode-`0644` non-secret files, 14,767 bytes. Root manifest hashes are `b230fdf1...`, `7afc7546...`, `d9db97a7...`, and `d9d8738d...`.
- All 12 corresponding Git blobs exist in the shared object database. None corresponds to a regular production file; unique filesystem-only source count is zero, so no supplemental content preservation was required.
- Raw/normalized SHA-256: `051e9366cd95ad9fcd2ed26a8ea9b91c4fcadef8ed2f68c41a1fd552e9e49a9d`.
- Historical classification is unchanged: this clean historical worktree does not become the single authority for current production Messages.

## 9. Updated Messages Authority

No single current Messages commit exists. Production Messages authority remains a
per-file composite of production HEAD `e6a0a833...`, explicit dirty production
deltas, the production-only snapshot, and applicable release history. The clean
`50ae48a...` worktree and its 12 protected files are historical/reconciliation
evidence; they add no unique current source and do not replace the composite.

## 10. Updated AI Calls Authority

AI Calls remains the separate DEV-only checkpoint
`b38b22d3e00b3fb43d05417131709b3d2c535b2b`. It is not production Audio Bridge
authority and was not promoted. Streaming STT dirty state remains experimental and
non-authoritative.

## 11. Updated Authoritative Source Map

The complete updated map is `AUTHORITATIVE_SOURCE_MAP.json`, SHA-256
`e608ec6d15ecbbe7f498a734b0d3b5e013ea6917a52e1dc580043595d06b2f92`.
Affected rows now distinguish proven content equivalence, frozen authority,
composite production source, historically unrecorded build provenance, and the
four genuinely unresolved runtime/origin cases. No source was deployed or merged.

## 12. Final Component Classifications

- Gravity — `UNRESOLVED` (`BLOCKED_PRIVILEGE`: generated-artifact OCI/origin proof).
- MAX scraper — `PROVEN_CONTENT_EQUIVALENT`.
- Personal MAX — `PROVEN_GIT_REVISION` at `f97532cb6903f033c070856b4a8c207df8e35026`; current continuity pending.
- TG bot — `PROVEN_CONTENT_EQUIVALENT`.
- TG frontend — `UNRESOLVED` (`BLOCKED_PRIVILEGE`: generated-artifact OCI/origin proof).
- YFS API — `UNRESOLVED` (`BLOCKED_PRIVILEGE`: unmatched `worker.ts` origin).
- YFS worker — `PROVEN_CONTENT_EQUIVALENT`.
- Audio Bridge — `PROVEN_CONTENT_EQUIVALENT`.
- FreeSWITCH — `UNRESOLVED` (`BLOCKED_PRIVILEGE`: secret-safe fixed-root OCI/runtime recapture).
- Nginx — `AUTHORITATIVE_PROVEN` live bind authority; current mount continuity pending.

## 13. Residual Provenance Gaps

`HISTORICALLY_UNRECORDED_BUT_FULLY_CHARACTERIZED`:

- MAX scraper, TG bot, YFS worker, and Audio Bridge have full application-content equivalence but no recorded historical build revision/OCI attestation.
- Current Messages production state is a fully enumerated composite rather than one accepted commit.

`GENUINELY_UNRESOLVED`:

- Current safe OCI metadata and writable-layer origin for Gravity and TG frontend generated artifacts.
- Image-versus-writable origin for YFS API `/app/src/worker.ts`.
- Secret-safe FreeSWITCH non-secret override manifest and origin.
- Current Personal MAX and Nginx continuity.
- FD-bound production index SHA/stat/stability proof.

Every genuine gap is addressed by an already reviewed fixed successor command;
none remains because an available installed check was skipped.

## 14. New Evidence Contradictions

- The installed v1 capability was expected to close Docker provenance, but its command deterministically returns `FIXED_COMMAND_FAILED`.
- The installed v1 runtime command captured content but labeled all origins unknown, so it cannot support its intended image/writable distinction.
- The v1 FreeSWITCH scope crossed secret-bearing configuration roots; the entire 444-record component was quarantined rather than propagated.
- An earlier uninstalled successor candidate retained privileged Git execution and was rejected in security review. The final candidate removes Git and Messages traversal entirely; those rejected archives remain marked obsolete and were never installed.

## 15. Secret-Safety Report

- Production Compose content was not copied; only safe metadata was retained.
- FreeSWITCH v1 records were wholly withheld; the successor restricts collection to explicitly reviewed non-secret roots.
- Gravity browser/profile records, Personal MAX state, YFS screenshots, dependency/cache paths, credential stores, command argument values, symlink targets, and environment values were excluded or withheld.
- All continuation JSON parsed. The scan found zero prohibited secret-key fields, private-key markers, credentialed URLs, or Docker-auth shapes.
- No secret value was disclosed in evidence or this report. Secret-safety result: `PASS`.

## 16. Evidence Artifact Inventory

Continuation root:
`/opt/codex-work/crm-arch-000-evidence/crm-arch-000r/20260808T122923Z`.

Material artifact identities:

- `AUTHORITATIVE_SOURCE_MAP.json` — `e608ec6d15ecbbe7f498a734b0d3b5e013ea6917a52e1dc580043595d06b2f92`.
- `SOURCE_CLASSIFICATIONS.json` — `c2063f65b6562c635e4cc6bdd8ded376a407690973456ff5b0e13a22e33880f8`.
- `MUTATION_LEDGER.md` — `07ea288ee84d4bf1b5ccaac48bf41841a28c888c2f8a823c54af5a5404d88aa5`.
- `capability/capability-verification.json` — `3db7e568ac0332b3031b2c8c41c16cdde110ed2ac9ff650db74020922ea4a247`.
- `capability/successor-package-validation.json` — `a93462db5b8d62468a28305339f8995481df6ac6d8dd95eaf7f1a4f34661c624`.
- `capability/successor-security-review.json` — `636f922e8981a20de8ee7175782add92d40b5457a012f0351ece8b4ca54d10ed`.
- `capability/successor-tests.txt` — `0b9075e7201110dee60c619f7f9f59833477e74057d3891a6aa862e6c411152c`.
- Start/end self-check raw and normalized artifacts — each output `4014fb0668b841cf5ae731324f3a1b3574a3c6f61d005a8229ff4a2596f4bd93`.
- `continuity/start-continuity.json` — `7421b432c103305912a5c30ab5591101e94b1f1252dd9e203032ca47af04cb62`.
- `continuity/end-continuity.json` — `1f6fe26c0ca716d69ca5ce4373d8d7f7812e99b9ec6583f6a17a5afea5f29c02`.
- `continuity/snapshot-validation.json` — `c9faa46183a5abafa413f4bda1f681ac44a755e79ac3a2d202e6c57772e26230`.
- `docker-provenance/docker-provenance.raw.json` — `e0180d12837a245362a85d72fc01ae673b289e8456541444de546aa00d069113`.
- `production-git-index/raw/production-git-state.raw.json` and normalized equivalent — `6318696f1d66d7bb7451d3a097b20846ace850fd954d1737905aeb33d4ce8f13` each.
- `messages-worktree/raw/messages-worktree-state.raw.json` and normalized equivalent — `051e9366cd95ad9fcd2ed26a8ea9b91c4fcadef8ed2f68c41a1fd552e9e49a9d` each.
- `runtime-manifests/runtime-content-manifest.v1.sanitized.json` — `1bd1d5100cabeb37277262179ee1119b3dcd9154b9774947dcf218d38e4d19fe`.
- `source-comparisons/README.md` — `9ce849ceec1574760e8268afd9cf1f2239727c763feb22134bd9403e070e8d03`.
- `capability/OWNER_PRIVILEGE_ACTION_REQUIRED.md` — `2a32c1f9eb2125a3535544b0a6bca0afbd0e17a8c9443e0063fe80ff31d7eb34`.

`SHA256SUMS` contains the complete relative-path inventory and hashes for every
sealed regular evidence artifact except itself and `MANIFEST.json`; the manifest
records that explicit non-circular checksum policy.

## 17. Mutation Ledger

- Created only evidence artifacts and local capability staging/build/test artifacts.
- Removed every write bit from the final continuation evidence tree while retaining private read scope for files that were already private.
- Broker calls appended mandatory root-only audit entries.
- Verified installed package/broker/companion/sudoers state and built two byte-identical successor packages.
- Restricted the unsafe v1 runtime artifact to mode `0600`, created a sanitized derivative, and retained rejected uninstalled candidates under `build/obsolete/`.
- Tooling effects were limited to capability-stage `__pycache__` refreshes and Codex-internal waived metadata.
- Confirmed: no production source edit; no Git index refresh/write; no ordinary product ref update; no service/container/image restart, recreation, exec, copy, or mutation; no database, volume, migration, systemd, firewall, Nginx, or FreeSWITCH change; no architecture implementation or deployment.

## 18. Acceptance Checklist

1. Installed capability identity verified — **PASS**.
2. Broker self-check passes — **PASS**.
3. Complete start/end runtime continuity recorded — **FAIL** (known identities recorded; exact ten-service end identity awaits successor).
4. Existing 28-file snapshot validated — **PASS**.
5. No production Compose secret copied — **PASS**.
6. Safe Docker/OCI metadata for every core image-baked service — **FAIL**.
7. Runtime application manifests for every unresolved image-baked service — **FAIL** (FreeSWITCH safe recapture pending).
8. Every core image-baked service in one allowed proven/artifact class — **FAIL**.
9. No component remains high-confidence because a privileged check was not executed — **FAIL** (corrected installation required).
10. Production index exact state known — **FAIL** (staged set is known; raw FD-bound identity/hash/stability is pending).
11. Unique index-only source identified — **PASS** (none).
12. Protected Messages hidden state known — **PASS**.
13. Unique non-secret hidden Messages source preserved — **NOT APPLICABLE** (none exists).
14. Personal MAX authority remains verified — **PASS** (frozen revision; current container continuity is item 3/6).
15. AI Calls DEV remains separated — **PASS**.
16. Updated source-map rows produced — **PASS**.
17. Evidence files/manifests checksummed — **PASS**.
18. Mutation ledger complete — **PASS**.
19. No production source changed — **PASS**.
20. No production index changed — **PASS**.
21. No ordinary product Git ref changed — **PASS**.
22. No service/container restarted or recreated — **PASS**.
23. No database or volume changed — **PASS**.
24. No architecture implementation began — **PASS**.
25. Remaining uncertainty is only historical absence, not an unavailable check — **FAIL** (installation boundary remains).
26. Final report complete and internally consistent — **PASS**.

## 19. Architecture Risk Delta

- Removed: uncertainty that production contains an index-only staged source version; the parsed staged set is empty and every dirty tracked index blob equals HEAD.
- Removed: uncertainty that protected Messages roots contain unique hidden current source; all 12 files are represented by shared Git blobs and add no production match.
- Refined: Messages authority is demonstrably composite, while `50ae48a...` is clean historical evidence rather than current authority.
- Added/refined: installed v1 Docker/runtime evidence is not sufficient for OCI/origin acceptance; FreeSWITCH v1 evidence is quarantined.
- Added/refined: broad privileged Git execution is an unnecessary security surface. The reviewed successor removes it and exposes only FD-bound fixed-path index metadata.
- Unchanged: Gravity/TG frontend generated provenance, YFS API divergence, historical build attestations, and operational-versus-formal acceptance remain architecture risks, not application-fix authorization.

## 20. Recommended Next Gate

Evidence remains blocked. Do not begin CRM-ARCH-001. Install only the sealed
successor, then Codex must autonomously run `self-check`, `docker-provenance`,
`runtime-content-manifest`, and `production-index-metadata`, reconcile only the
affected rows, perform final continuity/secret/checksum validation, and reassess
CRM-ARCH-000 acceptance.

Exact artifact: `/opt/codex-work/crm-arch-000-capability-v3/dist/yoko-crm-arch-evidence_1.2.0-1_all.deb`  
Exact SHA-256: `af6512b446a662734f292fda3f3f861500dd9610657bfd7f9cbfcca4551a9e47`  
Exact root-owned target: `/var/lib/yoko-crm-arch-evidence-af6512b446a662734f292fda3f3f861500dd9610657bfd7f9cbfcca4551a9e47.deb`

One Owner installation command, run as `codexbot`:

```bash
sudo /usr/bin/install -o root -g root -m 0444 /opt/codex-work/crm-arch-000-capability-v3/dist/yoko-crm-arch-evidence_1.2.0-1_all.deb /var/lib/yoko-crm-arch-evidence-af6512b446a662734f292fda3f3f861500dd9610657bfd7f9cbfcca4551a9e47.deb && sudo /usr/bin/dpkg --install /var/lib/yoko-crm-arch-evidence-af6512b446a662734f292fda3f3f861500dd9610657bfd7f9cbfcca4551a9e47.deb
```

This is the only Owner action. It performs no broker, Docker, Git, source, index,
or filesystem evidence inspection on the Owner's behalf. After installation is
reported, Codex will automatically verify the root-owned target, installed
package/broker/companion/sudoers identities, and exact self-check before running
the remaining evidence commands itself.

CRM-ARCH-000R BLOCKED BY UNAVOIDABLE PRIVILEGE BOUNDARY
