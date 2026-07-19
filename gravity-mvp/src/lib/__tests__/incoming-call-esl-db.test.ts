import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { prisma } from '@/lib/prisma'

const broadcastCallMock = vi.hoisted(() => vi.fn())
const broadcastMessageMock = vi.hoisted(() => vi.fn())
const opsLogMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/callStreamBus', () => ({ broadcastCall: broadcastCallMock }))
vi.mock('@/lib/messageStreamBus', () => ({ broadcastChatMessage: broadcastMessageMock }))
vi.mock('@/lib/opsLog', () => ({ opsLog: opsLogMock }))
vi.mock('@/lib/freeswitch/recordingProcessor', () => ({
    processRecording: vi.fn(async () => undefined),
}))

import {
    handleChannelAnswer,
    handleChannelCreate,
    handleChannelHangup,
    syncCallToChat,
} from '@/lib/freeswitch/EslClient'

const dbDescribe = process.env.INCOMING_CALL_ESL_DB_TEST === '1'
    ? describe
    : describe.skip

type EslHeaders = Record<string, string | undefined>

function event(headers: EslHeaders) {
    return {
        getHeader(name: string) {
            return headers[name] ?? null
        },
    }
}

function createEvent(fsUuid: string, callerNumber = '+79222155750') {
    return event({
        'Channel-Name': 'sofia/external/incoming@example.test',
        'Channel-Call-UUID': fsUuid,
        'Call-Direction': 'inbound',
        'Caller-Caller-ID-Number': callerNumber,
        'Caller-Destination-Number': '+73430000000',
        variable_sip_call_id: `sip-${fsUuid}`,
    })
}

function answerEvent(fsUuid: string) {
    return event({
        'Channel-Name': 'sofia/external/incoming@example.test',
        'Channel-Call-UUID': fsUuid,
    })
}

function hangupEvent(fsUuid: string, billsec = 0) {
    return event({
        'Channel-Name': 'sofia/external/incoming@example.test',
        'Channel-Call-UUID': fsUuid,
        'Hangup-Cause': billsec > 0 ? 'NORMAL_CLEARING' : 'NO_ANSWER',
        variable_billsec: String(billsec),
    })
}

async function createContactWithPhone(
    displayName: string,
    phone: string,
    isArchived = false,
) {
    const contact = await prisma.contact.create({
        data: { displayName, isArchived },
    })
    const contactPhone = await prisma.contactPhone.create({
        data: {
            contactId: contact.id,
            phone,
            source: 'manual',
            isPrimary: true,
        },
    })
    await prisma.contact.update({
        where: { id: contact.id },
        data: { primaryPhoneId: contactPhone.id },
    })
    return { contact, contactPhone }
}

