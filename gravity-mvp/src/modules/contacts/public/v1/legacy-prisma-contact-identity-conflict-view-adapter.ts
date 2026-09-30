// The only database reader behind ContactIdentityConflictView.v1.
//
// It touches Contacts-owned models only — Contact and ContactIdentity — and never
// Chat, Message, Driver, Task, Call or any provider table, so the view cannot
// acquire foreign-domain state through its persistence port. It assembles nothing:
// it returns the exact source shape and the pure projection does the rest.
//
// `externalId` is selected because the transport-only classifier needs it as an
// input. It is consumed inside the projection and never reaches the result.

import { prisma } from '@/lib/prisma'

import type {
  ContactIdentityConflictViewPortV1,
  ContactIdentityConflictViewSourceV1,
} from './contact-identity-conflict-view'

export const legacyPrismaContactIdentityConflictViewPortV1: ContactIdentityConflictViewPortV1 = {
  async findContactIdentityConflictSource(contactId): Promise<ContactIdentityConflictViewSourceV1 | null> {
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      select: {
        id: true,
        customFields: true,
        identities: {
          select: { id: true, channel: true, externalId: true, isActive: true, metadata: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!contact) return null

    return {
      id: contact.id,
      customFields: contact.customFields,
      identities: contact.identities.map(identity => ({
        id: identity.id,
        channel: String(identity.channel),
        externalId: identity.externalId,
        isActive: identity.isActive,
        metadata: identity.metadata,
      })),
    }
  },
}
