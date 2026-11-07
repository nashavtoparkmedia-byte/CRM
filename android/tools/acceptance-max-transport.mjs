#!/usr/bin/env node
// Acceptance-only stand-in for the MAX personal transport, and the check that
// reads back what it received.
//
//   serve   Listens on 127.0.0.1 only and answers POST /send-message the way the
//           MAX scraper answers a send MAX accepted (max-web-scraper
//           textSendHttpAnswer, outcome 'accepted'): success, a real-shaped MAX
//           provider message id, and a provider_ack proof naming that same id -
//           MAX's own op:64 response to the page's request. It accepts nothing
//           but the expected synthetic target, content and provider id;
//           anything else is refused and recorded. The answer is held for
//           --delay-ms so the sending state is observable on the device. It
//           never contacts anything.
//
//   verify  After the scenarios: exactly one physical send reached this
//           transport, with the expected values, and the CRM persisted exactly
//           one outbound Message for it, carrying the same clientMessageId, the
//           provider id the stand answered, and the state the S2 delivery
//           contract derives from a provider_ack: status 'sent' with
//           provider_ack evidence, i.e. provider_accepted. A send is never
//           'delivered' at send time; only a later device receipt could make it
//           so, and MAX produces none, so 'delivered' here would be a false
//           claim and fails the check.
//
// It is test support for .github/workflows/android-acceptance-e2e.yml. The CRM
// reaches it only because that workflow points MAX_SCRAPER_URL at it; there is
// no test branch anywhere in the CRM itself.

import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

/**
 * The provider message id the stand answers with. It has the real MAX shape
 * (d301 + hex), so the CRM's MAX adapter treats it exactly like an id MAX
 * returned for this send, and it is synthetic: no MAX account ever issued it.
 */
export const ACCEPTANCE_PROVIDER_MESSAGE_ID = 'd301a0fe14acce5e06'
/** The sequence number of the page request the answer pretends to correlate with. */
export const ACCEPTANCE_REQUEST_SEQ = 30006

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

/**
 * The scraper's answer for a send MAX accepted, field for field: what
 * max-web-scraper's textSendHttpAnswer returns for outcome 'accepted' with a
 * provider_ack proof. The confirmation fields belong to the wire contract; the
 * CRM's MAX adapter reads them together with the correlated id as provider_ack
 * evidence, never as delivery.
 */
export function acceptedSendAnswer({ target, providerAccountId, providerMessageId = ACCEPTANCE_PROVIDER_MESSAGE_ID, requestSeq = ACCEPTANCE_REQUEST_SEQ }) {
    return {
        success: true,
        chatId: target,
        providerAccountId,
        requestSeq,
        extraRequestFrames: 0,
        externalId: providerMessageId,
        maxMessageId: providerMessageId,
        deliveryConfirmed: true,
        deliveryStatus: 'delivered',
        source: 'op64_response',
        proofKind: 'provider_ack',
        deliveryProof: { kind: 'provider_ack', providerMessageId, requestSeq },
    }
}

/** Why a POST /send-message body is not the one expected synthetic send, or [] when it is. */
export function sendMismatches(body, expected) {
    const mismatches = []
    if (!body || typeof body !== 'object') return ['body']
    if (body.chatId !== expected.target) mismatches.push('target')
    if (body.message !== expected.content) mismatches.push('content')
    if (body.providerAccountId !== expected.providerAccountId) mismatches.push('providerAccountId')
    if (typeof body.clientMessageId !== 'string' || body.clientMessageId.trim() === '') mismatches.push('clientMessageId')
    return mismatches
}

/**
 * Starts the stand-in and resolves once it listens. `port` 0 picks a free one
 * (tests); the workflow passes a fixed port.
 */
