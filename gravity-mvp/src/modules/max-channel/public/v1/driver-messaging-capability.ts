"use server"

import { getMaxConnections } from '@/app/max-actions'

export interface MaxDriverMessageOptionsV1 {
  connectionId?: string
  isPersonal?: boolean
  name?: string
}
/** MAX-owned browser-safe connection query; authorization remains in the owner action. */
export async function listMaxDriverDeliveryConnectionsV1() {
  return getMaxConnections()
}

/** MAX-owned façade for the exact manager-to-driver send shape. */
export async function sendMaxDriverMessageV1(
  _phone: string,
  _message: string,
  _options?: MaxDriverMessageOptionsV1,
) {
  throw new Error('CONTACT_CONVERSATION_IDENTITY_REQUIRED')
}
