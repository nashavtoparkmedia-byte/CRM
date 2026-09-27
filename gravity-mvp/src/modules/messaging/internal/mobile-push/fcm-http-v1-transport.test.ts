// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { classifyFcmSendResponseV1, createFcmHttpV1TransportV1 } from './fcm-http-v1-transport'
import { readFcmTransportConfigV1, type FcmTransportConfigV1, type MobilePushEnvironmentV1 } from './mobile-push-config'

const STAND_IN = path.resolve(__dirname, '../../../../../../android/tools/acceptance-fcm-transport.mjs')
const FCM_ERROR = 'type.googleapis.com/google.firebase.fcm.v1.FcmError'
const BAD_REQUEST = 'type.googleapis.com/google.rpc.BadRequest'
const DATA = { v: '1', kind: 'chat_message', chatId: 'chat_1', messageId: 'msg_1', channel: 'max' }
const TOKEN_A = 'transport-token-A_0123456789:abcdefghijklmnop'
const TOKEN_B = 'transport-token-B_0123456789:abcdefghijklmnop'

const fcmError = (status: string, errorCode?: string, tokenViolation?: boolean) => ({
    error: {
        status,
        details: [
            ...(errorCode ? [{ '@type': FCM_ERROR, errorCode }] : []),
            ...(tokenViolation === undefined ? [] : [{ '@type': BAD_REQUEST, fieldViolations: [{ field: tokenViolation ? 'message.token' : 'message.data' }] }]),
        ],
    },
})

describe('FCM HTTP v1 response mapping', () => {
    it('reports a token bad only when the provider says so about the token', () => {
        expect(classifyFcmSendResponseV1(200, { name: 'x' })).toEqual({ kind: 'delivered' })
        expect(classifyFcmSendResponseV1(404, fcmError('NOT_FOUND', 'UNREGISTERED'))).toEqual({ kind: 'token_unregistered' })
        expect(classifyFcmSendResponseV1(400, fcmError('INVALID_ARGUMENT', 'INVALID_ARGUMENT', true))).toEqual({ kind: 'token_invalid' })
        expect(classifyFcmSendResponseV1(403, fcmError('PERMISSION_DENIED', 'SENDER_ID_MISMATCH'))).toEqual({ kind: 'sender_mismatch' })
    })

    it('never treats a malformed request as a bad token', () => {
        expect(classifyFcmSendResponseV1(400, fcmError('INVALID_ARGUMENT', 'INVALID_ARGUMENT', false))).toEqual({ kind: 'terminal', code: 'INVALID_ARGUMENT' })
        expect(classifyFcmSendResponseV1(400, fcmError('INVALID_ARGUMENT', 'INVALID_ARGUMENT'))).toEqual({ kind: 'terminal', code: 'INVALID_ARGUMENT' })
        expect(classifyFcmSendResponseV1(400, fcmError('INVALID_ARGUMENT'))).toEqual({ kind: 'terminal', code: 'INVALID_ARGUMENT' })
        expect(classifyFcmSendResponseV1(400, null).kind).toBe('terminal')
        expect(classifyFcmSendResponseV1(404, null).kind).toBe('terminal')
    })

    it('retries rate limits, provider failures and authentication trouble', () => {
        expect(classifyFcmSendResponseV1(429, fcmError('RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED'))).toEqual({ kind: 'retryable', code: 'QUOTA_EXCEEDED' })
        expect(classifyFcmSendResponseV1(503, fcmError('UNAVAILABLE', 'UNAVAILABLE')).kind).toBe('retryable')
        expect(classifyFcmSendResponseV1(500, null).kind).toBe('retryable')
        expect(classifyFcmSendResponseV1(401, null)).toEqual({ kind: 'retryable', code: 'AUTH_REJECTED' })
        expect(classifyFcmSendResponseV1(403, fcmError('PERMISSION_DENIED', 'THIRD_PARTY_AUTH_ERROR')).kind).toBe('retryable')
    })
})

