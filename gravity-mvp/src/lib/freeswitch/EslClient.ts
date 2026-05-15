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

// We use `modesl` (Connection-class API) rather than `esl` (shimaore/esl,
// functional client() API) because our handler code is built around the
// event-emitter pattern. createRequire bypasses Turbopack's CJS-mangling.
import { createRequire } from 'module'
import { randomUUID } from 'crypto'
const _require = createRequire(import.meta.url)
const modesl = _require('modesl') as { Connection: any }
const Connection = modesl.Connection
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

// Next.js dev-mode webpack loads this module separately per route, so
// `let connection` would be a different instance for instrumentation vs.
// /api/calls/originate. Pin shared state to globalThis (same trick prisma
// uses) so both views see the same ESL connection.
declare global {
    // eslint-disable-next-line no-var
    var __eslConnection: any
    // eslint-disable-next-line no-var
    var __eslReconnectTimer: NodeJS.Timeout | null
    // eslint-disable-next-line no-var
    var __eslReconnectDelay: number | undefined
}

function getConnection(): Connection | null {
    return (globalThis as any).__eslConnection ?? null
}
function setConnection(c: Connection | null): void {
    ;(globalThis as any).__eslConnection = c
}

let reconnectDelay = (globalThis as any).__eslReconnectDelay ?? 2000

export async function startEslListener(): Promise<void> {
    if (getConnection()) return
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
        setConnection(null)
        scheduleReconnect()
    })

    conn.on('error', (err: Error) => {
        opsLog('error', 'esl_error', { operation: 'esl', error: err.message })
        // ECONNREFUSED on a TCP connect does NOT fire esl::end — only this
        // error event. Without manually scheduling a retry here, the listener
        // dies silently after the first failed connect during FS restart.
        setConnection(null)
        scheduleReconnect()
    })

    setConnection(conn)
}

