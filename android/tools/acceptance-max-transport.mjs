#!/usr/bin/env node
// Acceptance-only stand-in for the MAX personal transport, and the check that
// reads back what it received.
//
//   serve   Listens on 127.0.0.1 only and answers POST /send-message the way the
//           MAX transport answers a confirmed UI send: success, the echoed
//           provider id, and a ui_send_action delivery proof bound to the exact
//           clientMessageId it was given. It accepts nothing but the expected
//           synthetic target, content and provider id; anything else is refused
//           and recorded. The answer is held for --delay-ms so the sending state
//           is observable on the device. It never contacts anything.
//
//   verify  After the scenarios: exactly one physical send reached this
//           transport, with the expected values, and the CRM persisted exactly
//           one outbound Message for it, carrying the same clientMessageId and
//           the delivered status the proof supports.
//
// It is test support for .github/workflows/android-acceptance-e2e.yml. The CRM
// reaches it only because that workflow points MAX_SCRAPER_URL at it; there is
// no test branch anywhere in the CRM itself.

import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

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

function serve(opts) {
    const port = Number(required(opts, 'port'))
    const expected = {
        target: required(opts, 'target'),
        content: required(opts, 'content'),
        providerAccountId: required(opts, 'provider'),
    }
    const delayMs = Number(opts['delay-ms'] ?? '0')
    const logPath = opts.log
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
            const mismatches = []
            if (!body || typeof body !== 'object') mismatches.push('body')
            else {
                if (body.chatId !== expected.target) mismatches.push('target')
                if (body.message !== expected.content) mismatches.push('content')
                if (body.providerAccountId !== expected.providerAccountId) mismatches.push('providerAccountId')
                if (typeof body.clientMessageId !== 'string' || body.clientMessageId.trim() === '') mismatches.push('clientMessageId')
            }
            const entry = {
                at: new Date().toISOString(),
                method: 'POST',
                path: '/send-message',
                accepted: mismatches.length === 0,
                reason: mismatches.length ? `unexpected ${mismatches.join(', ')}` : null,
                body,
            }
            record(entry)
            if (!entry.accepted) {
                return reply(res, 422, { success: false, error: `ACCEPTANCE_TRANSPORT_REJECTED: ${entry.reason}` })
            }
            setTimeout(() => reply(res, 200, {
                success: true,
                chatId: expected.target,
                externalId: null,
                maxMessageId: null,
                deliveryConfirmed: true,
                deliveryStatus: 'delivered',
                providerAccountId: expected.providerAccountId,
                source: 'acceptance_transport',
                deliveryProof: {
                    kind: 'ui_send_action',
                    clientMessageId: body.clientMessageId,
                    actionConfirmed: true,
                },
            }), delayMs)
        })
    })
    server.listen(port, '127.0.0.1', () => {
        console.log(`acceptance MAX transport listening on 127.0.0.1:${port}`)
    })
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
    const failures = []
    const check = (condition, message) => { if (!condition) failures.push(message) }

    const { requests } = await getJson(`${transport}/__acceptance/requests`)
    const sends = requests.filter((entry) => entry.path === '/send-message')
    const accepted = sends.filter((entry) => entry.accepted)
    check(requests.length === sends.length, `transport saw ${requests.length - sends.length} request(s) on other routes`)
    check(sends.length === 1, `transport saw ${sends.length} physical send(s), expected exactly 1`)
    check(accepted.length === sends.length, `transport refused ${sends.length - accepted.length} send(s): ${sends.filter((e) => !e.accepted).map((e) => e.reason).join('; ')}`)
    const physical = accepted[0]?.body ?? null
    const clientMessageId = physical?.clientMessageId ?? null
    check(physical?.chatId === expected.target, `transport target ${physical?.chatId} != ${expected.target}`)
    check(physical?.message === expected.content, 'transport content differs from the text typed on the device')
    check(physical?.providerAccountId === expected.providerAccountId, 'transport provider id differs')
    check(typeof clientMessageId === 'string' && clientMessageId.length > 0, 'transport received no clientMessageId')

    const history = await getJson(`${crm}/api/messages?chatId=${encodeURIComponent(chat)}`)
    check(Array.isArray(history), 'CRM history read is not a list')
    const outbound = Array.isArray(history) ? history.filter((row) => row.direction === 'outbound') : []
    const matching = outbound.filter((row) => row.content === expected.content)
    check(outbound.length === 1, `CRM persisted ${outbound.length} outbound Message row(s) in ${chat}, expected exactly 1`)
    check(matching.length === 1, `CRM persisted ${matching.length} Message row(s) with the sent text, expected exactly 1`)
    const row = matching[0] ?? null
    const delivery = row?.metadata?.maxDelivery ?? null
    check(row?.clientMessageId === clientMessageId, `persisted clientMessageId ${row?.clientMessageId} != transport ${clientMessageId}`)
    check(row?.channel === 'max', `persisted channel ${row?.channel} != max`)
    check(row?.status === 'delivered', `persisted status ${row?.status}, but the transport returned a confirmed delivery proof`)
    check(delivery?.status === 'delivered' && delivery?.deliveryConfirmed === true, 'persisted MAX delivery metadata does not record the confirmed proof')

    const summary = {
        physical_sends: sends.length,
        accepted_sends: accepted.length,
        client_message_id: clientMessageId,
        persisted_outbound_rows: outbound.length,
        persisted_rows_with_text: matching.length,
        persisted_status: row?.status ?? null,
        persisted_client_message_id_matches: row?.clientMessageId === clientMessageId,
        delivery_confirmed: delivery?.deliveryConfirmed ?? null,
    }
    console.log(JSON.stringify(summary, null, 2))
    console.log(`::notice::send proof: ${sends.length} physical send, ${outbound.length} outbound row, status ${row?.status ?? 'none'}, clientMessageId match ${summary.persisted_client_message_id_matches}`)
    if (failures.length > 0) {
        for (const failure of failures.slice(0, 9)) console.log(`::error::send proof: ${failure}`)
        process.exitCode = 1
        return
    }
    console.log('::notice::send proof: PASS')
}

const [mode, ...rest] = process.argv.slice(2)
const opts = options(rest)
if (mode === 'serve') serve(opts)
else if (mode === 'verify') await verify(opts)
else {
    console.error('usage: acceptance-max-transport.mjs serve|verify --option value ...')
    process.exitCode = 2
}
