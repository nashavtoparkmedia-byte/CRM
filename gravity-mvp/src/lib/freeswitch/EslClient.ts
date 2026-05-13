/**
 * FreeSWITCH ESL (Event Socket Layer) listener.
 *
 * Connects to FreeSWITCH on FS_ESL_HOST:FS_ESL_PORT and subscribes to call
 * lifecycle events. For every event of interest we resolve the involved
 * driver/contact by phone number and upsert a Call row, then broadcast
 * over callStreamBus so the browser updates in real time.
 *
 * Reconnects on disconnect with exponential backoff. Idempotent — multiple
 * CHANNEL_CREATE events for the same Channel-Call-UUID are deduped.
 *
 * Originate (click-to-call) is exposed via originateCall() — Node calls
 * `originate` on the ESL socket which makes FreeSWITCH dial out and bridge
 * to the requested manager extension.
 */

import { Connection } from 'esl'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { opsLog } from '@/lib/opsLog'
import { normalizePhoneE164 } from '@/lib/phoneUtils'
import { broadcastCall } from '@/lib/callStreamBus'
import { getSipExtensionForUser } from '@/lib/sip/extensions'
import { processRecording } from '@/lib/freeswitch/recordingProcessor'

const FS_ESL_HOST = process.env.FS_ESL_HOST ?? '127.0.0.1'
const FS_ESL_PORT = Number(process.env.FS_ESL_PORT ?? 8021)
const FS_ESL_PASSWORD = process.env.ESL_PASSWORD ?? 'ClueCon'

const EVENTS_OF_INTEREST = [
    'CHANNEL_CREATE',
    'CHANNEL_ANSWER',
    'CHANNEL_HANGUP_COMPLETE',
] as const

let connection: Connection | null = null
let reconnectTimer: NodeJS.Timeout | null = null
let reconnectDelay = 2000

export async function startEslListener(): Promise<void> {
    if (connection) return
    connect()
}

function connect(): void {
    opsLog('info', 'esl_connecting', { operation: 'esl', host: FS_ESL_HOST, port: FS_ESL_PORT })

    const conn = new Connection(FS_ESL_HOST, FS_ESL_PORT, FS_ESL_PASSWORD, () => {
        opsLog('info', 'esl_connected', { operation: 'esl' })
        reconnectDelay = 2000
        conn.subscribe(EVENTS_OF_INTEREST.join(' '))
    })

    conn.on('esl::event::CHANNEL_CREATE::*', (evt: any) => {
        handleChannelCreate(evt).catch(err =>
            opsLog('error', 'esl_create_failed', { operation: 'esl', error: err.message })
        )
    })

    conn.on('esl::event::CHANNEL_ANSWER::*', (evt: any) => {
        handleChannelAnswer(evt).catch(err =>
            opsLog('error', 'esl_answer_failed', { operation: 'esl', error: err.message })
        )
    })

    conn.on('esl::event::CHANNEL_HANGUP_COMPLETE::*', (evt: any) => {
        handleChannelHangup(evt).catch(err =>
            opsLog('error', 'esl_hangup_failed', { operation: 'esl', error: err.message })
        )
    })

    conn.on('esl::end', () => {
        opsLog('warn', 'esl_disconnected', { operation: 'esl', retryInMs: reconnectDelay })
        connection = null
        scheduleReconnect()
    })

    conn.on('error', (err: Error) => {
        opsLog('error', 'esl_error', { operation: 'esl', error: err.message })
    })

    connection = conn
}

function scheduleReconnect(): void {
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        reconnectDelay = Math.min(reconnectDelay * 2, 30000)
        connect()
    }, reconnectDelay)
}

function header(evt: any, name: string): string | null {
    if (typeof evt?.getHeader === 'function') {
        const v = evt.getHeader(name)
        return typeof v === 'string' ? v : null
    }
    return null
}

async function handleChannelCreate(evt: any): Promise<void> {
    const fsUuid = header(evt, 'Channel-Call-UUID') || header(evt, 'Unique-ID')
    if (!fsUuid) return

    // Only process originating leg, not the secondary forked legs to extensions
    const direction = header(evt, 'Call-Direction') // "inbound" (from outside) or "outbound" (from extension)
    if (direction !== 'inbound' && direction !== 'outbound') return

    const callerNumber = header(evt, 'Caller-Caller-ID-Number') ?? ''
    const calleeNumber = header(evt, 'Caller-Destination-Number') ?? ''
    const sipCallId = header(evt, 'variable_sip_call_id')

    // Determine who is the "remote" party — we look them up to attach driver/contact
    const remoteNumber = direction === 'inbound' ? callerNumber : calleeNumber
    const localNumber = direction === 'inbound' ? calleeNumber : callerNumber
    const e164 = normalizePhoneE164(remoteNumber)

    let driverId: string | null = null
    let contactId: string | null = null
    let displayName: string | null = null
    if (e164) {
        const phone = await prisma.contactPhone.findFirst({
            where: { phone: e164 },
            include: { contact: { include: { driver: true } } },
        })
        if (phone) {
            contactId = phone.contactId
            displayName = phone.contact.displayName
            driverId = phone.contact.driver?.id ?? null
        }
        if (!driverId) {
            const driver = await prisma.driver.findFirst({
                where: { phone: e164 },
                select: { id: true, fullName: true },
            })
            if (driver) {
                driverId = driver.id
                displayName = displayName ?? driver.fullName
            }
        }
    }

    // For outbound, managerId is set later via originate() variable.
    // For inbound, it's filled on CHANNEL_ANSWER when we know which extension picked up.
    try {
        const call = await prisma.call.upsert({
            where: { fsUuid },
            create: {
                direction: direction as 'inbound' | 'outbound',
                status: 'ringing',
                fromNumber: normalizePhoneE164(callerNumber) ?? callerNumber,
                toNumber: normalizePhoneE164(calleeNumber) ?? calleeNumber,
                driverId,
                contactId,
                fsUuid,
                sipCallId: sipCallId ?? undefined,
                metadata: { remoteNumber: e164, localNumber } as Prisma.JsonObject,
            },
            update: {}, // create-only — repeat events ignored
        })

        opsLog('info', 'call_started', {
            operation: 'call',
            callId: call.id,
            direction,
            from: callerNumber,
            to: calleeNumber,
            contactId,
        })

        broadcastCall({
            type: 'incoming',
            data: {
                callId: call.id,
                fromNumber: call.fromNumber,
                toNumber: call.toNumber,
                driverId,
                contactId,
                displayName,
            },
        })
    } catch (err: any) {
        // P2002 = unique constraint (fsUuid already exists) — dedupe is intentional
        if (err.code === 'P2002') return
        throw err
    }
}

