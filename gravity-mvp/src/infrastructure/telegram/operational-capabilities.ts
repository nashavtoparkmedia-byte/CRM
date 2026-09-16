'use server'

import {
  checkTelegramReachabilityV1 as checkOwnerTelegramReachabilityV1,
  importTelegramHistoryV1 as importOwnerTelegramHistoryV1,
  initializeTelegramRuntimeV1 as initializeOwnerTelegramRuntimeV1,
  listTelegramConnectionsV1 as listOwnerTelegramConnectionsV1,
  stopTelegramRuntimeV1 as stopOwnerTelegramRuntimeV1,
} from '@/modules/telegram-channel/public/v1/runtime-operations'

/** Exact application-shell compositions; no Telegram provider object crosses this boundary. */
export async function initializeOperationalTelegramRuntimeV1(): Promise<void> {
  await initializeOwnerTelegramRuntimeV1()
}

export async function stopOperationalTelegramRuntimeV1(): Promise<void> {
  await stopOwnerTelegramRuntimeV1()
}

export async function sendOperationalTelegramTextV1(
  _phone: string,
  _message: string,
  _connectionId?: string,
) {
  throw new Error('CONTACT_CONVERSATION_IDENTITY_REQUIRED')
}

export async function importOperationalTelegramHistoryV1(
  jobId: string,
  mode: string,
  daysBack?: number,
  connectionId?: string,
): Promise<void> {
  await importOwnerTelegramHistoryV1(jobId, mode, daysBack, connectionId)
}

export async function checkOperationalTelegramReachabilityV1(
  phone: string,
  requestedProviderAccountId?: string,
) {
  return checkOwnerTelegramReachabilityV1(phone, requestedProviderAccountId)
}

export async function listOperationalTelegramConnectionsV1() {
  return listOwnerTelegramConnectionsV1()
}