dbDescribe('incoming FreeSWITCH call integration against isolated PostgreSQL', () => {
    beforeEach(async () => {
        vi.clearAllMocks()
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "MessageAttachment", "Message", "Chat", "Call", "ContactPhone", "ContactMerge", "Contact", "Driver" CASCADE',
        )
    })

    afterAll(async () => {
        await prisma.$disconnect()
    })

    it('creates one Contact and one timeline row when the valid phone has no owner', async () => {
        const fsUuid = 'call-owner-0'

        await handleChannelCreate(createEvent(fsUuid))
        const call = await prisma.call.findUniqueOrThrow({ where: { fsUuid } })

        expect(call.contactId).toBeTruthy()
        expect(await prisma.contact.count()).toBe(1)
        expect(await prisma.contactPhone.count({
            where: { contactId: call.contactId!, phone: '+79222155750' },
        })).toBe(1)

        await handleChannelHangup(hangupEvent(fsUuid))

        expect(await prisma.message.count({
            where: { externalId: `call:${call.id}`, type: 'call' },
        })).toBe(1)
    })

    it('uses the single existing phone owner without creating a duplicate Contact', async () => {
        const owner = await createContactWithPhone('Known caller', '+79222155750')

        await handleChannelCreate(createEvent('call-owner-1'))
        const call = await prisma.call.findUniqueOrThrow({
            where: { fsUuid: 'call-owner-1' },
        })

        expect(call.contactId).toBe(owner.contact.id)
        expect(await prisma.contact.count()).toBe(1)
    })

    it('leaves two or more phone owners unresolved and creates no Contact', async () => {
        await createContactWithPhone('Owner A', '+79222155750')
        await createContactWithPhone('Owner B', '+79222155750')

        await handleChannelCreate(createEvent('call-owner-ambiguous'))
        const call = await prisma.call.findUniqueOrThrow({
            where: { fsUuid: 'call-owner-ambiguous' },
        })

        expect(call.contactId).toBeNull()
        expect(await prisma.contact.count()).toBe(2)
        expect(opsLogMock).toHaveBeenCalledWith(
            'warn',
            'call_contact_phone_ambiguous',
            expect.objectContaining({ phone: '+79222155750' }),
        )

        await handleChannelHangup(hangupEvent('call-owner-ambiguous'))
        expect(await prisma.message.count({ where: { type: 'call' } })).toBe(0)
    })

    it('deduplicates repeated fsUuid before a second popup or Contact resolution', async () => {
        const fsUuid = 'call-repeated-fs-uuid'

        await handleChannelCreate(createEvent(fsUuid))
        await handleChannelCreate(createEvent(fsUuid))

        expect(await prisma.call.count({ where: { fsUuid } })).toBe(1)
        expect(await prisma.contact.count()).toBe(1)
        expect(
            broadcastCallMock.mock.calls.filter(call => call[0]?.type === 'incoming'),
        ).toHaveLength(1)
    })

    it('coalesces concurrent and repeated timeline synchronization to one Message', async () => {
        const owner = await createContactWithPhone('Timeline caller', '+79222155750')
        const call = await prisma.call.create({
            data: {
                fsUuid: 'call-timeline-repeat',
                direction: 'inbound',
                status: 'missed',
                fromNumber: '+79222155750',
                toNumber: '+73430000000',
                contactId: owner.contact.id,
                endedAt: new Date('2026-07-18T12:05:00.000Z'),
            },
        })

        await Promise.all([
            syncCallToChat(call),
            syncCallToChat(call),
            syncCallToChat(call),
        ])
        await syncCallToChat(call)

        expect(await prisma.chat.count({
            where: { externalChatId: 'phone:+79222155750' },
        })).toBe(1)
        expect(await prisma.message.count({
            where: { externalId: `call:${call.id}` },
        })).toBe(1)
    })

    it('does not resurrect a finalized call when ANSWER arrives after HANGUP', async () => {
        await createContactWithPhone('Out of order caller', '+79222155750')
        const fsUuid = 'call-late-answer'

        await handleChannelCreate(createEvent(fsUuid))
        await handleChannelHangup(hangupEvent(fsUuid))
        const finalized = await prisma.call.findUniqueOrThrow({ where: { fsUuid } })

        await handleChannelAnswer(answerEvent(fsUuid))
        const afterLateAnswer = await prisma.call.findUniqueOrThrow({ where: { fsUuid } })

        expect(afterLateAnswer.status).toBe('missed')
        expect(afterLateAnswer.endedAt?.toISOString())
            .toBe(finalized.endedAt?.toISOString())
        expect(await prisma.message.count({
            where: { externalId: `call:${finalized.id}` },
        })).toBe(1)
    })

    it.each([
        ['missing', ''],
        ['invalid', '401'],
    ])('ignores %s inbound caller phone without creating CRM data', async (_, phone) => {
        await handleChannelCreate(createEvent(`call-${phone || 'missing'}`, phone))

        expect(await prisma.call.count()).toBe(0)
        expect(await prisma.contact.count()).toBe(0)
        expect(await prisma.message.count()).toBe(0)
    })

    it('keeps an archived owner without a merge unresolved and creates no duplicate', async () => {
        await createContactWithPhone('Archived caller', '+79222155750', true)

        await handleChannelCreate(createEvent('call-archived-owner'))
        const call = await prisma.call.findUniqueOrThrow({
            where: { fsUuid: 'call-archived-owner' },
        })

        expect(call.contactId).toBeNull()
        expect(await prisma.contact.count()).toBe(1)
    })

    it('routes a merged phone owner and its existing phone chat to the canonical Contact', async () => {
        const target = await prisma.contact.create({
            data: { displayName: 'Canonical caller' },
        })
        const source = await createContactWithPhone(
            'Merged caller',
            '+79222155750',
            true,
        )
        await prisma.contactMerge.create({
            data: {
                survivorId: target.id,
                mergedId: source.contact.id,
                reason: 'manual',
                mergedBy: 'incoming-call-db-test',
                snapshotBefore: {},
            },
        })
        await prisma.chat.create({
            data: {
                channel: 'phone',
                externalChatId: 'phone:+79222155750',
                contactId: source.contact.id,
                name: '+79222155750',
            },
        })

        const fsUuid = 'call-merged-owner'
        await handleChannelCreate(createEvent(fsUuid))
        await handleChannelHangup(hangupEvent(fsUuid))

        const [call, chat] = await Promise.all([
            prisma.call.findUniqueOrThrow({ where: { fsUuid } }),
            prisma.chat.findUniqueOrThrow({
                where: { externalChatId: 'phone:+79222155750' },
            }),
        ])
        expect(call.contactId).toBe(target.id)
        expect(chat.contactId).toBe(target.id)
        expect(await prisma.contact.count()).toBe(2)
        expect(await prisma.message.count({
            where: { externalId: `call:${call.id}` },
        })).toBe(1)
    })
})
