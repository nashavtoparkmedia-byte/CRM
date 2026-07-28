import {
  SESSION_OWNER_ACQUISITION_ACCOUNTS,
  SESSION_OWNER_HEARTBEAT_ACCOUNTS,
  SESSION_OWNER_PERSISTENCE_ACCOUNTS,
  SESSION_OWNER_PHYSICAL_SENDER_ACCOUNTS,
  SESSION_OWNER_SENDER_FENCING_ACCOUNTS,
} from './constants.ts'

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export interface SessionOwnerFeatureFlags {
  readonly persistence: boolean
  readonly acquisition: boolean
  readonly heartbeat: boolean
  readonly senderFencing: boolean
  readonly physicalSender: boolean
}

function enabled(accountId: string, raw: string | undefined): boolean {
  if (!ACCOUNT_ID_PATTERN.test(accountId) || accountId === '*' || raw === undefined || raw === '') return false
  const accounts = new Set<string>()
  for (const token of raw.split(',')) {
    if (!ACCOUNT_ID_PATTERN.test(token) || token === '*' || token !== token.trim()) return false
    accounts.add(token)
  }
  return accounts.has(accountId)
}

export function sessionOwnerFeatureFlags(accountId: string, environment: Readonly<Record<string, string | undefined>>): SessionOwnerFeatureFlags {
  return Object.freeze({
    persistence: enabled(accountId, environment[SESSION_OWNER_PERSISTENCE_ACCOUNTS]),
    acquisition: enabled(accountId, environment[SESSION_OWNER_ACQUISITION_ACCOUNTS]),
    heartbeat: enabled(accountId, environment[SESSION_OWNER_HEARTBEAT_ACCOUNTS]),
    senderFencing: enabled(accountId, environment[SESSION_OWNER_SENDER_FENCING_ACCOUNTS]),
    physicalSender: enabled(accountId, environment[SESSION_OWNER_PHYSICAL_SENDER_ACCOUNTS]),
  })
}
