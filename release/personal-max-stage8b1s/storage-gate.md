# Stage 8B1S storage gate

## Observed class boundaries

| Boundary | Total bytes | Used bytes | Free bytes | Used |
|---|---:|---:|---:|---:|
| Before cleanup manifest | 67,444,793,344 | 63,989,260,288 | 3,438,755,840 | 95% |
| After worktree cleanup | 67,444,793,344 | 62,032,777,216 | 5,395,238,912 | 92% |
| After Stage temp cleanup | 67,444,793,344 | 62,020,710,400 | 5,407,305,728 | 92% |

The required target is 12,500,000,000 free bytes. The exact deficit at the completed cleanup boundary is 7,092,694,272 bytes. No release artifact passed all deletion gates, so the release-artifact class reclaimed zero bytes.

Safe cleanup is exhausted. The minimum recommended expansion is the exact deficit plus 5 GiB operational margin:

- deficit: 7,092,694,272 bytes;
- additional operational margin: 5,368,709,120 bytes;
- minimum expansion: 12,461,403,392 bytes;
- minimum resulting filesystem size: 79,906,196,736 bytes;
- practical provisioned target: at least 80,000,000,000 bytes total.

## Post-expansion verification

The provider expansion is now fully visible through every required layer. `/dev/vda` is 85,899,345,920 bytes (80 GiB), `/dev/vda1` is 85,782,937,088 bytes, and the mounted ext4 filesystem is 83,053,432,832 bytes. Free space was 22,103,773,184 bytes, 9,603,773,184 bytes above the target. This is `CASE_A_FULLY_EXPANDED`; no grow/resize package or root filesystem action is required.

The prepared backup script independently fails closed unless free space is at least 12,500,000,000 bytes and at least the dump estimate, a second conservative temporary-dump allowance, config budget, and a 5 GiB reserve. The calculated minimum is 5,708,165,153 bytes, so the controlling gate remains 12,500,000,000 bytes. It rechecks the 5 GiB reserve after backup creation.

No disk expansion, Docker cleanup, image pull/load, production write, backup, migration, deploy, restart, browser action, MAX action, or provider action was performed.
