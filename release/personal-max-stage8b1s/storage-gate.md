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

The prepared backup script independently fails closed unless free space is at least 12,500,000,000 bytes and at least the calculated backup estimate plus a 5 GiB reserve. It rechecks that reserve after backup creation. With the current storage boundary, the root action must not be started because its free-space gate would intentionally fail.

No disk expansion, Docker cleanup, image pull/load, production write, backup, migration, deploy, restart, browser action, MAX action, or provider action was performed.
