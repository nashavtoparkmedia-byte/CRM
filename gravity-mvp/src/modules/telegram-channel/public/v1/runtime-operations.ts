'use server'

import {
  checkTelegramReachability,
  getTelegramConnections,
  importTelegramHistory,
  initTelegramListeners,
  stopTelegramHealthCheck,
} from '@/app/tg-actions'

import type { TelegramConnectionPublicMetadata } from './telegram-connection-public-metadata'

export type TelegramReachabilityResultV1 = {
  reachable: boolean
  telegramId?: string
  providerAccountId?: string
  error?: string
}

/** Start the owner-managed Telegram listeners and health monitor. */
export async function initializeTelegramRuntimeV1(): Promise<void> {
  await initTelegramListeners()
}

/** Stop the owner-managed health monitor during graceful application shutdown. */
export async function stopTelegramRuntimeV1(): Promise<void> {
  await stopTelegramHealthCheck()
}

/** Send only a plain Telegram text message; provider metadata stays owner-local. */
export async function sendTelegramTextV1(
  _phone: string,
  _message: string,
  _connectionId?: string,
): Promise<unknown> {
  throw new Error('CONTACT_CONVERSATION_IDENTITY_REQUIRED')
}

export async function importTelegramHistoryV1(
  jobId: string,
  mode: string,
  daysBack?: number,
  connectionId?: string,
): Promise<void> {
  await importTelegramHistory(jobId, mode, daysBack, connectionId)
}

export async function checkTelegramReachabilityV1(
  phone: string,
  requestedProviderAccountId?: string,
): Promise<TelegramReachabilityResultV1> {
  return checkTelegramReachability(phone, requestedProviderAccountId)
}

/** Existing integration-admin authorization and credential-safe projection are preserved. */
export async function listTelegramConnectionsV1(): Promise<TelegramConnectionPublicMetadata[]> {
  return getTelegramConnections()
}
