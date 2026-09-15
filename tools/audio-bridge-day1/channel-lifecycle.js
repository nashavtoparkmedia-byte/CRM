'use strict'
/**
 * Per-channel AI-call gating state machine, driven by FreeSWITCH ESL events.
 *
 * server.js injects every side effect (ESL api, CRM session binding, session
 * lookup, logging, timers), so this module has no dependencies and reads no
 * environment variables.
 *
 * Two independent facts decide what happens to a channel, and they can arrive
 * in either order:
 *
 *   matched  — a dialed-extension header equals one of autoForkExtensions
 *              (Caller-Destination-Number carries it once the channel has been
 *              transferred into the AI extension).
 *   answered — CHANNEL_ANSWER, or any matched event whose Answer-State header is
 *              "answered". FreeSWITCH stamps Answer-State when it creates the
 *              event (switch_channel_event_set_basic_data), so CHANNEL_PARK
 *              carries it too.
 *
 * Why both orders happen for the production originate
 * `originate {...}sofia/gateway/megafon/<number> 9999 XML default`
 * (captured on FreeSWITCH 1.10.12 with loopback callees):
 *
 *   early media  PROGRESS_MEDIA(dest=<callee>) -> transfer to 9999 ->
 *                PARK(dest=9999, Answer-State=early) -> ANSWER(dest=9999, answered)
 *   no early     ANSWER(dest=<callee>, answered) -> transfer to 9999 ->
 *   media        PARK(dest=9999, Answer-State=answered)
 *
 * Originate returns on early media by default, so with early media the channel
 * parks in 9999 while still ringing and the later ANSWER already carries 9999.
 * Without early media, originate returns only on answer: the only CHANNEL_ANSWER
 * is built before the transfer and still names the callee, and the first event
 * that is recognisably ours is the PARK, which is already answered. The previous
 * code started the fork only from a matched CHANNEL_ANSWER, so those calls were
 * never forked (deaf) and the queued greeting never played (mute).
 *
 * The answer actions — mark answered, flush queued playback, start exactly one
 * uuid_audio_fork — run once per channel, on whichever event first establishes
 * both facts.
 *
 * History that still constrains the design (issue #23):
 *   - Speaking on CHANNEL_PARK: Megafon's SBC routes pre-answer audio into the
 *     ringback, so the start of the greeting is lost. Playback stays answer-gated.
 *   - Synthesising only after CHANNEL_ANSWER: 8-12 s of dead air (tested live
 *     2026-05-18). Session binding and greeting synthesis stay on CHANNEL_PARK,
 *     which with early media overlaps the ringing.
 *   - Forking during ringing streams the ringback into STT. The fork stays
 *     answer-gated.
 */

const TRIGGER_EVENTS = new Set(['CHANNEL_PARK', 'CHANNEL_ANSWER', 'CHANNEL_HANGUP_COMPLETE'])
const DEFAULT_DEAD_CHANNEL_TTL_MS = 10 * 60 * 1000
const FORK_MIX_TYPES = new Set(['mono', 'mixed', 'stereo'])
const CHANNEL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseEslEventHeaders(text) {
    const headers = {}
    for (const line of String(text).split('\n')) {
        const idx = line.indexOf(': ')
        if (idx > 0) headers[line.substring(0, idx)] = line.substring(idx + 2)
    }
    return headers
}

/**
 * The exact fork command. mod_audio_fork parses the tokens as
 * uuid, start, url, mix, sampling rate, bug name — the sixth token does not start
 * with "{" or "[", so the module uses it as the media-bug name, not metadata. The
 * sampling rate is always sent. Returns null when the uuid or mix type would be
 * rejected by the module (an invalid mix type gets no reply at all, which would
 * cost a 5 s api timeout and a silently deaf call).
 */
function buildAudioForkCommand(uuid, forkWsUrl, mixType) {
    if (!CHANNEL_UUID_PATTERN.test(String(uuid))) return null
    if (!FORK_MIX_TYPES.has(mixType)) return null
    const meta = `callUuid=${encodeURIComponent(uuid)}`
    return `uuid_audio_fork ${uuid} start ${forkWsUrl}?${meta} ${mixType} 8000 ${meta}`
}

