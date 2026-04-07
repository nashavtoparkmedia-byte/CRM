import { prisma } from '@/lib/prisma'

/**
 * Update the reachability status of a ContactIdentity.
 *
 * Called from two places:
 * 1. check-reachability API — after live pre-check
 * 2. MessageService.send() — after delivery outcome
 *
 * Rules:
 * - Only 'confirmed' and 'unreachable' are valid updates
 * - Soft fallback / timeout / errors must NOT call this function
 * - Always updates reachabilityCheckedAt timestamp
 */
export async function updateReachability(
  identityId: string,
  status: 'confirmed' | 'unreachable'
): Promise<void> {
  try {
    await prisma.contactIdentity.update({
      where: { id: identityId },
      data: {
        reachabilityStatus: status,
        reachabilityCheckedAt: new Date(),
      },
    })
  } catch (err: any) {
    // Non-critical — don't break the caller's flow
    console.error(`[ReachabilityService] Failed to update ${identityId} → ${status}: ${err.message}`)
  }
}

/**
 * Find a ContactIdentity by phone number and channel.
 * Used by check-reachability API to persist the result.
 *
 * Strategy: first try externalId match (works for WA/MAX where externalId = phone digits),
 * then try via ContactPhone → ContactIdentity (works for TG where externalId = telegramUserId).
 */
export async function findIdentityByPhoneAndChannel(
  phone: string,
  channel: string
): Promise<string | null> {
  const digits = phone.replace(/\D/g, '')

  // 1. Direct externalId match (WA, MAX)
  const direct = await prisma.contactIdentity.findFirst({
    where: {
      channel: channel as any,
      externalId: { in: [digits, phone, `+${digits}`] },
      isActive: true,
    },
    select: { id: true },
  })
  if (direct) return direct.id

  // 2. Via phone → identity (TG where externalId is telegramUserId, not phone)
  const viaPhone = await prisma.contactIdentity.findFirst({
    where: {
      channel: channel as any,
      isActive: true,
      phone: {
        phone: { in: [phone, `+${digits}`] },
      },
    },
    select: { id: true },
  })

  return viaPhone?.id || null
}

/**
 * Update reachability for a Chat's linked ContactIdentity.
 * Used by MessageService after delivery outcome.
 */
export async function updateReachabilityByChatId(
  chatId: string,
  status: 'confirmed' | 'unreachable'
): Promise<void> {
  try {
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      select: { contactIdentityId: true },
    })

    if (chat?.contactIdentityId) {
      await updateReachability(chat.contactIdentityId, status)
    }
  } catch (err: any) {
    console.error(`[ReachabilityService] Failed to update by chatId ${chatId}: ${err.message}`)
  }
}
