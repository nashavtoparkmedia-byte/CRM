"use server"

import {
  listMaxDriverDeliveryConnectionsV1 as listMaxOwnedDriverDeliveryConnectionsV1,
  sendMaxDriverMessageV1 as sendMaxOwnedDriverMessageV1,
} from '@/modules/max-channel/public/v1/driver-messaging-capability'

export interface MaxDriverMessageOptionsV1 {
  connectionId?: string
  isPersonal?: boolean
  name?: string
}
/** Browser-safe MAX connection metadata with the existing admin authorization. */
export async function listMaxDriverDeliveryConnectionsV1() {
  return listMaxOwnedDriverDeliveryConnectionsV1()
}

/** Exact cross-context composition for a manager-to-driver MAX message. */
export async function sendMaxDriverMessageV1(
  phone: string,
  message: string,
  options?: MaxDriverMessageOptionsV1,
) {
  return sendMaxOwnedDriverMessageV1(phone, message, options)
}
