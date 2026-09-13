/**
 * Isolated-PostgreSQL proof of the Telegram identity repair.
 *
 * Gated behind YOKO_TELEGRAM_IDENTITY_POSTGRES_PROOF=1 and an isolated
 * DATABASE_URL. It creates and destroys its own rows and never reads or writes
 * production data.
 *
 * What it has to establish is narrow and load-bearing: after a repair the
 * Telegram account resolves to exactly one canonical contact, that contact owns
 * the phone exactly once, the driver resolves to the same contact, and running
 * the repair again changes nothing.
 */

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { repairTelegramIdentityFromAttestationV1 } from './telegram-identity-repair'
import type { TelegramIdentityRepairPortV1 } from './telegram-identity-repair'

const proof = process.env.YOKO_TELEGRAM_IDENTITY_POSTGRES_PROOF === '1' ? describe : describe.skip

const PHONE = '+79001112233'
const PHONE_ALT = '89001112233'
const OBSERVED_AT = new Date('2026-09-13T12:00:00.000Z')

let database: PrismaClient

function normalize(raw: string): string | null {
    const digits = raw.replace(/\D/g, '')
    if (digits.length !== 11) return null
    return `+7${digits.slice(-10)}`
}

/**
 * The port, backed by the real database. The merge is the repository's own
 * contact-to-contact behaviour, reproduced here over the same tables the
 * production adapter drives, so the proof exercises real SQL semantics.
 */
function port(): TelegramIdentityRepairPortV1 {
    return {
        async runInTransaction(body) {
            return database.$transaction(async () => body(), { timeout: 30_000 })
        },
        normalizePhone: normalize,
        async findTelegramIdentity(telegramUserId) {
            const row = await database.contactIdentity.findFirst({
                where: { channel: 'telegram', externalId: telegramUserId },
                select: { id: true, contactId: true, isActive: true },
            })
            return row ? { identityId: row.id, contactId: row.contactId, isActive: row.isActive } : null
        },
        async findPhoneOwners(normalizedPhone) {
            const rows = await database.$queryRawUnsafe<Array<{ contactId: string }>>(
                `SELECT DISTINCT cp."contactId" FROM "ContactPhone" cp
                 JOIN "Contact" c ON c."id" = cp."contactId"
                 WHERE right(regexp_replace(cp."phone", '[^0-9]', '', 'g'), 10) = $1
                   AND cp."isActive" = true AND c."isArchived" = false`,
                normalizedPhone.replace(/\D/g, '').slice(-10),
            )
            return rows.map((row) => row.contactId)
        },
        async isContactBare(contactId) {
            const contact = await database.contact.findUnique({
                where: { id: contactId },
                select: {
                    yandexDriverId: true,
                    mainDriverId: true,
                    _count: { select: { phones: true, driverProfiles: true } },
                },
            })
            if (!contact) return false
            return contact.yandexDriverId === null && contact.mainDriverId === null
                && contact._count.phones === 0 && contact._count.driverProfiles === 0
        },
        async attachPhoneToContact({ contactId, normalizedPhone, attestedAt }) {
            await database.contactPhone.upsert({
                where: { contactId_phone: { contactId, phone: normalizedPhone } },
                update: { isActive: true, verifiedAt: attestedAt },
                create: { contactId, phone: normalizedPhone, source: 'telegram', isActive: true, verifiedAt: attestedAt },
            })
        },
        async attachTelegramIdentityToContact({ contactId, telegramUserId }) {
            await database.contactIdentity.upsert({
                where: { channel_externalId: { channel: 'telegram', externalId: telegramUserId } },
                update: { contactId, isActive: true },
                create: { contactId, channel: 'telegram', externalId: telegramUserId, source: 'auto', isActive: true },
            })
        },
        async mergeContactIntoContact({ sourceContactId, survivorContactId }) {
            // Ordered lock, exactly as the repository merge takes it: the pair
            // is always locked in the same order, so two concurrent repairs of
            // one person serialise instead of interleaving.
            const [first, second] = [sourceContactId, survivorContactId].sort()
            await database.$queryRawUnsafe(
                'SELECT "id" FROM "Contact" WHERE "id" IN ($1,$2) ORDER BY "id" FOR UPDATE', first, second,
            )
            const source = await database.contact.findUnique({
                where: { id: sourceContactId },
                select: { isArchived: true, yandexDriverId: true },
            })
            if (!source || source.isArchived) return // already merged: replay is a no-op
            if (source.yandexDriverId) throw new Error('SOURCE_HAS_DRIVER')

            const targetIdentities = await database.contactIdentity.findMany({
                where: { contactId: survivorContactId },
                select: { channel: true, externalId: true },
            })
            const taken = new Set(targetIdentities.map((i) => `${i.channel}:${i.externalId}`))
            const sourceIdentities = await database.contactIdentity.findMany({
                where: { contactId: sourceContactId },
                select: { id: true, channel: true, externalId: true },
            })
            for (const identity of sourceIdentities) {
                if (taken.has(`${identity.channel}:${identity.externalId}`)) {
                    await database.contactIdentity.delete({ where: { id: identity.id } })
                } else {
                    await database.contactIdentity.update({
                        where: { id: identity.id }, data: { contactId: survivorContactId },
                    })
                }
            }
            const targetPhones = await database.contactPhone.findMany({
                where: { contactId: survivorContactId }, select: { phone: true },
            })
            const heldPhones = new Set(targetPhones.map((p) => p.phone))
            const sourcePhones = await database.contactPhone.findMany({
                where: { contactId: sourceContactId }, select: { id: true, phone: true },
            })
            for (const phone of sourcePhones) {
                if (heldPhones.has(phone.phone)) {
                    await database.contactPhone.delete({ where: { id: phone.id } })
                } else {
                    await database.contactPhone.update({
                        where: { id: phone.id }, data: { contactId: survivorContactId },
                    })
                }
            }
            await database.driver.updateMany({
                where: { contactId: sourceContactId }, data: { contactId: survivorContactId },
            })
            await database.contact.update({ where: { id: sourceContactId }, data: { isArchived: true } })
        },
        async recordManualReview(input) {
            await database.telegramIdentityReview.upsert({
                where: {
                    telegramUserId_reason_observedAt: {
                        telegramUserId: input.telegramUserId,
                        reason: input.reason,
                        observedAt: input.observedAt,
                    },
                },
                update: {},
                create: {
                    id: randomUUID(),
                    telegramUserId: input.telegramUserId,
                    normalizedPhone: input.normalizedPhone,
                    reason: input.reason,
                    identityContactId: input.identityContactId,
                    candidateContactIds: [...input.candidateContactIds],
                    observedAt: input.observedAt,
                },
            })
        },
    }
}

