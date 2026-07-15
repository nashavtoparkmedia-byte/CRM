import { NextResponse } from 'next/server'
import { MessageService } from '@/lib/MessageService'
import { prisma } from '@/lib/prisma'
import { buildCanonicalContactSummary } from '@/lib/contact-display'

const PROFILE_CHANNELS = ['max', 'whatsapp', 'telegram']

interface ConversationContactRecord {
    id: string
    displayName: string | null
    displayNameSource?: string | null
    identities?: Array<{ metadata: Record<string, string | null> | null }>
    canonicalSummary?: ReturnType<typeof buildCanonicalContactSummary>
    [key: string]: unknown
}

interface ConversationRecord {
    id: string
    channel: string
    contactId?: string | null
    allChannels?: string[]
    contact?: ConversationContactRecord | null
    [key: string]: unknown
}

// Lazy init: ensure Telegram listeners are running on first API call
let _tgInitDone = false
async function ensureTelegramListeners() {
    if (_tgInitDone) return
    _tgInitDone = true
    try {
        const { initTelegramListeners } = await import('@/app/tg-actions')
        await initTelegramListeners()
        console.log('[API-CONVERSATIONS] Telegram listeners initialized (lazy)')
    } catch (err: any) {
        console.error('[API-CONVERSATIONS] Failed to init TG listeners:', err.message)
        _tgInitDone = false // Allow retry on next call
    }
}

export async function GET() {
    try {
        // Fire-and-forget TG init (don't block the response)
        ensureTelegramListeners().catch(() => {})
        
        const conversations = await MessageService.listConversations() as ConversationRecord[]
        const contactIds = Array.from(new Set(conversations
            .map(conversation => conversation.contactId || conversation.contact?.id)
            .filter((contactId): contactId is string => Boolean(contactId))))
        const contacts = contactIds.length > 0
            ? await prisma.contact.findMany({
                where: { id: { in: contactIds }, isArchived: false },
                select: {
                    id: true,
                    displayName: true,
                    displayNameSource: true,
                    primaryPhoneId: true,
                    mainDriverId: true,
                    phones: {
                        where: { isActive: true },
                        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
                        select: { id: true, phone: true, isPrimary: true },
                    },
                    identities: {
                        where: { isActive: true },
                        orderBy: { createdAt: 'asc' },
                        select: {
                            channel: true,
                            externalId: true,
                            displayName: true,
                            metadata: true,
                        },
                    },
                },
            })
            : []
        const profiles = contactIds.length > 0
            ? await prisma.driver.findMany({
                where: { contactId: { in: contactIds } },
                select: {
                    id: true,
                    contactId: true,
                    fullName: true,
                    phone: true,
                    segment: true,
                    dismissedAt: true,
                    lastExternalPark: true,
                },
            })
            : []
        const contactsById = new Map(contacts.map(contact => [contact.id, contact]))
        const profilesByContactId = new Map<string, typeof profiles>()
        for (const profile of profiles) {
            if (!profile.contactId) continue
            const grouped = profilesByContactId.get(profile.contactId) || []
            grouped.push(profile)
            profilesByContactId.set(profile.contactId, grouped)
        }
        const enriched = conversations.map(conversation => {
            const contactId = conversation.contactId || conversation.contact?.id
            const contact = contactId ? contactsById.get(contactId) : null
            if (!contact) return conversation
            const providerChannels = contact.phones.length > 0
                ? PROFILE_CHANNELS
                : Array.from(new Set([
                    ...contact.identities.map(identity => identity.channel),
                    ...(conversation.allChannels || [conversation.channel]),
                ]))
            const canonicalSummary = buildCanonicalContactSummary({
                contact,
                profiles: profilesByContactId.get(contact.id) || [],
                currentChannel: conversation.channel,
                providerChannels,
            })
            return {
                ...conversation,
                contact: {
                    ...(conversation.contact || { id: contact.id, displayName: contact.displayName }),
                    canonicalSummary,
                },
            }
        })
        return NextResponse.json(enriched)
    } catch (error: any) {
        console.error('[API-CONVERSATIONS] GET Error:', error)
        return NextResponse.json({ 
            error: 'Internal Server Error', 
            details: error.message,
            stack: error.stack 
        }, { status: 500 })
    }
}