function scheduleReconnect(): void {
    if ((globalThis as any).__eslReconnectTimer) return
    ;(globalThis as any).__eslReconnectTimer = setTimeout(() => {
        ;(globalThis as any).__eslReconnectTimer = null
        reconnectDelay = Math.min(reconnectDelay * 2, 30000)
        ;(globalThis as any).__eslReconnectDelay = reconnectDelay
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

/**
 * One FS call produces two legs:
 *   - internal: sofia/internal/<ext>@<domain>   (manager's softphone)
 *   - trunk:    sofia/external/<num>@<host>     (Megafon SIP trunk)
 *              or sofia/gateway/<gw>/<num>      (originate dialstring form)
 *
 * Both legs share Channel-Call-UUID, but they fire CHANNEL_CREATE /
 * CHANNEL_ANSWER / CHANNEL_HANGUP_COMPLETE independently. We treat the
 * trunk leg as the canonical source of truth: its Call-Direction matches
 * the user-perceived call direction, and its caller/destination numbers
 * point at the external party (the "peer"). Processing only the trunk
 * leg's CHANNEL_CREATE keeps the journal at one row per real call.
 */
function isTrunkLeg(evt: any): boolean {
    const name = header(evt, 'Channel-Name') ?? ''
    if (name.startsWith('sofia/internal/')) return false
    if (name.startsWith('sofia/external/')) return true
    if (name.startsWith('sofia/gateway/')) return true
    return false
}

async function handleChannelCreate(evt: any): Promise<void> {
    if (!isTrunkLeg(evt)) return

    const fsUuid = header(evt, 'Channel-Call-UUID')
    if (!fsUuid) return

    // On the trunk leg, Call-Direction matches the user-perceived direction:
    //   inbound  = Megafon → us (peer = Caller-Caller-ID-Number)
    //   outbound = us → Megafon (peer = Caller-Destination-Number)
    const direction = header(evt, 'Call-Direction')
    if (direction !== 'inbound' && direction !== 'outbound') return

    const callerNumber = header(evt, 'Caller-Caller-ID-Number') ?? ''
    const calleeNumber = header(evt, 'Caller-Destination-Number') ?? ''
    const sipCallId = header(evt, 'variable_sip_call_id')
    // originate() stamps the initiating manager onto the trunk leg so we
    // know the owner immediately. For softphone-initiated outbound and
    // inbound calls this stays null until the internal leg's ANSWER tells
    // us which extension picked up.
    const crmUserIdFromVar = header(evt, 'variable_crm_user_id')

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

    // managerId: for originate() click-to-call we have it now from the
    // channel variable; for everything else it's filled on the internal
    // leg's CHANNEL_ANSWER when we learn which extension picked up.
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
                managerId: crmUserIdFromVar ?? undefined,
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
    const fsUuid = header(evt, 'Channel-Call-UUID')
    if (!fsUuid) return

    const call = await prisma.call.findUnique({ where: { fsUuid } })
    if (!call) return

    if (isTrunkLeg(evt)) {
        // Trunk leg answered → the call media path is now end-to-end live.
        // This is the canonical "answered" moment for both inbound (manager
        // picked up, FS sends 200 OK back to Megafon) and outbound (Megafon
        // peer answered) calls.
        const updated = await prisma.call.update({
            where: { fsUuid },
            data: { status: 'active', answeredAt: new Date() },
        })
        broadcastCall({
            type: 'answered',
            data: { callId: updated.id, answeredAt: updated.answeredAt!.toISOString(), managerId: updated.managerId },
        })
        return
    }

    // Internal leg answered — its only purpose here is telling us which
    // manager extension was bridged to. On the internal leg, the dialed
    // extension lives in Caller-Callee-ID-Number (FS → user/<ext>).
    // We don't broadcast 'answered' from this branch — the trunk leg's
    // ANSWER carries the canonical answeredAt timestamp.
    const answeringExtension = header(evt, 'Caller-Callee-ID-Number')
    const managerId = answeringExtension ? extensionToUserId(answeringExtension) : null
    if (!managerId || managerId === call.managerId) return

    await prisma.call.update({
        where: { fsUuid },
        data: { managerId },
    })
}

async function handleChannelHangup(evt: any): Promise<void> {
    const fsUuid = header(evt, 'Channel-Call-UUID')
    if (!fsUuid) return

    const call = await prisma.call.findUnique({ where: { fsUuid } })
    if (!call) return

    const recordingFile = header(evt, 'variable_recording_file')
    const billsec = Number(header(evt, 'variable_billsec') ?? '0')

    if (!isTrunkLeg(evt)) {
        // Internal leg hangup. We don't touch the Call row from here —
        // the trunk leg owns the lifecycle fields. The one thing we may
        // need: in the softphone-initiated outbound dialplan, record_session
        // runs on this leg, so variable_recording_file lives here and is
        // not propagated to the trunk leg. Trigger processing if the trunk
        // leg's hangup didn't already do it (recordingPath still null).
        if (recordingFile && billsec > 0 && !call.recordingPath) {
            processRecording({ callId: call.id, fsUuid, recordingFile }).catch(err =>
                opsLog('error', 'recording_processor_threw', { operation: 'recording', callId: call.id, error: err.message })
            )
        }
        return
    }

    const cause = header(evt, 'Hangup-Cause') ?? 'UNKNOWN'
    const status = mapHangupCauseToStatus(cause, billsec)

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
    const conn = getConnection()
    if (!conn) throw new Error('ESL not connected')

    const ext = getSipExtensionForUser(args.userId)
    if (!ext) throw new Error(`No SIP extension mapped for user ${args.userId}`)

    const normalized = normalizePhoneE164(args.toNumber)
    if (!normalized) throw new Error(`Invalid phone number: ${args.toNumber}`)

    // Strip +; dialplan expects national format (7XXXXXXXXXX)
    const dialNumber = normalized.replace(/^\+/, '')

    // Click-to-call pattern: dial the client through the Megafon trunk FIRST,
    // bridge to the manager's extension only after the client picks up. This
    // means the manager needs microphone permission only on the *incoming*
    // popup (when they click "Принять"), not at click time. Avoids the silent
    // NotAllowedError that hit us when ua.call() probed getUserMedia upfront.
    //
    // A-leg = sofia/gateway/megafon/<dialNumber>  — outbound trunk call
    // B-leg = user/${ext.extension}              — manager's WebRTC/Linphone
    //
    // origination_caller_id_* sets what the *manager* sees on the incoming
    // popup (the client's number). The trunk's outbound caller-id is fixed
    // by the gateway itself (the Megafon DID).
    //
    // Recording: pre-generate the channel UUID on this side so the file path
    // is a literal — FreeSWITCH chokes on ${uuid} inside originate vars
    // ("Invalid data ... contains a variable"), because it tries to expand
    // BEFORE the channel exists. With origination_uuid=<uuid> FS adopts the
    // UUID we give it, so the recording_file we precompute matches the
    // Channel-Call-UUID the ESL handler sees.
    //
    // RECORD_STEREO=true keeps caller / callee on separate stereo channels —
    // crucial for Stage 4 Whisper transcription, which gets much better
    // speaker attribution that way.
    //
    // B-leg auto-answer marker: bridge dialstring uses [var=val]endpoint
    // syntax to set channel vars on the user/<ext> leg only. sip_h_P-...
    // becomes an outbound SIP header on FS's INVITE to the browser. The
    // browser detects it in handleIncomingSession() and skips the
    // Accept/Decline popup — calls session.answer() right away. From the
    // user's POV they clicked "Call" and the call connects, never seeing
    // an "incoming call" popup for their own outbound.
    //
    // Why P- prefix (not X-): FreeSWITCH 1.10.12 internal profile drops
    // unknown X-* headers from outbound INVITEs by default. P-* headers
    // (RFC-style) are passed through unmodified. Renaming back to X- would
    // require extra-pass-headers tweaks in sip_profiles/internal.xml.
    const channelUuid = randomUUID()
    const recPath = `/var/lib/freeswitch/recordings/${channelUuid}.wav`
    const vars = [
        `origination_uuid=${channelUuid}`,
        `origination_caller_id_number=${dialNumber}`,
        `origination_caller_id_name='${dialNumber}'`,
        `crm_user_id=${args.userId}`,
        `ignore_early_media=true`,
        // rtp_secure_media=false overrides vanilla default.xml's global
        // <action set rtp_secure_media=true> which auto-fires whenever the
        // channel has DTLS-SRTP crypto. Without this override, when the
        // b-leg (browser, DTLS-SRTP) auto-answers, FS demands SRTP on the
        // a-leg (Megafon, plain RTP) too — call dies INCOMPATIBLE_DESTINATION
        // right at media setup. With false, FS terminates SRTP on the
        // browser side and bridges plain RTP to Megafon.
        `rtp_secure_media=false`,
        `RECORD_STEREO=true`,
        `recording_follow_transfer=true`,
        `recording_file=${recPath}`,
        `execute_on_answer='record_session ${recPath}'`,
    ].join(',')
    // FLOW: dial Megafon first, bridge to the manager's browser once trunk
    // answers. Reverse order ("user first, bridge megafon") triggers
    // INCOMPATIBLE_DESTINATION on the user-leg INVITE in JsSIP — FS builds
    // its offer from the originate channel-vars (PCMA), and the browser's
    // PeerConnection rejects when there's no opus / crypto fallback. With
    // this order FS handshakes plain RTP+PCMA with the trunk on a-leg, then
    // builds a fresh DTLS-SRTP/PCMA offer for the b-leg → browser, which
    // JsSIP accepts cleanly.
    //
    // The P-CRM-Outbound-Bridge marker on the b-leg INVITE tells
    // SipContext.handleIncomingSession that this is OUR own outbound, so it
    // auto-answers and surfaces as an ActiveCallPopup instead of showing
    // an Accept/Decline incoming popup.
    const blegVars = `sip_h_P-CRM-Outbound-Bridge=true`
    const cmd = `originate {${vars}}sofia/gateway/megafon/${dialNumber} &bridge([${blegVars}]user/${ext.extension})`

    // Fire bgapi and resolve IMMEDIATELY with the channel UUID we pre-generated.
    // The frontend needs that UUID right away so it can later POST /api/calls/cancel
    // to interrupt the originate (uuid_kill) if the manager hangs up the
    // placeholder popup before Megafon picks up. If we awaited the bgapi
    // callback we'd wait until Megafon answers/rejects (3–30 s), so the cancel
    // path would arrive too late or with no UUID to target.
    //
    // The eventual bgapi result still gets logged for diagnostics — failures
    // surface through the normal ESL lifecycle (CHANNEL_HANGUP_COMPLETE →
    // broadcastCall('ended')) so the UI clears even on synchronous bgapi errors.
    conn.bgapi(cmd, (res: any) => {
        const body = typeof res?.getBody === 'function' ? res.getBody() : String(res)
        if (!/\+OK/.test(body)) {
            opsLog('warn', 'originate_bgapi_result_err', { operation: 'call', fsUuid: channelUuid, body: body.trim() })
        }
    })
    return { fsUuid: channelUuid }
}

/**
 * Cancel an in-flight outbound originate before either leg has answered.
 * Used by /api/calls/cancel when the manager hits "Отбой" on the placeholder
 * ActiveCallPopup. FS sends CANCEL to the a-leg (Megafon → stops ringing the
 * callee's phone), the channel hangs up with ORIGINATOR_CANCEL, our regular
 * CHANNEL_HANGUP_COMPLETE handler broadcasts 'ended' and the UI clears.
 *
 * Idempotent: uuid_kill on a non-existent UUID returns -ERR which we ignore.
 */
export async function cancelOriginate(fsUuid: string): Promise<void> {
    const conn = getConnection()
    if (!conn) throw new Error('ESL not connected')
    return new Promise((resolve) => {
        conn.api(`uuid_kill ${fsUuid} ORIGINATOR_CANCEL`, (res: any) => {
            const body = typeof res?.getBody === 'function' ? res.getBody() : String(res)
            opsLog('info', 'originate_cancelled', { operation: 'call', fsUuid, body: body.trim() })
            resolve()
        })
    })
}
