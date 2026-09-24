/**
 * M2A2-TG2B ingress proof: nothing reaches the provider-account writer before
 * the reported statement is proven authentic, well formed, fresh and unseen.
 */
import { describe, expect, it, vi } from 'vitest'

import {
    attestTelegramProviderAccountFromBotV1,
    telegramProviderAttestationStatusV1,
} from './telegram-provider-account-attestation'
import {
    canonicalTelegramProviderAttestationV1,
    deriveTelegramProviderAttestationKeyV1,
    signTelegramProviderAttestationV1,
    TelegramAttestationReplayCacheV1,
    MAX_OBSERVATION_AGE_MS,
    MAX_OBSERVATION_FUTURE_SKEW_MS,
} from '../internal/bot-attestation/telegram-bot-attestation-protocol'

const SECRET = 'test-bot-secret'
const INSTANCE = '11111111-1111-4111-8111-111111111111'
const ATTESTATION = '22222222-2222-4222-8222-222222222222'
const NOW = 1790000000000

/** The known answer shared with the tg-bot implementation. */
const KNOWN_CANONICAL = [
    'yoko-telegram-provider-attestation:v1',
    'attest_provider_account',
    '7000',
    'driver-bot-primary',
    INSTANCE,
    '1790000000000',
    ATTESTATION,
].join('\n')
const KNOWN_SIGNATURE = 'RKgV0cfeg_6MEm0JQAYePsDndC7OJpMuig38fswVr-s'

function payload(overrides: Record<string, unknown> = {}) {
    const base = {
        domain: 'yoko-telegram-provider-attestation:v1',
        action: 'attest_provider_account',
        providerUserId: '7000',
        transportRef: 'driver-bot-primary',
        attestingInstanceId: INSTANCE,
        observedAt: NOW,
        attestationId: ATTESTATION,
        ...overrides,
    }
    const signature = signTelegramProviderAttestationV1(
        canonicalTelegramProviderAttestationV1(base as never),
        SECRET,
    )
    return { ...base, signature, ...(overrides.signature !== undefined ? { signature: overrides.signature } : {}) }
}

function deps(overrides: Record<string, unknown> = {}) {
    const record = vi.fn(async () => ({ recorded: true, outcome: 'opened_first_generation' }))
    const emitted: Array<Record<string, unknown>> = []
    return {
        record,
        emitted,
        injected: {
            secret: () => SECRET,
            now: () => NOW,
            record,
            emit: (_event: string, context: Readonly<Record<string, unknown>>) => { emitted.push(context as Record<string, unknown>) },
            replay: new TelegramAttestationReplayCacheV1(),
            ...overrides,
        },
    }
}

const send = async (body: Record<string, unknown>, injected: Record<string, unknown>) =>
    await attestTelegramProviderAccountFromBotV1(
        { action: 'attest_provider_account', payload: body },
        injected as never,
    )

describe('the signed statement', () => {
    it('matches the known answer the bot implementation produces', () => {
        expect(canonicalTelegramProviderAttestationV1({
            providerUserId: '7000',
            transportRef: 'driver-bot-primary',
            attestingInstanceId: INSTANCE,
            observedAt: NOW,
            attestationId: ATTESTATION,
        })).toBe(KNOWN_CANONICAL)
        expect(signTelegramProviderAttestationV1(KNOWN_CANONICAL, SECRET)).toBe(KNOWN_SIGNATURE)
    })

    it('derives the key instead of using the bearer secret directly', () => {
        const key = deriveTelegramProviderAttestationKeyV1(SECRET)
        expect(key).toHaveLength(32)
        expect(key.toString('utf8')).not.toBe(SECRET)
    })
})

describe('a valid attestation', () => {
    it('is accepted and reaches the provider-account writer exactly once', async () => {
        const { record, injected } = deps()
        const result = await send(payload(), injected)
        expect(result.outcome).toBe('attested')
        expect(record).toHaveBeenCalledTimes(1)
        expect(record).toHaveBeenCalledWith({
            transportKind: 'bot_runtime',
            transportRef: 'driver-bot-primary',
            accountKind: 'bot_api',
            providerUserId: '7000',
            attestingInstanceId: INSTANCE,
        })
        expect(telegramProviderAttestationStatusV1(result.outcome)).toBe(200)
    })

    it('reports an unavailable foundation instead of claiming a write', async () => {
        const { injected } = deps({ record: vi.fn(async () => ({ recorded: false, outcome: 'attestation_unavailable' })) })
        const result = await send(payload(), injected)
        expect(result.outcome).toBe('unavailable')
        expect(telegramProviderAttestationStatusV1(result.outcome)).toBe(503)
    })
})