/**
 * Resolves the CallSession for a WebSocket lazily. Binding happens on
 * CHANNEL_PARK and takes two CRM round-trips, while the fork can connect before
 * that finishes (always without early media, and on a fast answer with it). The
 * resolver retries on each frame until it finds a session, then keeps it, so a
 * session that finalized and left the map still receives stop() on close.
 */
function createSessionResolver(callUuid, getSession) {
    let bound = null
    return function currentSession() {
        if (!bound && callUuid) bound = getSession(callUuid) ?? null
        return bound
    }
}

function createChannelLifecycle({
    autoForkExtensions,
    forkWsUrl,
    mixType = 'mono',
    eslApi,
    ensureSession,
    getSession,
    log = console.log,
    logError = console.error,
    deadChannelTtlMs = DEFAULT_DEAD_CHANNEL_TTL_MS,
    setTimer = setTimeout,
}) {
    const answeredChannels = new Set()   // the answered fact has been seen
    const forkedChannels = new Set()     // uuid_audio_fork start issued (exactly-once guard)
    const deadChannels = new Set()       // past CHANNEL_HANGUP_COMPLETE; reaped after the TTL
    const pendingBroadcasts = new Map()  // uuid -> [{ file, durMs, resolve }]

    function flushPendingBroadcasts(uuid) {
        const queued = pendingBroadcasts.get(uuid)
        pendingBroadcasts.delete(uuid)
        if (!queued || queued.length === 0) return
        log(`[esl] ${uuid} answered -> flushing ${queued.length} queued broadcast(s)`)
        // Sequential on purpose: each resolve() anchors CallSession._speak()'s
        // STT mute window to the moment its playback was actually started.
        ;(async () => {
            for (const item of queued) {
                try {
                    const reply = await eslApi(`uuid_broadcast ${uuid} ${item.file} aleg`)
                    log(`[broadcast] ${uuid} (deferred) fs reply: ${String(reply).trim().slice(0, 120)}`)
                } catch (err) {
                    logError(`[broadcast] ${uuid} (deferred) failed: ${err.message}`)
                }
                try { item.resolve(item.durMs) } catch {}
            }
        })()
    }

    function startFork(uuid, ext, via) {
        if (forkedChannels.has(uuid)) return
        // Set synchronously, before the command is sent: a second event for the
        // same channel must never issue a second start (the module's
        // "already attached" check is not atomic across ESL connections).
        forkedChannels.add(uuid)
        const cmd = buildAudioForkCommand(uuid, forkWsUrl, mixType)
        if (!cmd) {
            logError(`[esl] auto-fork REFUSED for ${uuid}: invalid channel uuid or mix type "${mixType}"`)
            return
        }
        log(`[esl] auto-forking audio for ${uuid} (ext ${ext}, mix=${mixType}, via ${via})`)
        let reply
        try { reply = eslApi(cmd) } catch (err) { reply = Promise.reject(err) }
        Promise.resolve(reply)
            .then(out => {
                const text = String(out).trim()
                if (text.startsWith('+OK')) log(`[esl] auto-fork ${uuid}: ${text}`)
                else logError(`[esl] auto-fork REJECTED for ${uuid}: ${text.slice(0, 120)}`)
            })
            .catch(err => logError(`[esl] auto-fork FAILED for ${uuid}: ${err.message}`))
    }

    function onAnswerFact(uuid, ext, via) {
        if (deadChannels.has(uuid)) return
        if (!answeredChannels.has(uuid)) {
            answeredChannels.add(uuid)
            flushPendingBroadcasts(uuid)
        }
        startFork(uuid, ext, via)
    }

    function onHangupComplete(uuid) {
        const queued = pendingBroadcasts.get(uuid)
        if (queued && queued.length) {
            log(`[esl] CHANNEL_HANGUP_COMPLETE ${uuid} -> dropping ${queued.length} unplayed broadcast(s)`)
            // durMs=0 lets an awaiting _speak() fall through its mute-window math.
            for (const item of queued) { try { item.resolve(0) } catch {} }
        }
        pendingBroadcasts.delete(uuid)
        answeredChannels.delete(uuid)
        forkedChannels.delete(uuid)
        if (!deadChannels.has(uuid)) {
            deadChannels.add(uuid)
            const timer = setTimer(() => deadChannels.delete(uuid), deadChannelTtlMs)
            if (timer && typeof timer.unref === 'function') timer.unref()
        }
        // The WS close also stops the session; stop() is idempotent. Stopping here
        // covers calls that were never answered (no fork, so no WS ever opened).
        const session = getSession(uuid)
        if (session) {
            try { session.stop() } catch (err) { logError(`[esl] session stop failed for ${uuid}: ${err.message}`) }
        }
    }

    function handleEvent(headers) {
        const eventName = headers['Event-Name']
        if (!TRIGGER_EVENTS.has(eventName)) return
        const uuid = headers['Unique-ID'] || headers['Channel-Call-UUID']
        if (!uuid) return

        const dialedExts = [
            headers['variable_dialed_extension'],
            headers['variable_originate_called_number'],
            headers['variable_destination_number'],
            headers['Caller-Destination-Number'],
        ].filter(Boolean)
        const matched = autoForkExtensions.find(ext => dialedExts.includes(ext))
        const knownUuid = answeredChannels.has(uuid) || forkedChannels.has(uuid)
            || pendingBroadcasts.has(uuid) || deadChannels.has(uuid) || Boolean(getSession(uuid))
        // Channels that are neither ours nor already tracked never create state.
        if (!matched && !knownUuid) return

        const answerState = headers['Answer-State']
        log(`[esl] ${eventName} uuid=${uuid} dialed=[${dialedExts.join(',')}] matched=${matched ?? 'none'} answerState=${answerState ?? '?'}`)

        if (eventName === 'CHANNEL_HANGUP_COMPLETE') {
            onHangupComplete(uuid)
            return
        }
        if (deadChannels.has(uuid)) {
            // A PARK or ANSWER delivered after hangup must not bind a session or
            // fork a channel that no longer exists.
            log(`[esl] ${eventName} ignored for ${uuid}: channel already hung up`)
            return
        }
        const ext = matched ?? 'known'
        if (eventName === 'CHANNEL_PARK') {
            let bind
            try { bind = ensureSession(uuid, () => deadChannels.has(uuid)) } catch (err) { bind = Promise.reject(err) }
            Promise.resolve(bind).catch(err => logError(`[esl] session bind failed for ${uuid}: ${err.message}`))
            if (answerState === 'answered') onAnswerFact(uuid, ext, 'CHANNEL_PARK')
            return
        }
        // CHANNEL_ANSWER: either matched (built after the transfer) or a channel
        // this lifecycle already tracks.
        onAnswerFact(uuid, ext, 'CHANNEL_ANSWER')
    }

    /**
     * Answer-gated playback. dead: drop (returns null). Not yet answered: queue
     * and resolve with durMs once the answer fact flushes it (or 0 on hangup).
     * Answered: play now and return durMs.
     */
    async function playOrQueue(uuid, file, durMs) {
        if (deadChannels.has(uuid)) {
            log(`[broadcast] ${uuid} dropped — channel already hung up`)
            return null
        }
        if (!answeredChannels.has(uuid)) {
            return new Promise(resolve => {
                const list = pendingBroadcasts.get(uuid) ?? []
                list.push({ file, durMs, resolve })
                pendingBroadcasts.set(uuid, list)
                log(`[broadcast] ${uuid} queued (pre-answer) — queue size: ${list.length}`)
            })
        }
        try {
            const reply = await eslApi(`uuid_broadcast ${uuid} ${file} aleg`)
            log(`[broadcast] ${uuid} fs reply: ${String(reply).trim().slice(0, 120)}`)
        } catch (err) {
            logError(`[broadcast] ${uuid} -> ${file} failed: ${err.message}`)
            return null
        }
        return durMs
    }

    return {
        handleEvent,
        playOrQueue,
        isDead: uuid => deadChannels.has(uuid),
        snapshot: () => ({
            answered: [...answeredChannels],
            forked: [...forkedChannels],
            dead: [...deadChannels],
            pending: [...pendingBroadcasts.keys()],
        }),
    }
}

module.exports = {
    createChannelLifecycle,
    createSessionResolver,
    parseEslEventHeaders,
    buildAudioForkCommand,
    DEFAULT_DEAD_CHANNEL_TTL_MS,
}
