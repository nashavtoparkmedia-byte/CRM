#!/usr/bin/env node
// Acceptance-only stand-in for Firebase Cloud Messaging HTTP v1 and Google's
// OAuth token endpoint. The CRM's REAL FCM adapter talks to it when (and only
// when) a non-production process sets MOBILE_PUSH_FCM_ENDPOINT_OVERRIDE to this
// loopback address; the CRM refuses that override in production.
//
//   serve --port N --public-key-file PEM [--project ID] [--log FILE]
//
//   POST /token   Accepts only the service-account JWT-bearer grant. The JWT
//                 must be RS256, verify against the per-run public key, carry
//                 the firebase.messaging scope and Google's token endpoint as
//                 its audience, and be current. Answers a short-lived access
//                 token of its own.
//   POST /v1/projects/<project>/messages:send
//                 Requires a Bearer token this stand-in issued. Accepts only
//                 {message:{token, data, android:{priority:'HIGH', ttl}}} with
//                 exactly the five string data keys a CRM push carries and no
//                 `notification` block; anything else is answered the way FCM
//                 answers a malformed request. Records every request.
//
//   POST /__control/script  {"token": T, "outcomes": [...]} queues provider
//                 answers for sends to token T, in order: UNREGISTERED,
//                 SENDER_ID_MISMATCH, INVALID_TOKEN, INVALID_PAYLOAD,
//                 QUOTA_EXCEEDED, UNAVAILABLE. {"oauth": ["REJECT"]} queues
//                 token-endpoint refusals.
//   GET  /__control/requests  Everything received, in order.
//
// It listens on 127.0.0.1 only, holds no credential of any real service and
// contacts nothing. It is test support; nothing in the CRM build or any
// deployment references it.

