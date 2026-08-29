# CRM-ARCH-007 Fleet clear-check-status selection

Selected `migration_1e5e17cb2e9c36b5`, the complete one-site Platform Shell
maintenance-script write to Fleet-owned `Driver.lastFleetCheckStatus`. Platform
Shell already depends on `fleet_operations.public`; this slice adds one explicit
Fleet maintenance command and no graph edge.

The script keeps its start log and fail-visible CLI boundary. Fleet owns the
all-driver update, success-count log and standalone Prisma lifecycle, including
disconnect in `finally`. The script was not executed; this is source isolation
only and performs no database maintenance.