async function handleChannelAnswer(evt: any): Promise<void> {
    const fsUuid = header(evt, 'Channel-Call-UUID') || header(evt, 'Unique-ID')
    if (!fsUuid) return

    const answeringExtension = header(evt, 'Caller-Callee-ID-Number') // the extension that picked up

    const call = await prisma.call.findUnique({ where: { fsUuid } })
    if (!call) return

    const managerId = answeringExtension ? extensionToUserId(answeringExtension) : null

    const updated = await prisma.call.update({
        where: { fsUuid },
        data: {
            status: 'active',
            answeredAt: new Date(),
            managerId: managerId ?? call.managerId,
        },
    })

    broadcastCall({
        type: 'answered',
        data: { callId: updated.id, answeredAt: updated.answeredAt!.toISOString(), managerId: updated.managerId },
    })
}

async function handleChannelHangup(evt: any): Promise<void> {
    const fsUuid = header(evt, 'Channel-Call-UUID') || header(evt, 'Unique-ID')
    if (!fsUuid) return

    const cause = header(evt, 'Hangup-Cause') ?? 'UNKNOWN'
    const billsec = Number(header(evt, 'variable_billsec') ?? '0')
    const recordingFile = header(evt, 'variable_recording_file')

    const status = mapHangupCauseToStatus(cause, billsec)

    const call = await prisma.call.findUnique({ where: { fsUuid } })
    if (!call) return

    const updated = await prisma.call.update({
        where: { fsUuid },
        data: {
            status,
            endedAt: new Date(),
            durationSec: billsec > 0 ? billsec : null,
            hangupCause: cause,
        },
    })

    opsLog('info', 'call_ended', {
        operation: 'call',
        callId: updated.id,
        status,
        durationSec: billsec || undefined,
    })

    broadcastCall({
        type: 'ended',
        data: { callId: updated.id, endedAt: updated.endedAt!.toISOString(), durationSec: updated.durationSec, status },
    })

    // Recording: only worth processing if the call was actually answered
    // (billsec > 0). FreeSWITCH still creates a WAV for unanswered calls
    // but it's just silence.
    if (billsec > 0 && recordingFile) {
        processRecording({ callId: updated.id, fsUuid, recordingFile }).catch(err =>
            opsLog('error', 'recording_processor_threw', { operation: 'recording', callId: updated.id, error: err.message })
        )
    }
}

function mapHangupCauseToStatus(cause: string, billsec: number): 'completed' | 'missed' | 'no_answer' | 'busy' | 'failed' | 'rejected' {
    if (billsec > 0) return 'completed'
    switch (cause) {
        case 'NORMAL_CLEARING':
        case 'NO_ANSWER':
        case 'NO_USER_RESPONSE':
        case 'ORIGINATOR_CANCEL':
            return 'no_answer'
        case 'USER_BUSY':
            return 'busy'
        case 'CALL_REJECTED':
        case 'NORMAL_TEMPORARY_FAILURE':
            return 'rejected'
        default:
            return 'failed'
    }
}

function extensionToUserId(extension: string): string | null {
    // Reverse mapping from sip/extensions.ts — small enough to inline
    if (extension === '101') return 'u1'
    if (extension === '102') return 'u2'
    return null
}

/**
 * Click-to-call: originate a call from a manager's extension to an external
 * number. Returns the channel UUID on success, which equals the Call.fsUuid
 * that will be persisted by the CHANNEL_CREATE handler.
 */
export async function originateCall(args: {
    userId: string
    toNumber: string
}): Promise<{ fsUuid: string }> {
    if (!connection) throw new Error('ESL not connected')

    const ext = getSipExtensionForUser(args.userId)
    if (!ext) throw new Error(`No SIP extension mapped for user ${args.userId}`)

    const normalized = normalizePhoneE164(args.toNumber)
    if (!normalized) throw new Error(`Invalid phone number: ${args.toNumber}`)

    // Strip +; dialplan expects national format (7XXXXXXXXXX)
    const dialNumber = normalized.replace(/^\+/, '')

    // Pre-set the CRM user id as a channel variable so CHANNEL_CREATE handler
    // can attribute the outbound call to the right manager.
    const vars = `[origination_caller_id_number=${ext.extension},origination_caller_id_name='${ext.extension}',crm_user_id=${args.userId}]`
    const cmd = `originate ${vars}user/${ext.extension} ${dialNumber} XML default`

    return new Promise((resolve, reject) => {
        connection!.bgapi(cmd, (res: any) => {
            const body = typeof res?.getBody === 'function' ? res.getBody() : String(res)
            const match = /\+OK\s+([0-9a-f-]+)/i.exec(body)
            if (match) {
                resolve({ fsUuid: match[1] })
            } else {
                reject(new Error(`originate failed: ${body.trim()}`))
            }
        })
    })
}