describe('authenticity', () => {
    it('rejects a wrong signature before anything else is decided', async () => {
        const { record, injected } = deps()
        const result = await send(payload({ signature: 'not-a-signature' }), injected)
        expect(result.outcome).toBe('unauthenticated')
        expect(record).not.toHaveBeenCalled()
        expect(telegramProviderAttestationStatusV1(result.outcome)).toBe(401)
    })

    it('rejects a statement signed with another secret', async () => {
        const base = { ...payload() }
        base.signature = signTelegramProviderAttestationV1(canonicalTelegramProviderAttestationV1(base as never), 'other-secret')
        const { record, injected } = deps()
        expect((await send(base, injected)).outcome).toBe('unauthenticated')
        expect(record).not.toHaveBeenCalled()
    })

    it('rejects a payload whose covered field was tampered with after signing', async () => {
        const signed = payload()
        const { record, injected } = deps()
        for (const field of ['providerUserId', 'transportRef', 'attestingInstanceId', 'observedAt', 'attestationId'] as const) {
            const tampered = { ...signed, [field]: field === 'observedAt' ? NOW - 1 : `${signed[field]}x` }
            expect((await send(tampered, injected)).outcome).toBe('unauthenticated')
        }
        expect(record).not.toHaveBeenCalled()
    })

    it('reports unavailable when no shared secret is configured', async () => {
        const { record, injected } = deps({ secret: () => null })
        expect((await send(payload(), injected)).outcome).toBe('unavailable')
        expect(record).not.toHaveBeenCalled()
    })
})

describe('shape and identity', () => {
    it('rejects a malformed or unexpected payload', async () => {
        const { record, injected } = deps()
        const cases: unknown[] = [
            null, 'string', [],
            { ...payload(), extra: 1 },
            { ...payload(), domain: 'other-domain' },
            { ...payload(), action: 'something_else' },
            (() => { const { signature, ...rest } = payload(); return rest })(),
        ]
        for (const candidate of cases) {
            const result = await attestTelegramProviderAccountFromBotV1(
                { action: 'attest_provider_account', payload: candidate }, injected as never,
            )
            expect(result.outcome).toBe('malformed')
        }
        expect(record).not.toHaveBeenCalled()
    })

    it('rejects a request whose action is not the attestation action', async () => {
        const { record, injected } = deps()
        const result = await attestTelegramProviderAccountFromBotV1(
            { action: 'sync_user', payload: payload() }, injected as never,
        )
        expect(result.outcome).toBe('malformed')
        expect(record).not.toHaveBeenCalled()
    })

    it('rejects an invalid provider principal', async () => {
        const { record, injected } = deps()
        for (const providerUserId of ['0', '+7000', 'abc', '70 00', '7000 ']) {
            expect((await send(payload({ providerUserId }), injected)).outcome).toBe('malformed')
        }
        expect(record).not.toHaveBeenCalled()
    })

    it('rejects a missing or oversized transport locator', async () => {
        const { record, injected } = deps()
        expect((await send(payload({ transportRef: '' }), injected)).outcome).toBe('malformed')
        expect((await send(payload({ transportRef: 'x'.repeat(129) }), injected)).outcome).toBe('malformed')
        expect(record).not.toHaveBeenCalled()
    })

    it('rejects a transport locator equal to the provider principal', async () => {
        const { record, injected } = deps()
        const result = await send(payload({ transportRef: '7000' }), injected)
        expect(result.outcome).toBe('malformed')
        expect(record).not.toHaveBeenCalled()
    })

    it('rejects an instance id that is not a UUID', async () => {
        const { record, injected } = deps()
        // An uppercase UUID is not the canonical form the bot mints.
        for (const attestingInstanceId of ['instance-1', '1111', 'AAAAAAAA-1111-4111-8111-111111111111']) {
            expect((await send(payload({ attestingInstanceId }), injected)).outcome).toBe('malformed')
        }
        expect(record).not.toHaveBeenCalled()
    })

    it('rejects an attestation id that is not a UUID', async () => {
        const { record, injected } = deps()
        expect((await send(payload({ attestationId: 'not-a-uuid' }), injected)).outcome).toBe('malformed')
        expect(record).not.toHaveBeenCalled()
    })
})

