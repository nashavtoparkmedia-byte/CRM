// @vitest-environment node
/**
 * Mobile Push v1 server chain on real PostgreSQL:
 *
 *   Messaging adapter transaction (Message + intent)
 *   → real outbox engine and store → fan-out → per-device delivery events
 *   → send-time resolution under the snapshotted session binding
 *   → the REAL FCM HTTP v1 adapter → the deterministic loopback stand-in.
 *
 * Only the Next.js cookie store is mocked (for the logout path). Runs only
 * against a disposable database named by MOBILE_PUSH_TEST_DATABASE_URL
 * (DATABASE_URL must name the same database); skipped otherwise. Run the
 * Mobile Push PostgreSQL files with --no-file-parallelism.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const jar = vi.hoisted(() => ({ token: undefined as string | undefined }))
vi.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => (name === 'yoko_mobile_session' && jar.token ? { name, value: jar.token } : undefined),
        set: () => undefined,
    }),
    headers: async () => new Headers(),
}))

import { prisma } from '@/lib/prisma'
import { prismaOutboxStoreV1 } from '@/infrastructure/outbox/prisma-outbox-store'
import { publishOutboxBatchV1 } from '@/infrastructure/outbox/v1'
import {
    INBOUND_MESSAGE_NOTIFICATION_REQUESTED_EVENT_V1,
    MOBILE_PUSH_DELIVERY_REQUESTED_EVENT_V1,
} from '../../../../contracts/messaging/v1'
import { messagingOutboxPublishersV1 } from '../../public/v1/mobile-push-outbox-consumers'
import { legacyPrismaChannelMessagePortV1 } from '../../public/v1/legacy-prisma-channel-message-adapter'
import { legacyPrismaExternalMessagePortV1 } from '../../public/v1/legacy-prisma-external-message-adapter'
import { legacyPrismaReceiveMessagePortV1 } from '../../public/v1/legacy-prisma-receive-message-adapter'
import { registerVerifiedMobilePushDeviceV1 } from '../../../identity-access/application/mobile-push-registration-operations'
import {
    issueMobileSession,
    mobileSessionBindingIdV1,
    verifyMobileSession,
} from '../../../identity-access/public/v1/mobile-session-credentials'
import { clearMobileSessionV1 } from '../../../identity-access/public/v1/mobile-session-auth'

const DATABASE = process.env.MOBILE_PUSH_TEST_DATABASE_URL
const describeWithDatabase = DATABASE ? describe.sequential : describe.skip
const STAND_IN = path.resolve(__dirname, '../../../../../../android/tools/acceptance-fcm-transport.mjs')
const RUN = `mpchain${Date.now().toString(36)}`
const MINUTE = 60_000
const id = (name: string) => `${RUN}_${name}`
const tokenOf = (name: string) => `${RUN}_fcm_${name}_0123456789:ABCDEFGHIJKLMNOP`
const CONTENT = (name: string) => `SECRET-CONTENT-${RUN}-${name}`

let child: ChildProcess
let directory: string
let base: string
const captured: string[] = []
const restoreWriters: Array<() => void> = []

async function standInRequests(): Promise<Array<Record<string, unknown>>> {
    return (await (await fetch(`${base}/__control/requests`)).json()).requests
}
async function sendsFor(tokens: string[]) {
    return (await standInRequests()).filter((entry) => entry.kind === 'send' && tokens.includes(String(entry.token)))
}
async function script(tokenName: string, outcomes: string[]) {
    await fetch(`${base}/__control/script`, { method: 'POST', body: JSON.stringify({ token: tokenOf(tokenName), outcomes }) })
}

async function relayUntilIdle(): Promise<void> {
    for (let round = 0; round < 12; round += 1) {
        const result = await publishOutboxBatchV1({ store: prismaOutboxStoreV1, publishers: messagingOutboxPublishersV1 })
        if (result.claimed === 0) return
    }
}
async function makeRetriesDue(): Promise<void> {
    await prisma.domainOutboxEvent.updateMany({ where: { status: 'retry_wait' }, data: { availableAt: new Date(Date.now() - 1000) } })
}

async function registerDevice(name: string, tokenName = name, nowMs = Date.now()) {
    const sessionToken = issueMobileSession('u1', id(`dev-${name}`), undefined, nowMs)!
    const principal = verifyMobileSession(sessionToken)!
    const result = await registerVerifiedMobilePushDeviceV1({ principal, sessionBindingId: mobileSessionBindingIdV1(sessionToken) }, tokenOf(tokenName))
    if (!result.ok) throw new Error(result.code)
    return { registrationId: result.registrationId, sessionToken }
}

async function chat(name: string, channel: 'telegram' | 'whatsapp' | 'max' | 'avito', chatType = 'private') {
    return prisma.chat.create({ data: { id: id(`chat-${name}`), channel, externalChatId: `${channel}:${id(name)}`, chatType } })
}

async function inbound(chatName: string, name: string, overrides: Partial<{ sentAt: Date, type: string, metadata: unknown, channel: 'telegram' | 'whatsapp' | 'max' }> = {}) {
    return legacyPrismaChannelMessagePortV1.create({
        chatId: id(`chat-${chatName}`),
        direction: 'inbound',
        type: (overrides.type ?? 'text') as 'text',
        content: CONTENT(name),
        externalId: id(`ext-${name}`),
        sentAt: overrides.sentAt ?? new Date(),
        channel: overrides.channel ?? 'telegram',
        metadata: overrides.metadata,
    })
}

const outboxFor = (messageId: string) => prisma.domainOutboxEvent.findMany({ where: { aggregateId: messageId }, orderBy: { eventId: 'asc' } })
const intentsFor = async (messageId: string) => (await outboxFor(messageId)).filter((row) => row.eventType === INBOUND_MESSAGE_NOTIFICATION_REQUESTED_EVENT_V1)
const deliveriesFor = async (messageId: string) => (await outboxFor(messageId)).filter((row) => row.eventType === MOBILE_PUSH_DELIVERY_REQUESTED_EVENT_V1)

describeWithDatabase('Mobile Push v1 server chain (PostgreSQL + FCM stand-in)', () => {
    beforeAll(async () => {
        if (process.env.DATABASE_URL !== DATABASE) throw new Error('DATABASE_URL must equal MOBILE_PUSH_TEST_DATABASE_URL')
        directory = mkdtempSync(path.join(tmpdir(), 'yoko-push-chain-'))
        const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
        const publicKeyFile = path.join(directory, 'public.pem')
        writeFileSync(publicKeyFile, pair.publicKey.export({ type: 'spki', format: 'pem' }))
        child = spawn(process.execPath, [STAND_IN, 'serve', '--port', '0', '--public-key-file', publicKeyFile, '--project', 'yoko-acceptance'], { stdio: ['ignore', 'pipe', 'pipe'] })
        const port = await new Promise<number>((resolve, reject) => {
            child.stdout?.on('data', (chunk: Buffer) => {
                const match = /127\.0\.0\.1:(\d+)/.exec(chunk.toString())
                if (match) resolve(Number(match[1]))
            })
            child.once('exit', (code) => reject(new Error(`stand-in exited ${code}`)))
        })
        base = `http://127.0.0.1:${port}`
        Object.assign(process.env, {
            MOBILE_PUSH_FCM_PROJECT_ID: 'yoko-acceptance',
            MOBILE_PUSH_FCM_CLIENT_EMAIL: 'push@yoko-acceptance.iam.gserviceaccount.com',
            MOBILE_PUSH_FCM_PRIVATE_KEY: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
            MOBILE_PUSH_FCM_ENDPOINT_OVERRIDE: base,
        })
        // Capture everything the process writes, to prove no token leaks into logs.
        for (const stream of [process.stdout, process.stderr]) {
            const original = stream.write.bind(stream)
            stream.write = ((chunk: unknown, ...rest: unknown[]) => {
                captured.push(String(chunk))
                return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
            }) as typeof stream.write
            restoreWriters.push(() => { stream.write = original })
        }
        for (const method of ['log', 'warn', 'error', 'info'] as const) {
            const spy = vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { captured.push(args.map(String).join(' ')) })
            restoreWriters.push(() => spy.mockRestore())
        }
    })

    beforeEach(async () => {
        process.env.MOBILE_PUSH_ENABLED = 'true'
        delete process.env.MOBILE_SESSION_REVOCATION_EPOCH
        // Every earlier row is settled so each test observes only its own deliveries.
        await prisma.domainOutboxEvent.deleteMany({ where: { eventType: { in: [INBOUND_MESSAGE_NOTIFICATION_REQUESTED_EVENT_V1, MOBILE_PUSH_DELIVERY_REQUESTED_EVENT_V1] } } })
        await prisma.mobileDeviceRegistration.deleteMany({})
    })

    afterEach(() => { jar.token = undefined })

    afterAll(async () => {
        for (const restore of restoreWriters.reverse()) restore()
        await prisma.domainOutboxEvent.deleteMany({ where: { eventType: { in: [INBOUND_MESSAGE_NOTIFICATION_REQUESTED_EVENT_V1, MOBILE_PUSH_DELIVERY_REQUESTED_EVENT_V1] } } })
        await prisma.mobileDeviceRegistration.deleteMany({})
        await prisma.chat.deleteMany({ where: { id: { startsWith: RUN } } })
        await prisma.$disconnect()
        child?.kill()
        rmSync(directory, { recursive: true, force: true })
    })

    it('delivers one qualifying inbound message to every eligible device through the real chain', async () => {
        await chat('happy', 'telegram')
        const a = await registerDevice('a')
        const b = await registerDevice('b')
        const revoked = await registerDevice('revoked')
        await prisma.mobileDeviceRegistration.update({ where: { id: revoked.registrationId }, data: { revokedAt: new Date(), revokedReason: 'logout', fcmToken: null } })
        const expired = await registerDevice('expired')
        await prisma.mobileDeviceRegistration.update({ where: { id: expired.registrationId }, data: { sessionExpiresAt: new Date(Date.now() - 1) } })

        const message = await inbound('happy', 'happy')
        expect(await intentsFor(message.id)).toHaveLength(1)
        await relayUntilIdle()

        const deliveries = await deliveriesFor(message.id)
        expect(deliveries.map((row) => row.eventId).sort()).toEqual([
            `${MOBILE_PUSH_DELIVERY_REQUESTED_EVENT_V1}:${message.id}:${a.registrationId}`,
            `${MOBILE_PUSH_DELIVERY_REQUESTED_EVENT_V1}:${message.id}:${b.registrationId}`,
        ].sort())
        expect((await outboxFor(message.id)).every((row) => row.status === 'published')).toBe(true)
        const sends = await sendsFor([tokenOf('a'), tokenOf('b'), tokenOf('revoked'), tokenOf('expired')])
        expect(sends.map((entry) => entry.token).sort()).toEqual([tokenOf('a'), tokenOf('b')].sort())
        for (const send of sends) {
            expect(send.data).toEqual({ v: '1', kind: 'chat_message', chatId: id('chat-happy'), messageId: message.id, channel: 'telegram' })
        }
    })

    it('15. a Message and its intent commit together or not at all', async () => {
        // A fixed probe conversation lets the rollback trigger be fixed SQL.
        const probeChatId = 'mobile_push_rollback_probe_chat'
        await prisma.chat.deleteMany({ where: { id: probeChatId } })
        await prisma.chat.create({ data: { id: probeChatId, channel: 'telegram', externalChatId: `telegram:${probeChatId}`, chatType: 'private' } })
        const write = () => legacyPrismaChannelMessagePortV1.create({
            chatId: probeChatId, direction: 'inbound', type: 'text', content: CONTENT('rollback'),
            externalId: id('ext-rollback'), sentAt: new Date(), channel: 'telegram',
        })
        await prisma.$executeRawUnsafe("CREATE OR REPLACE FUNCTION mobile_push_rollback_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'rollback probe'; END $$")
        await prisma.$executeRawUnsafe("CREATE TRIGGER mobile_push_rollback_probe BEFORE INSERT ON domain_outbox_events FOR EACH ROW WHEN ((NEW.payload -> 'data' ->> 'chatId') = 'mobile_push_rollback_probe_chat') EXECUTE FUNCTION mobile_push_rollback_probe()")
        try {
            await expect(write()).rejects.toThrow()
            expect(await prisma.message.count({ where: { externalId: id('ext-rollback') } })).toBe(0)
        } finally {
            await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS mobile_push_rollback_probe ON domain_outbox_events')
            await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS mobile_push_rollback_probe()')
        }
        // The same write succeeds, with its intent, once the outbox accepts it.
        const message = await write()
        expect(await intentsFor(message.id)).toHaveLength(1)
        await prisma.chat.deleteMany({ where: { id: probeChatId } })
    })

    it('16. the same inbound message observed twice produces one intent and one notification per device', async () => {
        await chat('dup-max', 'max')
        await chat('dup-avito', 'avito')
        await registerDevice('dup')
        await registerDevice('dup2')
        const upsert = () => legacyPrismaExternalMessagePortV1.upsert({
            lookupExternalId: id('ext-dup-max'), chatId: id('chat-dup-max'), direction: 'inbound', type: 'text',
            content: CONTENT('dup-max'), channel: 'max', externalId: id('ext-dup-max'), sentAt: new Date(), metadata: {},
        })
        const first = await upsert()
        const second = await upsert()
        expect(second.id).toBe(first.id)
        expect(await intentsFor(first.id)).toHaveLength(1)

        const receive = () => legacyPrismaReceiveMessagePortV1.receive({
            chatId: id('chat-dup-avito'), content: CONTENT('dup-avito'), sentAt: new Date().toISOString(),
            externalId: id('ext-dup-avito'), channel: 'avito', metadata: { source: 'avito' },
        })
        const received = await receive()
        expect(await receive()).toEqual({ messageId: received.messageId, created: false })
        expect(await intentsFor(received.messageId)).toHaveLength(1)

        await chat('dup-tg', 'telegram')
        const created = await inbound('dup-tg', 'dup-tg')
        await expect(inbound('dup-tg', 'dup-tg')).rejects.toThrow()
        expect(await intentsFor(created.id)).toHaveLength(1)

        await relayUntilIdle()
        await relayUntilIdle()
        for (const device of ['dup', 'dup2']) {
            const sends = await sendsFor([tokenOf(device)])
            expect(sends).toHaveLength(3)
            for (const messageId of [first.id, received.messageId, created.id]) {
                expect(sends.filter((entry) => (entry.data as Record<string, string>).messageId === messageId)).toHaveLength(1)
            }
        }
    })

    it('17/18/19/21. the product recency policy decides intents on the persisted row', async () => {
        await chat('policy', 'max')
        await chat('policy-tg', 'telegram')
        const history = await legacyPrismaExternalMessagePortV1.upsert({
            lookupExternalId: id('ext-history'), chatId: id('chat-policy'), direction: 'inbound', type: 'text',
            content: CONTENT('history'), channel: 'max', externalId: id('ext-history'), sentAt: new Date(), metadata: { source: 'history' },
        })
        const catchup = await legacyPrismaExternalMessagePortV1.upsert({
            lookupExternalId: id('ext-catchup'), chatId: id('chat-policy'), direction: 'inbound', type: 'text',
            content: CONTENT('catchup'), channel: 'max', externalId: id('ext-catchup'), sentAt: new Date(), metadata: { source: 'catchup' },
        })
        const late = await inbound('policy-tg', 'late', { sentAt: new Date(Date.now() - 16 * MINUTE) })
        const recentImport = await inbound('policy-tg', 'recent-import', { sentAt: new Date(Date.now() - 5 * MINUTE), metadata: {} })
        const system = await inbound('policy-tg', 'system', { type: 'system' })
        const call = await inbound('policy-tg', 'call', { type: 'call' })
        const outbound = await legacyPrismaChannelMessagePortV1.create({
            chatId: id('chat-policy-tg'), direction: 'outbound', type: 'text', content: CONTENT('outbound'),
            externalId: id('ext-outbound'), sentAt: new Date(), channel: 'telegram',
        })
        await chat('policy-phone', 'avito')
        const phone = await legacyPrismaReceiveMessagePortV1.receive({
            chatId: id('chat-policy-phone'), content: CONTENT('phone'), sentAt: new Date().toISOString(),
            externalId: id('ext-phone'), channel: 'phone', metadata: {},
        })

        for (const messageId of [history.id, catchup.id, late.id, system.id, call.id, outbound.id, phone.messageId]) {
            expect(await intentsFor(messageId)).toEqual([])
        }
        // Accepted trade-off: a recent import without a replay marker does notify.
        expect(await intentsFor(recentImport.id)).toHaveLength(1)
    })

    it('20. a group chat gets an intent but no deliveries', async () => {
        await chat('group', 'telegram', 'group')
        await registerDevice('group')
        const message = await inbound('group', 'group')
        expect(await intentsFor(message.id)).toHaveLength(1)
        await relayUntilIdle()
        expect(await deliveriesFor(message.id)).toEqual([])
        expect(await sendsFor([tokenOf('group')])).toEqual([])
    })

    it('an epoch bump silences a registration at fan-out', async () => {
        await chat('epoch', 'telegram')
        await registerDevice('epoch')
        process.env.MOBILE_SESSION_REVOCATION_EPOCH = 'bumped'
        const message = await inbound('epoch', 'epoch')
        await relayUntilIdle()
        expect(await deliveriesFor(message.id)).toEqual([])
        expect(await sendsFor([tokenOf('epoch')])).toEqual([])
    })

    it('22. disabled: no intent is written and an existing intent is published as suppressed, with no send', async () => {
        await chat('disabled', 'telegram')
        await registerDevice('disabled')
        const beforeDisable = await inbound('disabled', 'before-disable')
        process.env.MOBILE_PUSH_ENABLED = 'false'
        const whileDisabled = await inbound('disabled', 'while-disabled')
        expect(await intentsFor(whileDisabled.id)).toEqual([])
        await relayUntilIdle()
        expect((await intentsFor(beforeDisable.id))[0].status).toBe('published')
        expect(await deliveriesFor(beforeDisable.id)).toEqual([])
        expect(await sendsFor([tokenOf('disabled')])).toEqual([])
    })

    it('23. enabled with missing provider configuration fails visibly into the bounded dead letter, never a false success', async () => {
        await chat('misconfigured', 'telegram')
        await registerDevice('misconfigured')
        const privateKey = process.env.MOBILE_PUSH_FCM_PRIVATE_KEY
        delete process.env.MOBILE_PUSH_FCM_PRIVATE_KEY
        try {
            const message = await inbound('misconfigured', 'misconfigured')
            await relayUntilIdle()
            let [delivery] = await deliveriesFor(message.id)
            expect(delivery.status).toBe('retry_wait')
            expect(delivery.lastError).toContain('MOBILE_PUSH_TRANSPORT_MISCONFIGURED:missing_private_key')
            for (let attempt = 0; attempt < 6; attempt += 1) {
                await makeRetriesDue()
                await relayUntilIdle()
            }
            ;[delivery] = await deliveriesFor(message.id)
            expect(delivery.status).toBe('dead_letter')
            expect(await sendsFor([tokenOf('misconfigured')])).toEqual([])
            expect(captured.join('\n')).toContain('mobile_push_transport_misconfigured')
        } finally {
            process.env.MOBILE_PUSH_FCM_PRIVATE_KEY = privateKey
        }
    })

    it('12. a token rotation after fan-out delivers once, to the new token', async () => {
        await chat('rotate', 'telegram')
        const device = await registerDevice('rotate', 'rotate-old')
        const message = await inbound('rotate', 'rotate')
        await publishOutboxBatchV1({ store: prismaOutboxStoreV1, publishers: messagingOutboxPublishersV1 }) // fan-out only
        expect(await deliveriesFor(message.id)).toHaveLength(1)
        expect((await deliveriesFor(message.id))[0].status).toBe('pending')

        // The device rotates its token inside the SAME session before the delivery runs.
        const principal = verifyMobileSession(device.sessionToken)!
        const rotated = await registerVerifiedMobilePushDeviceV1({ principal, sessionBindingId: mobileSessionBindingIdV1(device.sessionToken) }, tokenOf('rotate-new'))
        expect(rotated.ok && rotated.registrationId).toBe(device.registrationId)

        await relayUntilIdle()
        expect((await sendsFor([tokenOf('rotate-old'), tokenOf('rotate-new')])).map((entry) => entry.token)).toEqual([tokenOf('rotate-new')])
    })

    it('13. UNREGISTERED on the old token, then a new registration: the retry sends to the new token', async () => {
        await chat('unreg', 'telegram')
        const device = await registerDevice('unreg', 'unreg-1')
        await script('unreg-1', ['UNREGISTERED'])
        const message = await inbound('unreg', 'unreg')
        await relayUntilIdle()
        let [delivery] = await deliveriesFor(message.id)
        expect(delivery.status).toBe('retry_wait')
        expect(delivery.lastError).toContain('MOBILE_PUSH_AWAITING_TOKEN')
        expect(await prisma.mobileDeviceRegistration.findUnique({ where: { id: device.registrationId } })).toMatchObject({ fcmToken: null, revokedAt: null })

        const principal = verifyMobileSession(device.sessionToken)!
        await registerVerifiedMobilePushDeviceV1({ principal, sessionBindingId: mobileSessionBindingIdV1(device.sessionToken) }, tokenOf('unreg-2'))
        await makeRetriesDue()
        await relayUntilIdle()
        ;[delivery] = await deliveriesFor(message.id)
        expect(delivery.status).toBe('published')
        const sends = await sendsFor([tokenOf('unreg-1'), tokenOf('unreg-2')])
        expect(sends.map((entry) => [entry.token, entry.outcome])).toEqual([[tokenOf('unreg-1'), 'UNREGISTERED'], [tokenOf('unreg-2'), 'DELIVERED']])
    })

    it('11. an old delivery pending across logout and re-login is skipped as stale; a new message is delivered', async () => {
        await chat('relogin', 'telegram')
        const first = await registerDevice('relogin', 'relogin', Date.now() - 60_000)
        await script('relogin', ['UNAVAILABLE'])
        const oldMessage = await inbound('relogin', 'relogin-old')
        await relayUntilIdle()
        expect((await deliveriesFor(oldMessage.id))[0].status).toBe('retry_wait')

        jar.token = first.sessionToken
        await clearMobileSessionV1()
        expect(await prisma.mobileDeviceRegistration.findUnique({ where: { id: first.registrationId } })).toMatchObject({ revokedReason: 'logout', fcmToken: null })
        const second = await registerDevice('relogin', 'relogin', Date.now())
        expect(second.registrationId).toBe(first.registrationId)

        await makeRetriesDue()
        await relayUntilIdle()
        expect((await deliveriesFor(oldMessage.id))[0].status).toBe('published')
        // Only the scripted failure reached the provider for the old message.
        expect((await sendsFor([tokenOf('relogin')])).map((entry) => entry.outcome)).toEqual(['UNAVAILABLE'])

        const newMessage = await inbound('relogin', 'relogin-new')
        await relayUntilIdle()
        const sends = await sendsFor([tokenOf('relogin')])
        expect(sends.map((entry) => entry.outcome)).toEqual(['UNAVAILABLE', 'DELIVERED'])
        expect((sends[1].data as Record<string, string>).messageId).toBe(newMessage.id)
    })

    it('24. a malformed-request rejection never retires a working token', async () => {
        await chat('malformed', 'telegram')
        const device = await registerDevice('malformed')
        await script('malformed', ['INVALID_PAYLOAD'])
        const message = await inbound('malformed', 'malformed')
        await relayUntilIdle()
        const [delivery] = await deliveriesFor(message.id)
        expect(delivery.status).toBe('retry_wait')
        expect(delivery.lastError).toContain('MOBILE_PUSH_PROVIDER_REJECTED:INVALID_ARGUMENT')
        expect(await prisma.mobileDeviceRegistration.findUnique({ where: { id: device.registrationId } })).toMatchObject({ fcmToken: tokenOf('malformed'), revokedAt: null })
    })

    it('25. SENDER_ID_MISMATCH revokes exactly that registration and publishes', async () => {
        await chat('mismatch', 'telegram')
        const bad = await registerDevice('mismatch-bad')
        const good = await registerDevice('mismatch-good')
        await script('mismatch-bad', ['SENDER_ID_MISMATCH'])
        const message = await inbound('mismatch', 'mismatch')
        await relayUntilIdle()
        expect((await deliveriesFor(message.id)).every((row) => row.status === 'published')).toBe(true)
        expect(await prisma.mobileDeviceRegistration.findUnique({ where: { id: bad.registrationId } })).toMatchObject({ revokedReason: 'sender_mismatch', fcmToken: null })
        expect(await prisma.mobileDeviceRegistration.findUnique({ where: { id: good.registrationId } })).toMatchObject({ revokedAt: null, fcmToken: tokenOf('mismatch-good') })
    })

    it('26/27. no outbox row, error or log line carries a device token or message content', async () => {
        await chat('leak', 'telegram')
        await registerDevice('leak')
        await script('leak', ['UNREGISTERED'])
        const message = await inbound('leak', 'leak')
        await relayUntilIdle()
        const rows = await prisma.domainOutboxEvent.findMany({ where: { eventType: { in: [INBOUND_MESSAGE_NOTIFICATION_REQUESTED_EVENT_V1, MOBILE_PUSH_DELIVERY_REQUESTED_EVENT_V1] } } })
        expect(rows.length).toBeGreaterThan(0)
        const serialized = JSON.stringify(rows)
        expect(serialized).not.toContain(`${RUN}_fcm_`)
        expect(serialized).not.toContain('SECRET-CONTENT-')
        expect(captured.join('\n')).not.toContain(`${RUN}_fcm_`)
        expect(captured.join('\n')).not.toContain('SECRET-CONTENT-')
        expect(message.content).toBe(CONTENT('leak'))
    })
})
