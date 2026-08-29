import {
  checkWhatsAppReachabilityV1 as checkOwnerWhatsAppReachabilityV1,
  forceSyncWhatsAppRuntimeV1 as forceSyncOwnerWhatsAppRuntimeV1,
  importWhatsAppHistoryV1 as importOwnerWhatsAppHistoryV1,
  initializeWhatsAppRuntimeV1 as initializeOwnerWhatsAppRuntimeV1,
  inspectWhatsAppStoreV1 as inspectOwnerWhatsAppStoreV1,
  listWhatsAppRuntimeEntriesV1 as listOwnerWhatsAppRuntimeEntriesV1,
  readWhatsAppRuntimeConnectionV1 as readOwnerWhatsAppRuntimeConnectionV1,
} from '@/modules/whatsapp-channel/public/v1/runtime-operations'

/** Exact application-shell compositions; no provider object crosses this boundary. */
export function checkOperationalWhatsAppReachabilityV1(phone: string, connectionId?: string) {
  return checkOwnerWhatsAppReachabilityV1(phone, connectionId)
}

export function forceSyncOperationalWhatsAppV1(connectionId: string) {
  return forceSyncOwnerWhatsAppRuntimeV1(connectionId)
}

export function importOperationalWhatsAppHistoryV1(
  jobId: string,
  mode: string,
  daysBack?: number,
  connectionId?: string,
) {
  return importOwnerWhatsAppHistoryV1(jobId, mode, daysBack, connectionId)
}

export function initializeOperationalWhatsAppV1(connectionId: string) {
  return initializeOwnerWhatsAppRuntimeV1(connectionId)
}

export function inspectOperationalWhatsAppStoreV1(connectionId: string, chatId?: string, limit?: number) {
  return inspectOwnerWhatsAppStoreV1(connectionId, chatId, limit)
}

export function listOperationalWhatsAppRuntimeEntriesV1() {
  return listOwnerWhatsAppRuntimeEntriesV1()
}

export function readOperationalWhatsAppRuntimeConnectionV1(connectionId: string) {
  return readOwnerWhatsAppRuntimeConnectionV1(connectionId)
}