describe('freshness against the server clock', () => {
    it('accepts an observation exactly at the oldest accepted age', async () => {
        const { injected } = deps()
        const result = await send(payload({ observedAt: NOW - MAX_OBSERVATION_AGE_MS }), injected)
        expect(result.outcome).toBe('attested')
    })

    it('rejects an observation older than the window', async () => {
        const { record, injected } = deps()
        const result = await send(payload({ observedAt: NOW - MAX_OBSERVATION_AGE_MS - 1 }), injected)
        expect(result.outcome).toBe('stale')
        expect(record).not.toHaveBeenCalled()
        expect(telegramProviderAttestationStatusV1(result.outcome)).toBe(400)
    })

    it('accepts an observation exactly at the furthest accepted future skew', async () => {
        const { injected } = deps()
        const result = await send(payload({ observedAt: NOW + MAX_OBSERVATION_FUTURE_SKEW_MS }), injected)
        expect(result.outcome).toBe('attested')
    })

    it('rejects an observation further in the future than the window', async () => {
        const { record, injected } = deps()
        const result = await send(payload({ observedAt: NOW + MAX_OBSERVATION_FUTURE_SKEW_MS + 1 }), injected)
        expect(result.outcome).toBe('stale')
        expect(record).not.toHaveBeenCalled()
    })

    it('uses the server clock, never the reported one', async () => {
        const { injected } = deps({ now: () => NOW + 10 * MAX_OBSERVATION_AGE_MS })
        expect((await send(payload({ observedAt: NOW }), injected)).outcome).toBe('stale')
    })
})

describe('replay', () => {
    it('accepts distinct attestation ids and rejects a repeated one', async () => {
        const { record, injected } = deps()
        expect((await send(payload(), injected)).outcome).toBe('attested')
        const second = await send(payload({ attestationId: '33333333-3333-4333-8333-333333333333' }), injected)
        expect(second.outcome).toBe('attested')
        const replayed = await send(payload(), injected)
        expect(replayed.outcome).toBe('replayed')
        expect(telegramProviderAttestationStatusV1(replayed.outcome)).toBe(409)
        expect(record).toHaveBeenCalledTimes(2)
    })

    it('never lets a replayed statement reach the writer', async () => {
        const { record, injected } = deps()
        await send(payload(), injected)
        record.mockClear()
        await send(payload(), injected)
        expect(record).not.toHaveBeenCalled()
    })

    it('keeps the cache bounded at its maximum', () => {
        const cache = new TelegramAttestationReplayCacheV1(2048, 150_000)
        for (let index = 0; index < 4096; index += 1) {
            expect(cache.admit(`id-${index}`, NOW)).toBe(true)
        }
        expect(cache.size).toBeLessThanOrEqual(2048)
    })

    it('forgets an entry once its retention window has passed', () => {
        const cache = new TelegramAttestationReplayCacheV1(2048, 150_000)
        expect(cache.admit(ATTESTATION, NOW)).toBe(true)
        expect(cache.admit(ATTESTATION, NOW + 149_999)).toBe(false)
        expect(cache.admit(ATTESTATION, NOW + 150_000)).toBe(true)
    })

    it('drops expired entries rather than growing forever', () => {
        const cache = new TelegramAttestationReplayCacheV1(2048, 1_000)
        for (let index = 0; index < 100; index += 1) cache.admit(`id-${index}`, NOW)
        expect(cache.size).toBe(100)
        cache.admit('later', NOW + 2_000)
        expect(cache.size).toBe(1)
    })
})

describe('telemetry', () => {
    it('reports only a bounded outcome, never the principal or the statement', async () => {
        const { emitted, injected } = deps()
        await send(payload(), injected)
        expect(emitted).toHaveLength(1)
        expect(Object.keys(emitted[0]).sort()).toEqual(['channel', 'outcome', 'transportKind'])
        const serialized = JSON.stringify(emitted)
        expect(serialized).not.toContain('7000')
        expect(serialized).not.toContain(SECRET)
        expect(serialized).not.toContain(KNOWN_SIGNATURE)
    })
})