import { appendFileSync, readFileSync } from 'node:fs'
import { createPublicKey, createVerify, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

const GOOGLE_TOKEN_AUDIENCE = 'https://oauth2.googleapis.com/token'
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const DATA_KEYS = ['channel', 'chatId', 'kind', 'messageId', 'v']
const FCM_ERROR = 'type.googleapis.com/google.firebase.fcm.v1.FcmError'
const BAD_REQUEST = 'type.googleapis.com/google.rpc.BadRequest'

const OUTCOMES = {
    UNREGISTERED: [404, { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND', details: [{ '@type': FCM_ERROR, errorCode: 'UNREGISTERED' }] } }],
    SENDER_ID_MISMATCH: [403, { error: { code: 403, message: 'SenderId mismatch', status: 'PERMISSION_DENIED', details: [{ '@type': FCM_ERROR, errorCode: 'SENDER_ID_MISMATCH' }] } }],
    INVALID_TOKEN: [400, { error: { code: 400, message: 'The registration token is not a valid FCM registration token', status: 'INVALID_ARGUMENT', details: [{ '@type': FCM_ERROR, errorCode: 'INVALID_ARGUMENT' }, { '@type': BAD_REQUEST, fieldViolations: [{ field: 'message.token', description: 'Invalid registration token' }] }] } }],
    INVALID_PAYLOAD: [400, { error: { code: 400, message: 'Invalid value at message.data', status: 'INVALID_ARGUMENT', details: [{ '@type': FCM_ERROR, errorCode: 'INVALID_ARGUMENT' }, { '@type': BAD_REQUEST, fieldViolations: [{ field: 'message.data', description: 'Invalid data payload' }] }] } }],
    QUOTA_EXCEEDED: [429, { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': FCM_ERROR, errorCode: 'QUOTA_EXCEEDED' }] } }],
    UNAVAILABLE: [503, { error: { code: 503, message: 'The service is currently unavailable.', status: 'UNAVAILABLE', details: [{ '@type': FCM_ERROR, errorCode: 'UNAVAILABLE' }] } }],
}

function options(argv) {
    const parsed = {}
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i]
        if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`)
        const value = argv[i + 1]
        if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
        parsed[arg.slice(2)] = value
        i += 1
    }
    return parsed
}

function required(opts, name) {
    const value = opts[name]
    if (typeof value !== 'string' || value === '') throw new Error(`--${name} is required`)
    return value
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0
        const chunks = []
        req.on('data', (chunk) => {
            size += chunk.length
            if (size > 64 * 1024) reject(new Error('body too large'))
            else chunks.push(chunk)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
    })
}

function decodeSegment(segment) {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
}

/** Verify the service-account assertion exactly as the real endpoint would need it to be. */
function verifyAssertion(assertion, publicKey) {
    const parts = typeof assertion === 'string' ? assertion.split('.') : []
    if (parts.length !== 3) return { ok: false, reason: 'assertion_shape' }
    let header
    let claims
    try {
        header = decodeSegment(parts[0])
        claims = decodeSegment(parts[1])
    } catch {
        return { ok: false, reason: 'assertion_encoding' }
    }
    if (header.alg !== 'RS256' || header.typ !== 'JWT') return { ok: false, reason: 'assertion_header' }
    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${parts[0]}.${parts[1]}`)
    if (!verifier.verify(publicKey, Buffer.from(parts[2], 'base64url'))) return { ok: false, reason: 'assertion_signature' }
    const now = Math.floor(Date.now() / 1000)
    if (typeof claims.iss !== 'string' || !claims.iss.includes('@')) return { ok: false, reason: 'assertion_issuer' }
    if (claims.scope !== FCM_SCOPE) return { ok: false, reason: 'assertion_scope' }
    if (claims.aud !== GOOGLE_TOKEN_AUDIENCE) return { ok: false, reason: 'assertion_audience' }
    if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) return { ok: false, reason: 'assertion_times' }
    if (claims.iat > now + 60 || claims.exp <= now || claims.exp - claims.iat > 3600) return { ok: false, reason: 'assertion_times' }
    return { ok: true, claims: { iss: claims.iss, scope: claims.scope, aud: claims.aud, lifetime: claims.exp - claims.iat } }
}

/** The request shape a CRM push must have. Returns a violation string or null. */
function sendViolation(body) {
    const message = body && typeof body === 'object' ? body.message : null
    if (!message || typeof message !== 'object' || Array.isArray(message)) return 'message'
    const keys = Object.keys(message).sort().join(',')
    if (keys !== 'android,data,token') return 'message.keys'
    if (typeof message.token !== 'string' || message.token.length < 20) return 'message.token'
    const data = message.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 'message.data'
    if (Object.keys(data).sort().join(',') !== DATA_KEYS.join(',')) return 'message.data'
    if (!Object.values(data).every((value) => typeof value === 'string')) return 'message.data'
    if (data.v !== '1' || data.kind !== 'chat_message') return 'message.data'
    const android = message.android
    if (!android || android.priority !== 'HIGH' || typeof android.ttl !== 'string' || !/^\d+s$/.test(android.ttl)) return 'message.android'
    if (Object.keys(android).sort().join(',') !== 'priority,ttl') return 'message.android'
    return null
}

function serve(opts) {
    const port = Number(required(opts, 'port'))
    const project = opts.project ?? 'yoko-acceptance'
    const publicKey = createPublicKey(readFileSync(required(opts, 'public-key-file'), 'utf8'))
    const logPath = opts.log
    const requests = []
    const issued = new Set()
    const scripted = new Map()
    const oauthScript = []
    const sendPath = `/v1/projects/${project}/messages:send`

    const record = (entry) => {
        requests.push(entry)
        if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`)
    }
    const reply = (res, status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
    }

    const server = createServer(async (req, res) => {
        try {
            if (req.method === 'GET' && req.url === '/__control/requests') return reply(res, 200, { requests })
            if (req.method === 'POST' && req.url === '/__control/script') {
                const body = JSON.parse(await readBody(req))
                if (typeof body.token === 'string' && Array.isArray(body.outcomes)) {
                    if (!body.outcomes.every((outcome) => Object.hasOwn(OUTCOMES, outcome))) return reply(res, 400, { error: 'unknown outcome' })
                    scripted.set(body.token, [...(scripted.get(body.token) ?? []), ...body.outcomes])
                }
                if (Array.isArray(body.oauth)) oauthScript.push(...body.oauth)
                return reply(res, 200, { ok: true })
            }

            if (req.method === 'POST' && req.url === '/token') {
                const form = new URLSearchParams(await readBody(req))
                if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
                    record({ kind: 'oauth', accepted: false, reason: 'grant_type' })
                    return reply(res, 400, { error: 'unsupported_grant_type' })
                }
                const verified = verifyAssertion(form.get('assertion'), publicKey)
                if (!verified.ok) {
                    record({ kind: 'oauth', accepted: false, reason: verified.reason })
                    return reply(res, 400, { error: 'invalid_grant' })
                }
                if (oauthScript.length > 0) {
                    oauthScript.shift()
                    record({ kind: 'oauth', accepted: false, reason: 'scripted_reject', claims: verified.claims })
                    return reply(res, 400, { error: 'invalid_grant' })
                }
                const accessToken = `standin-${randomBytes(16).toString('hex')}`
                issued.add(accessToken)
                record({ kind: 'oauth', accepted: true, claims: verified.claims })
                return reply(res, 200, { access_token: accessToken, expires_in: 3600, token_type: 'Bearer' })
            }

            if (req.method === 'POST' && req.url === sendPath) {
                const authorization = req.headers.authorization ?? ''
                const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
                if (!issued.has(bearer)) {
                    record({ kind: 'send', accepted: false, reason: 'unauthenticated' })
                    return reply(res, 401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials.' } })
                }
                let body
                try {
                    body = JSON.parse(await readBody(req))
                } catch {
                    record({ kind: 'send', accepted: false, reason: 'json' })
                    return reply(res, ...OUTCOMES.INVALID_PAYLOAD)
                }
                const violation = sendViolation(body)
                if (violation) {
                    record({ kind: 'send', accepted: false, reason: `violation:${violation}` })
                    return reply(res, ...OUTCOMES.INVALID_PAYLOAD)
                }
                const token = body.message.token
                const queue = scripted.get(token) ?? []
                const outcome = queue.shift()
                if (queue.length === 0) scripted.delete(token)
                record({ kind: 'send', accepted: outcome === undefined, outcome: outcome ?? 'DELIVERED', token, data: body.message.data, android: body.message.android })
                if (outcome) return reply(res, ...OUTCOMES[outcome])
                return reply(res, 200, { name: `projects/${project}/messages/${randomBytes(8).toString('hex')}` })
            }

            record({ kind: 'refused', method: req.method, url: req.url })
            return reply(res, 404, { error: 'not found' })
        } catch (error) {
            record({ kind: 'error', message: error instanceof Error ? error.message : 'unknown' })
            return reply(res, 500, { error: 'stand-in failure' })
        }
    })

    // --port 0 binds an ephemeral port; the line below reports the real one.
    server.listen(port, '127.0.0.1', () => {
        process.stdout.write(`fcm stand-in listening on 127.0.0.1:${server.address().port}\n`)
    })
}

const [mode, ...rest] = process.argv.slice(2)
if (mode === 'serve') serve(options(rest))
else {
    process.stderr.write('usage: acceptance-fcm-transport.mjs serve --port N --public-key-file PEM [--project ID] [--log FILE]\n')
    process.exit(2)
}