describe('FCM configuration', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const complete: MobilePushEnvironmentV1 = {
        MOBILE_PUSH_FCM_PROJECT_ID: 'yoko-acceptance',
        MOBILE_PUSH_FCM_CLIENT_EMAIL: 'push@yoko-acceptance.iam.gserviceaccount.com',
        MOBILE_PUSH_FCM_PRIVATE_KEY: pem.replace(/\n/g, '\\n'),
    }

    it('targets Google by default', () => {
        const read = readFcmTransportConfigV1(complete)
        expect(read.ok && read.config.oauthTokenUrl).toBe('https://oauth2.googleapis.com/token')
        expect(read.ok && read.config.sendUrl).toBe('https://fcm.googleapis.com/v1/projects/yoko-acceptance/messages:send')
        expect(read.ok && read.config.overridden).toBe(false)
    })

    it('names each missing or invalid piece instead of passing', () => {
        expect(readFcmTransportConfigV1({ ...complete, MOBILE_PUSH_FCM_PROJECT_ID: '' })).toEqual({ ok: false, problem: 'missing_project_id' })
        expect(readFcmTransportConfigV1({ ...complete, MOBILE_PUSH_FCM_CLIENT_EMAIL: 'nope' })).toEqual({ ok: false, problem: 'missing_client_email' })
        expect(readFcmTransportConfigV1({ ...complete, MOBILE_PUSH_FCM_PRIVATE_KEY: '' })).toEqual({ ok: false, problem: 'missing_private_key' })
        expect(readFcmTransportConfigV1({ ...complete, MOBILE_PUSH_FCM_PRIVATE_KEY: 'not a key' })).toEqual({ ok: false, problem: 'invalid_private_key' })
    })

    const refused = { ok: false, problem: 'endpoint_override_refused' }

    it('targets Google when no override is set, whether or not the capability is granted', () => {
        // The flag on its own must change nothing. It authorizes an override; it
        // is not itself a request to redirect anything.
        for (const env of [complete, { ...complete, MOBILE_PUSH_FCM_ALLOW_LOOPBACK_OVERRIDE: 'true' }]) {
            const read = readFcmTransportConfigV1(env)
            expect(read.ok && read.config.oauthTokenUrl).toBe('https://oauth2.googleapis.com/token')
            expect(read.ok && read.config.sendUrl).toBe('https://fcm.googleapis.com/v1/projects/yoko-acceptance/messages:send')
            expect(read.ok && read.config.overridden).toBe(false)
        }
        expect(readFcmTransportConfigV1({ ...complete, MOBILE_PUSH_FCM_ENDPOINT_OVERRIDE: '   ' }).ok).toBe(true)
    })

    it('refuses an override that was never authorized by name', () => {
        // The authorization no longer comes from NODE_ENV, which a built server
        // reports as production whatever it is given. It has to be asked for.
        expect(readFcmTransportConfigV1({ ...complete, MOBILE_PUSH_FCM_ENDPOINT_OVERRIDE: 'http://127.0.0.1:3907' }))
            .toEqual(refused)
        for (const flag of ['false', 'TRUE', '1', 'yes', '', 'true-ish']) {
            expect(readFcmTransportConfigV1({
                ...complete,
                MOBILE_PUSH_FCM_ALLOW_LOOPBACK_OVERRIDE: flag,
                MOBILE_PUSH_FCM_ENDPOINT_OVERRIDE: 'http://127.0.0.1:3907',
            }), flag).toEqual(refused)
        }
        // Trimmed, like every other value this file reads.
        expect(readFcmTransportConfigV1({
            ...complete,
            MOBILE_PUSH_FCM_ALLOW_LOOPBACK_OVERRIDE: ' true ',
            MOBILE_PUSH_FCM_ENDPOINT_OVERRIDE: 'http://127.0.0.1:3907',
        }).ok).toBe(true)
    })

    it('accepts a loopback override once the capability is granted', () => {
        const allowed = { ...complete, MOBILE_PUSH_FCM_ALLOW_LOOPBACK_OVERRIDE: 'true' }
        for (const override of ['http://127.0.0.1:3907', 'http://localhost:3907', 'http://[::1]:3907', 'https://127.0.0.1:3907']) {
            const read = readFcmTransportConfigV1({ ...allowed, MOBILE_PUSH_FCM_ENDPOINT_OVERRIDE: override })
            expect(read.ok, override).toBe(true)
            if (!read.ok) continue
            // Both destinations move together, and the JWT audience does not:
            // Google requires its own token endpoint as the assertion audience
            // even when the request never leaves the machine.
            expect(read.config.oauthTokenUrl).toBe(`${override}/token`)
            expect(read.config.sendUrl).toBe(`${override}/v1/projects/yoko-acceptance/messages:send`)
            expect(read.config.oauthAudience).toBe('https://oauth2.googleapis.com/token')
            expect(read.config.overridden).toBe(true)
        }
    })

    it('still refuses everything that is not a bare loopback URL, capability or not', () => {
        const allowed = { ...complete, MOBILE_PUSH_FCM_ALLOW_LOOPBACK_OVERRIDE: 'true' }
        const rejected = [
            'http://10.0.0.5:3907',          // private but not loopback
            'http://169.254.169.254/',       // link-local metadata
            'https://evil.example',          // arbitrary remote host
            'http://[::2]:3907',             // not the IPv6 loopback
            'file:///etc/passwd',            // unsupported scheme
            'ftp://127.0.0.1:21',            // unsupported scheme
            'http://user@127.0.0.1:3907',    // userinfo
            'http://user:pw@127.0.0.1:3907', // userinfo with password
            'http://127.0.0.1:3907/?x=1',    // query
            'http://127.0.0.1:3907/#frag',   // fragment
            'nonsense',                      // not a URL
            '://127.0.0.1',                  // malformed
        ]
        for (const override of rejected) {
            expect(readFcmTransportConfigV1({ ...allowed, MOBILE_PUSH_FCM_ENDPOINT_OVERRIDE: override }), override)
                .toEqual(refused)
        }
    })
})