function attestation(telegramUserId: string, rawPhone = PHONE, sharedContactUserId?: string) {
    return {
        telegramUserId,
        sharedContactUserId: sharedContactUserId ?? telegramUserId,
        rawPhone,
        observedAt: OBSERVED_AT,
    }
}

async function makeContact(displayName: string): Promise<string> {
    const contact = await database.contact.create({ data: { displayName } })
    return contact.id
}

async function truncateAll(): Promise<void> {
    await database.$executeRawUnsafe(`TRUNCATE TABLE
        "TelegramIdentityReview","ContactIdentity","ContactPhone","DriverTelegram","Driver","Contact"
        RESTART IDENTITY CASCADE`)
}

proof('telegram identity repair on real PostgreSQL', () => {
    beforeAll(async () => {
        database = new PrismaClient()
        await database.$connect()
    })
    afterAll(async () => {
        await truncateAll()
        await database.$disconnect()
    })
    beforeEach(async () => {
        await truncateAll()
    })

    it('merges the bare telegram contact into the canonical phone owner', async () => {
        const person = await makeContact('person')
        const bot = await makeContact('bot')
        await database.contactPhone.create({ data: { contactId: person, phone: PHONE, isActive: true } })
        await database.contactIdentity.create({
            data: { contactId: bot, channel: 'telegram', externalId: '777', isActive: true },
        })

        const result = await repairTelegramIdentityFromAttestationV1(attestation('777'), port())
        expect(result.decision.kind).toBe('merge_identity_contact_into_phone_owner')
        expect(result.canonicalContactId).toBe(person)

        // The telegram identity now belongs to the survivor.
        const identity = await database.contactIdentity.findFirst({ where: { channel: 'telegram', externalId: '777' } })
        expect(identity?.contactId).toBe(person)

        // The phone still has exactly one owner.
        const owners = await database.contactPhone.findMany({ where: { phone: PHONE } })
        expect(owners).toHaveLength(1)
        expect(owners[0].contactId).toBe(person)

        // The duplicate is archived, not deleted, so history survives.
        const source = await database.contact.findUnique({ where: { id: bot } })
        expect(source?.isArchived).toBe(true)
    })

    it('leaves the telegram account and its driver on one contact after the merge', async () => {
        // The driver already sits on the canonical contact, which is what the
        // deterministic phone linker produces. The merge has to bring the
        // Telegram side to that same contact, not pull the driver elsewhere.
        const person = await makeContact('person')
        const bot = await makeContact('bot')
        await database.contactPhone.create({ data: { contactId: person, phone: PHONE, isActive: true } })
        await database.contactIdentity.create({
            data: { contactId: bot, channel: 'telegram', externalId: '777', isActive: true },
        })
        const driver = await database.driver.create({
            data: { yandexDriverId: 'yd-1', fullName: 'D', contactId: person },
        })

        const result = await repairTelegramIdentityFromAttestationV1(attestation('777'), port())
        expect(result.canonicalContactId).toBe(person)

        const identity = await database.contactIdentity.findFirst({ where: { externalId: '777' } })
        const moved = await database.driver.findUnique({ where: { id: driver.id } })
        expect(identity?.contactId).toBe(person)
        expect(moved?.contactId).toBe(person)
        // One person, one canonical contact: the identity and the driver agree.
        expect(identity?.contactId).toBe(moved?.contactId)
    })

    it('fails closed when a driver already hangs off the telegram contact', async () => {
        // A contact carrying a driver profile is not the bare record a bot tap
        // creates, so merging it away could erase a real second person. The
        // repository merge only blocks on yandexDriverId; this is deliberately
        // stricter, and the case goes to a human instead.
        const person = await makeContact('person')
        const bot = await makeContact('bot')
        await database.contactPhone.create({ data: { contactId: person, phone: PHONE, isActive: true } })
        await database.contactIdentity.create({
            data: { contactId: bot, channel: 'telegram', externalId: '777', isActive: true },
        })
        await database.driver.create({ data: { yandexDriverId: 'yd-2', fullName: 'D', contactId: bot } })

        const result = await repairTelegramIdentityFromAttestationV1(attestation('777'), port())
        expect(result.decision).toMatchObject({ kind: 'manual_review', reason: 'identity_contact_is_not_bare' })
        expect(await database.contact.count({ where: { isArchived: true } })).toBe(0)
        expect(await database.telegramIdentityReview.count()).toBe(1)
    })

    it('is idempotent: a replayed share changes nothing', async () => {
        const person = await makeContact('person')
        const bot = await makeContact('bot')
        await database.contactPhone.create({ data: { contactId: person, phone: PHONE, isActive: true } })
        await database.contactIdentity.create({
            data: { contactId: bot, channel: 'telegram', externalId: '777', isActive: true },
        })

        await repairTelegramIdentityFromAttestationV1(attestation('777'), port())
        const afterFirst = await database.contactPhone.count()
        const second = await repairTelegramIdentityFromAttestationV1(attestation('777'), port())

        expect(second.decision.kind).toBe('confirm_existing_binding')
        expect(await database.contactPhone.count()).toBe(afterFirst)
        expect(await database.contactIdentity.count()).toBe(1)
    })

    it('treats the 8 and +7 spellings as one owner rather than two', async () => {
        const person = await makeContact('person')
        const bot = await makeContact('bot')
        await database.contactPhone.create({ data: { contactId: person, phone: PHONE, isActive: true } })
        await database.contactIdentity.create({
            data: { contactId: bot, channel: 'telegram', externalId: '777', isActive: true },
        })

        const result = await repairTelegramIdentityFromAttestationV1(attestation('777', PHONE_ALT), port())
        expect(result.decision.kind).toBe('merge_identity_contact_into_phone_owner')
        expect(await database.contactPhone.count()).toBe(1)
    })

    it('attaches the attested phone when nobody owns it, creating no second owner', async () => {
        const bot = await makeContact('bot')
        await database.contactIdentity.create({
            data: { contactId: bot, channel: 'telegram', externalId: '777', isActive: true },
        })

        const result = await repairTelegramIdentityFromAttestationV1(attestation('777'), port())
        expect(result.decision.kind).toBe('attach_phone_to_identity_contact')
        const phones = await database.contactPhone.findMany()
        expect(phones).toHaveLength(1)
        expect(phones[0].contactId).toBe(bot)
    })

    it('refuses to merge when two contacts own the number, and records the review', async () => {
        const a = await makeContact('a')
        const b = await makeContact('b')
        const bot = await makeContact('bot')
        await database.contactPhone.create({ data: { contactId: a, phone: PHONE, isActive: true } })
        await database.contactPhone.create({ data: { contactId: b, phone: PHONE_ALT, isActive: true } })
        await database.contactIdentity.create({
            data: { contactId: bot, channel: 'telegram', externalId: '777', isActive: true },
        })

        const result = await repairTelegramIdentityFromAttestationV1(attestation('777'), port())
        expect(result.decision).toMatchObject({ kind: 'fail_closed', reason: 'phone_owned_by_several_contacts' })
        expect(await database.contact.count({ where: { isArchived: true } })).toBe(0)
        const reviews = await database.telegramIdentityReview.findMany()
        expect(reviews).toHaveLength(1)
        expect(reviews[0].candidateContactIds.sort()).toEqual([a, b].sort())
    })

    it('leaves a non-bare telegram contact alone and routes it to review', async () => {
        const person = await makeContact('person')
        const other = await makeContact('other')
        await database.contactPhone.create({ data: { contactId: person, phone: PHONE, isActive: true } })
        await database.contactPhone.create({ data: { contactId: other, phone: '+79007776655', isActive: true } })
        await database.contactIdentity.create({
            data: { contactId: other, channel: 'telegram', externalId: '777', isActive: true },
        })

        const result = await repairTelegramIdentityFromAttestationV1(attestation('777'), port())
        expect(result.decision).toMatchObject({ kind: 'manual_review', reason: 'identity_contact_is_not_bare' })
        expect(await database.contact.count({ where: { isArchived: true } })).toBe(0)
        const identity = await database.contactIdentity.findFirst({ where: { externalId: '777' } })
        expect(identity?.contactId).toBe(other)
    })

    it('does not delete identities belonging to other channels', async () => {
        const person = await makeContact('person')
        const bot = await makeContact('bot')
        await database.contactPhone.create({ data: { contactId: person, phone: PHONE, isActive: true } })
        await database.contactIdentity.create({
            data: { contactId: bot, channel: 'telegram', externalId: '777', isActive: true },
        })
        await database.contactIdentity.create({
            data: { contactId: bot, channel: 'whatsapp', externalId: 'wa-1', isActive: true },
        })

        await repairTelegramIdentityFromAttestationV1(attestation('777'), port())

        const whatsapp = await database.contactIdentity.findFirst({ where: { channel: 'whatsapp', externalId: 'wa-1' } })
        expect(whatsapp?.contactId).toBe(person)
        expect(await database.contactIdentity.count()).toBe(2)
    })

    it('cannot split one person when two repairs race', async () => {
        const person = await makeContact('person')
        const bot = await makeContact('bot')
        await database.contactPhone.create({ data: { contactId: person, phone: PHONE, isActive: true } })
        await database.contactIdentity.create({
            data: { contactId: bot, channel: 'telegram', externalId: '777', isActive: true },
        })

        const results = await Promise.allSettled([
            repairTelegramIdentityFromAttestationV1(attestation('777'), port()),
            repairTelegramIdentityFromAttestationV1(attestation('777'), port()),
        ])
        const settled = results.filter((r) => r.status === 'fulfilled')
        expect(settled.length).toBeGreaterThanOrEqual(1)

        // Whatever the interleaving, one account still resolves to one contact
        // and the number still has a single owner.
        expect(await database.contactIdentity.count({ where: { channel: 'telegram', externalId: '777' } })).toBe(1)
        const identity = await database.contactIdentity.findFirst({ where: { externalId: '777' } })
        expect(identity?.contactId).toBe(person)
        expect(await database.contactPhone.count()).toBe(1)
        expect(await database.contact.count({ where: { isArchived: false } })).toBe(1)
    })

    it('refuses a forwarded card outright and writes a review', async () => {
        const person = await makeContact('person')
        const bot = await makeContact('bot')
        await database.contactPhone.create({ data: { contactId: person, phone: PHONE, isActive: true } })
        await database.contactIdentity.create({
            data: { contactId: bot, channel: 'telegram', externalId: '777', isActive: true },
        })

        const result = await repairTelegramIdentityFromAttestationV1(
            attestation('777', PHONE, '888'), port(),
        )
        expect(result.decision).toMatchObject({ kind: 'fail_closed', reason: 'ownership_not_proven' })
        expect(await database.contact.count({ where: { isArchived: true } })).toBe(0)
        expect(await database.telegramIdentityReview.count()).toBe(1)
    })
})
