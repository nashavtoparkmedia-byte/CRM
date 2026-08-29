/**
 * Compatibility export for consumers not yet migrated to the versioned
 * Operations Observability surface.
 */
export { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
export type {
  OperationalLogContextV1 as LogContext,
  OperationalLogLevelV1 as LogLevel,
} from '@/infrastructure/operations/operational-log'