export function serve({ port, expected, delayMs = 0, logPath = null, providerMessageId = ACCEPTANCE_PROVIDER_MESSAGE_ID }) {
    const requests = []

    const record = (entry) => {
        requests.push(entry)
        if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`)
    }
    const reply = (res, status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
    }

    const server = createServer((req, res) => {
        let raw = ''
        req.setEncoding('utf8')
        req.on('data', (chunk) => { raw += chunk })
        req.on('end', () => {
            if (req.method === 'GET' && req.url === '/__acceptance/health') return reply(res, 200, { ok: true })
            if (req.method === 'GET' && req.url === '/__acceptance/requests') return reply(res, 200, { requests })
            if (req.method !== 'POST' || req.url !== '/send-message') {
                record({ at: new Date().toISOString(), method: req.method, path: req.url, accepted: false, reason: 'unknown route' })
                return reply(res, 404, { success: false, error: 'ACCEPTANCE_TRANSPORT_UNKNOWN_ROUTE' })
            }

            let body
            try { body = JSON.parse(raw) } catch { body = null }
            const mismatches = sendMismatches(body, expected)
            const accepted = mismatches.length === 0
            const entry = {
                at: new Date().toISOString(),
                method: 'POST',
                path: '/send-message',
                accepted,
                reason: accepted ? null : `unexpected ${mismatches.join(', ')}`,
                body,
                answeredProviderMessageId: accepted ? providerMessageId : null,
            }
            record(entry)
            if (!accepted) {
                return reply(res, 422, { success: false, error: `ACCEPTANCE_TRANSPORT_REJECTED: ${entry.reason}` })
            }
            setTimeout(() => reply(res, 200, acceptedSendAnswer({
                target: expected.target,
                providerAccountId: expected.providerAccountId,
                providerMessageId,
            })), delayMs)
        })
    })
    return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => resolve(server))
    })
}

/**
 * The read-back check, pure: what the transport recorded and what the CRM
 * history returned, against the S2 contract for a provider_ack send.
 */
export function verifyPersistedSend({ requests, history, chat, expected }) {
    const failures = []
    const check = (condition, message) => { if (!condition) failures.push(message) }

    const sends = requests.filter((entry) => entry.path === '/send-message')
    const accepted = sends.filter((entry) => entry.accepted)
    check(requests.length === sends.length, `transport saw ${requests.length - sends.length} request(s) on other routes`)
    check(sends.length === 1, `transport saw ${sends.length} physical send(s), expected exactly 1`)
    check(accepted.length === sends.length, `transport refused ${sends.length - accepted.length} send(s): ${sends.filter((e) => !e.accepted).map((e) => e.reason).join('; ')}`)
    const physical = accepted[0]?.body ?? null
    const clientMessageId = physical?.clientMessageId ?? null
    const providerMessageId = accepted[0]?.answeredProviderMessageId ?? null
    check(physical?.chatId === expected.target, `transport target ${physical?.chatId} != ${expected.target}`)
    check(physical?.message === expected.content, 'transport content differs from the text typed on the device')
    check(physical?.providerAccountId === expected.providerAccountId, 'transport provider id differs')
    check(typeof clientMessageId === 'string' && clientMessageId.length > 0, 'transport received no clientMessageId')
    check(typeof providerMessageId === 'string' && providerMessageId.length > 0, 'transport answered no provider message id')

    check(Array.isArray(history), 'CRM history read is not a list')
    const outbound = Array.isArray(history) ? history.filter((row) => row.direction === 'outbound') : []
    const matching = outbound.filter((row) => row.content === expected.content)
    check(outbound.length === 1, `CRM persisted ${outbound.length} outbound Message row(s) in ${chat}, expected exactly 1`)
    check(matching.length === 1, `CRM persisted ${matching.length} Message row(s) with the sent text, expected exactly 1`)
    const row = matching[0] ?? null
    const evidence = row?.metadata?.delivery ?? null
    const maxDelivery = row?.metadata?.maxDelivery ?? null
    check(row?.clientMessageId === clientMessageId, `persisted clientMessageId ${row?.clientMessageId} != transport ${clientMessageId}`)
    check(row?.channel === 'max', `persisted channel ${row?.channel} != max`)
    // S2: a provider_ack is provider acceptance. The row stays 'sent' and its
    // evidence says provider_ack; 'delivered' or 'read' would claim a receipt
    // nobody produced.
    check(row?.status === 'sent', `persisted status ${row?.status}, expected 'sent' (provider acceptance is never 'delivered' at send time)`)
    check(evidence?.v === 1 && evidence?.evidence === 'provider_ack' && evidence?.source === 'send',
        `persisted delivery evidence ${JSON.stringify(evidence)}, expected provider_ack from the send`)
    check(maxDelivery?.status === 'provider_accepted' && maxDelivery?.deliveryConfirmed === false,
        `persisted MAX delivery metadata ${JSON.stringify(maxDelivery && { status: maxDelivery.status, deliveryConfirmed: maxDelivery.deliveryConfirmed })}, expected provider_accepted and not confirmed`)
    check(row?.externalId === providerMessageId && maxDelivery?.maxMessageId === providerMessageId,
        `persisted provider id ${row?.externalId} != the id the transport answered ${providerMessageId}`)

    const summary = {
        physical_sends: sends.length,
        accepted_sends: accepted.length,
        client_message_id: clientMessageId,
        provider_message_id: providerMessageId,
        persisted_outbound_rows: outbound.length,
        persisted_rows_with_text: matching.length,
        persisted_status: row?.status ?? null,
        persisted_evidence: evidence?.evidence ?? null,
        persisted_max_delivery_status: maxDelivery?.status ?? null,
        persisted_client_message_id_matches: row?.clientMessageId === clientMessageId,
        persisted_provider_id_matches: row?.externalId === providerMessageId,
    }
    return { failures, summary }
}

async function getJson(url) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`)
    return response.json()
}

async function verify(opts) {
    const transport = required(opts, 'transport')
    const crm = required(opts, 'crm')
    const chat = required(opts, 'chat')
    const expected = {
        target: required(opts, 'target'),
        content: required(opts, 'content'),
        providerAccountId: required(opts, 'provider'),
    }
    const { requests } = await getJson(`${transport}/__acceptance/requests`)
    const history = await getJson(`${crm}/api/messages?chatId=${encodeURIComponent(chat)}`)
    const { failures, summary } = verifyPersistedSend({ requests, history, chat, expected })

    console.log(JSON.stringify(summary, null, 2))
    console.log(`::notice::send proof: ${summary.physical_sends} physical send, ${summary.persisted_outbound_rows} outbound row, status ${summary.persisted_status ?? 'none'}, evidence ${summary.persisted_evidence ?? 'none'}, clientMessageId match ${summary.persisted_client_message_id_matches}, provider id match ${summary.persisted_provider_id_matches}`)
    if (failures.length > 0) {
        for (const failure of failures.slice(0, 9)) console.log(`::error::send proof: ${failure}`)
        process.exitCode = 1
        return
    }
    console.log('::notice::send proof: PASS')
}

async function main(argv) {
    const [mode, ...rest] = argv
    if (mode === 'serve') {
        const opts = options(rest)
        const port = Number(required(opts, 'port'))
        await serve({
            port,
            expected: {
                target: required(opts, 'target'),
                content: required(opts, 'content'),
                providerAccountId: required(opts, 'provider'),
            },
            delayMs: Number(opts['delay-ms'] ?? '0'),
            logPath: opts.log ?? null,
        })
        console.log(`acceptance MAX transport listening on 127.0.0.1:${port}`)
    } else if (mode === 'verify') {
        await verify(options(rest))
    } else {
        console.error('usage: acceptance-max-transport.mjs serve|verify --option value ...')
        process.exitCode = 2
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2))
