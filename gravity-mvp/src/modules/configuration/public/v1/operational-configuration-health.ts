import {
  getRecentConfigChanges,
  validateAllConfigs,
  validateCronSchedules,
} from '@/lib/config-validator'

export interface OperationalConfigurationValidationV1 {
  valid: boolean
  errors: string[]
  checkedRules: number
  timestamp: string
}

export interface OperationalCronScheduleValidationV1 {
  valid: boolean
  errors: string[]
  schedules: number
}

export interface ConfigurationChangeEntryV1 {
  id: number
  parameterName: string
  previousValue: string | null
  newValue: string
  changedAt: Date
  changedBy: string | null
}

/** Read-only startup and monitoring view of Configuration-owned validation. */
export function validateOperationalConfigurationV1(): OperationalConfigurationValidationV1 {
  return validateAllConfigs()
}

/** Read-only view of the Configuration-owned cron schedule policy. */
export function validateOperationalCronSchedulesV1(): OperationalCronScheduleValidationV1 {
  return validateCronSchedules()
}

/** Read-only, bounded audit view; Configuration retains query and table ownership. */
export function listRecentConfigurationChangesV1(
  limit: number = 20,
): Promise<ConfigurationChangeEntryV1[]> {
  return getRecentConfigChanges(limit)
}
