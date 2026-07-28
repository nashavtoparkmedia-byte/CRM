# Stage 8B1S storage inventory

Inventory was limited to accessible codexbot paths and metadata. No production message content, Chromium profile contents, PostgreSQL files, Docker layer contents, or secret-file contents were scanned.

## Worktrees

- Registered before cleanup: 43; measured bytes: 6,721,044,480.
- Registered after cleanup: 33; measured bytes: 4,621,484,032.
- Successful removals: 9; logical bytes measured immediately before removal: 1,938,558,976.
- One additional clean worktree became unregistered when `git worktree remove` encountered root-owned `.next` output. Its preserved residue is `/opt/codex-work/crm-messages-complete-clean`, 143,093,760 bytes at the post-failure measurement. No force, `sudo`, ownership change, or direct file removal was used.
- Every worktree candidate, exact branch, HEAD, guard result, remote reachability result, measured size, and final action is recorded in `cleanup-manifest.json`.

The current Stage 8B1R worktree, `/opt/crm`, `/opt/codex-work/crm`, the designated baseline `/opt/codex-work/crm-max-outbound-text-final`, all root-owned worktrees, process-referenced worktrees, non-ancestor histories, locked worktrees, and worktrees with root-owned ignored output were excluded.

## Releases and distribution artifacts

- `/opt/codex-work/releases`: 2,394,808,320 bytes after inventory; removed: 0 bytes.
- Protected architecture package: `/opt/codex-work/releases/personal-max-transport-architecture-20260726T132916Z`, 22 files, checksum verification passed.
- The adjacent `personal-max-transport-architecture-20260726T132916Z-review.tar.gz` is empty, but it belongs to the protected architecture handoff and was preserved.
- No local Personal MAX OCI/tar artifact met all required gates: accepted digest match, committed checksum, authoritative GHCR availability, reconstructibility, Personal MAX ownership, and non-production location.
- Large root-owned historical release directories were not treated as safe candidates because they are outside the Personal MAX Stage scope and may be the only authoritative evidence.

## Temporary artifacts and disposable databases

- Removed: 26 exact Stage 8B1R top-level paths in `/tmp`; allocated bytes reclaimed at filesystem class boundary: 12,066,816.
- All selected paths were codexbot-owned, non-symlink, process-unreferenced, non-runtime logs/downloaded metadata/test evidence, and reproducible. The exact path list is in `cleanup-manifest.json`.
- Disposable PostgreSQL roots found under `/tmp` and `/home/codexbot`: 0 (`PG_VERSION` marker search).
- Associated disposable PostgreSQL port: not applicable because no root was found. No Stage-specific process was active.
- Generic `/tmp/node-compile-cache`, `/tmp/maxbundle-fast`, YOKO logs, message-data-looking files, root-owned patches, and unrelated temp directories were preserved.

## Caches

The following were inventoried by directory metadata and preserved because they are generic, protected, or not provably Stage-specific:

| Path | Bytes | Owner | Type | Action / risk |
|---|---:|---|---|---|
| `/home/codexbot/.npm` | 741,597,184 | codexbot | generic npm cache | preserve; generic cache deletion forbidden |
| `/home/codexbot/.cache` | 700,534,784 | codexbot | mixed cache | preserve; Prisma/browser attribution not safely unique |
| `/home/codexbot/.codex` | 542,318,592 | codexbot | Codex state | protected; not a cleanup candidate |
| `/home/codexbot/.local` | 231,862,272 | codexbot | user-local tools/data | preserve; uncertain provenance |

Total preserved cache/state bytes in these four paths: 2,216,312,832.

## Candidate decision model

Committed means the tracked worktree state was clean and untracked count was zero. Remote provenance means the exact candidate HEAD was an ancestor of the exact `origin/feature/personal-max-stage8b1r-release-hardening-20260727T220905Z` SHA `f78259001a2a8b1dfce088344216877f5dd64cf2`. This proves the commit is reconstructible from the published branch history. Deletion was still denied if any ownership, process, lock, symlink, archive, protected-path, or unique-artifact guard failed.
