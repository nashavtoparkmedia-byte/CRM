"use server"

import { getMaxConnections, sendMaxMessage } from '@/app/max-actions'

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
  phone: string,
  message: string,
  options?: MaxDriverMessageOptionsV1,
) {
  return sendMaxMessage(phone, message, options)
}
