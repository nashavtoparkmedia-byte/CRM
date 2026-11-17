// The person card's «Проверить» (Contact Identity V2, W5): which stored number
// and which exact provider binding a reachability check of one Contact's phone or
// account may use. Contacts resolves both on the server from exact ids that must
// belong to the Contact; a number never comes from the request. Read only.
import { prisma } from '@/lib/prisma'
import { identityEvidenceState } from '../public/v1/contact-evidence-state'

export const CONTACT_REACHABILITY_CHANNELS_V1 = ['telegram', 'whatsapp', 'max'] as const
export type ContactReachabilityChannelV1 = typeof CONTACT_REACHABILITY_CHANNELS_V1[number]

export type ContactReachabilityTargetV1 =
  | {
      status: 'found'
      /** The stored E.164 number; it goes to the provider check, never back to the browser. */
      phone: string
      exactBinding: { identityId: string; contactId: string; providerAccountId: string } | null
    }
  | { status: 'not_found' }

type Client = Pick<typeof prisma, 'contact' | 'contactIdentity' | 'contactPhone'>

export function makeContactReachabilityTargetReaderV1(client: Client) {
  return async function readContactReachabilityTargetV1(input: {
    contactId: string
    channel: ContactReachabilityChannelV1
    phoneId: string | null
    identityId: string | null
  }): Promise<ContactReachabilityTargetV1> {
    const notFound = { status: 'not_found' } as const
    const contact = await client.contact.findUnique({ where: { id: input.contactId }, select: { id: true, isArchived: true } })
    if (contact === null || contact.isArchived) return notFound
    const identity = input.identityId === null
      ? null
      : await client.contactIdentity.findFirst({
          where: { id: input.identityId, contactId: contact.id, channel: input.channel },
          select: { id: true, phoneId: true, isActive: true, metadata: true },
        })
    if (input.identityId !== null && identity === null) return notFound
    // An account checks on its own number; a phone named beside it must be that number.
    if (identity?.phoneId && input.phoneId !== null && identity.phoneId !== input.phoneId) return notFound
    const phoneId = input.phoneId ?? identity?.phoneId ?? null
    if (phoneId === null) return notFound
    const phone = await client.contactPhone.findFirst({ where: { id: phoneId, contactId: contact.id }, select: { phone: true, isActive: true } })
    if (phone === null || !phone.isActive) return notFound
    let exactBinding: { identityId: string; contactId: string; providerAccountId: string } | null = null
    if (identity !== null && identity.isActive !== false) {
      const evidence = identityEvidenceState(identity.metadata)
      const account = evidence.providerAccountId
      if (evidence.conflictState !== 'conflicted' && account !== 'legacy' && account.trim() === account && account !== '') {
        exactBinding = { identityId: identity.id, contactId: contact.id, providerAccountId: account }
      }
    }
    return { status: 'found', phone: phone.phone, exactBinding }
  }
}

export const readContactReachabilityTargetV1 = makeContactReachabilityTargetReaderV1(prisma)
