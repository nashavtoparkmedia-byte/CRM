// The only database reader behind ContactReachabilityEvidenceView.v1.
//
// It touches Contact and ContactIdentity and nothing else — no Chat, Message,
// Driver, Task, Call, ProviderAccount, Transport or ConversationRoute — so the
// view cannot acquire foreign-domain state through its persistence port. It makes
// no provider call and runs no live probe: every value it returns is already
// persisted Contacts-owned state.
//
// It selects no provider target at all. The projection needs none, so `externalId`
// never leaves the database, and `metadata` is not read either.

import { prisma } from '@/lib/prisma'

import type {
  ContactReachabilityEvidenceSourceV1,
  ContactReachabilityEvidenceViewPortV1,
} from './contact-reachability-evidence-view'

export const legacyPrismaContactReachabilityEvidenceViewPortV1: ContactReachabilityEvidenceViewPortV1 = {
  async findContactReachabilityEvidenceSource(
    contactId,
  ): Promise<ContactReachabilityEvidenceSourceV1 | null> {
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      select: {
        id: true,
        identities: {
          select: {
            id: true,
            channel: true,
            isActive: true,
            reachabilityStatus: true,
            reachabilityCheckedAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!contact) return null

    return {
      id: contact.id,
      identities: contact.identities.map(identity => ({
        id: identity.id,
        channel: String(identity.channel),
        isActive: identity.isActive,
        reachabilityStatus: identity.reachabilityStatus,
        reachabilityCheckedAt: identity.reachabilityCheckedAt,
      })),
    }
  },
}