describe('real FCM adapter against the deterministic stand-in', () => {
    let child: ChildProcess
    let directory: string
    let base: string
    let config: FcmTransportConfigV1

    beforeAll(async () => {
        directory = mkdtempSync(path.join(tmpdir(), 'yoko-fcm-standin-'))
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
        const read = readFcmTransportConfigV1({
            MOBILE_PUSH_FCM_ALLOW_LOOPBACK_OVERRIDE: 'true',
            MOBILE_PUSH_FCM_PROJECT_ID: 'yoko-acceptance',
            MOBILE_PUSH_FCM_CLIENT_EMAIL: 'push@yoko-acceptance.iam.gserviceaccount.com',
            MOBILE_PUSH_FCM_PRIVATE_KEY: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
            MOBILE_PUSH_FCM_ENDPOINT_OVERRIDE: base,
        })
        if (!read.ok) throw new Error(read.problem)
        config = read.config
    })

    afterAll(() => {
        child?.kill()
        rmSync(directory, { recursive: true, force: true })
    })

    const requests = async () => (await (await fetch(`${base}/__control/requests`)).json()).requests as Array<Record<string, unknown>>
    const script = async (body: Record<string, unknown>) => { await fetch(`${base}/__control/script`, { method: 'POST', body: JSON.stringify(body) }) }
    const transport = () => createFcmHttpV1TransportV1(config, { fetch: (...args) => fetch(...args), nowMs: () => Date.now() })

    it('signs a valid service-account assertion and sends the exact data-only message', async () => {
        const before = (await requests()).length
        const sender = transport()
        expect(await sender.send({ token: TOKEN_A, data: DATA })).toEqual({ kind: 'delivered' })
        expect(await sender.send({ token: TOKEN_B, data: DATA })).toEqual({ kind: 'delivered' })
        const seen = (await requests()).slice(before)
        // One OAuth exchange serves both sends: the access token is cached.
        expect(seen.map((entry) => entry.kind)).toEqual(['oauth', 'send', 'send'])
        expect(seen[0]).toMatchObject({
            accepted: true,
            claims: {
                iss: 'push@yoko-acceptance.iam.gserviceaccount.com',
                scope: 'https://www.googleapis.com/auth/firebase.messaging',
                aud: 'https://oauth2.googleapis.com/token',
                lifetime: 3600,
            },
        })
        expect(seen[1]).toMatchObject({ accepted: true, token: TOKEN_A, data: DATA, android: { priority: 'HIGH', ttl: '43200s' } })
        expect(seen[2]).toMatchObject({ accepted: true, token: TOKEN_B })
    })

    it('maps every scripted provider answer through the real response path', async () => {
        const sender = transport()
        await script({ token: TOKEN_A, outcomes: ['UNREGISTERED', 'SENDER_ID_MISMATCH', 'INVALID_TOKEN', 'INVALID_PAYLOAD', 'QUOTA_EXCEEDED', 'UNAVAILABLE'] })
        expect(await sender.send({ token: TOKEN_A, data: DATA })).toEqual({ kind: 'token_unregistered' })
        expect(await sender.send({ token: TOKEN_A, data: DATA })).toEqual({ kind: 'sender_mismatch' })
        expect(await sender.send({ token: TOKEN_A, data: DATA })).toEqual({ kind: 'token_invalid' })
        expect(await sender.send({ token: TOKEN_A, data: DATA })).toEqual({ kind: 'terminal', code: 'INVALID_ARGUMENT' })
        expect(await sender.send({ token: TOKEN_A, data: DATA })).toEqual({ kind: 'retryable', code: 'QUOTA_EXCEEDED' })
        expect(await sender.send({ token: TOKEN_A, data: DATA })).toEqual({ kind: 'retryable', code: 'UNAVAILABLE' })
        expect(await sender.send({ token: TOKEN_A, data: DATA })).toEqual({ kind: 'delivered' })
    })

    it('reports a refused OAuth exchange as retryable, never as delivered', async () => {
        await script({ oauth: ['REJECT'] })
        const sender = transport()
        expect(await sender.send({ token: TOKEN_A, data: DATA })).toEqual({ kind: 'retryable', code: 'OAUTH_REJECTED_400' })
        expect(await sender.send({ token: TOKEN_A, data: DATA })).toEqual({ kind: 'delivered' })
    })

    it('a payload the provider would reject is reported terminal, not a bad token', async () => {
        const sender = transport()
        expect(await sender.send({ token: TOKEN_A, data: { ...DATA, extra: 'x' } })).toEqual({ kind: 'terminal', code: 'INVALID_ARGUMENT' })
        const last = (await requests()).at(-1)
        expect(last).toMatchObject({ kind: 'send', accepted: false, reason: 'violation:message.data' })
    })

    it('treats an unreachable provider as retryable', async () => {
        const unreachable = createFcmHttpV1TransportV1({ ...config, oauthTokenUrl: 'http://127.0.0.1:1/token' }, { fetch: (...args) => fetch(...args), nowMs: () => Date.now() })
        expect(await unreachable.send({ token: TOKEN_A, data: DATA })).toEqual({ kind: 'retryable', code: 'OAUTH_UNREACHABLE' })
    })
})
