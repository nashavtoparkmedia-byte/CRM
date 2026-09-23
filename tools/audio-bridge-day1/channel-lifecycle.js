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
 * both facts. The CRM session is bound once per channel, on its first PARK.
 *
 * Lost events: a channel parked before answer (early media) is re-checked with
 * FreeSWITCH every preAnswerTimeoutMs (default 90 s) until it is answered or hung
 * up, because an event-socket reconnect can lose either event. FreeSWITCH's own
 * state decides: a channel that no longer exists is released exactly as on
 * hangup (queued playback resolves 0, the session stops and finalizes, later
 * events are ignored); a channel that is already answered gets its answer
 * actions; a channel still ringing keeps waiting, however long the far end rings.
 *
 * Termination: this module also owns ending a channel (see terminate below). It is
 * the only place in the bridge that sends a hangup (the CRM keeps its own, for
 * cancelling an originate), it does so at most once per channel, and it never
 * calls into a CallSession — a session asks for termination, the primitive does
 * not answer back.
 *
 * Duration: it also owns the hard cap on an answered call (DEFAULT_MAX_CALL_DURATION_MS),
 * armed once on the answer fact and cleared with the channel. When it expires the
 * module performs two independent actions — stop the session, then terminate the
 * channel immediately — and an immediate request preempts a kill that is still
 * only scheduled, so a goodbye grace can never hold the cap up.
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
const DEFAULT_PRE_ANSWER_TIMEOUT_MS = 90 * 1000
const FORK_MIX_TYPES = new Set(['mono', 'mixed', 'stereo'])
const CHANNEL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// The only hangup cause this bridge sends. An answered leg is recorded as
// `completed` by the CRM whichever cause arrives (it keys on billsec), while a
// non-standard cause on a leg with no media would be mapped to a failure, so
// there is no reason to invent others here.
const DEFAULT_HANGUP_CAUSE = 'NORMAL_CLEARING'
// A cause is interpolated into an ESL command line; only the documented
// FreeSWITCH cause-token shape may reach it.
const HANGUP_CAUSE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/
// mod_commands' answer when the channel is already gone. It is the ordinary race,
// not a failure: the WS close that follows a lead hangup reaches this module over
// a different socket than the ESL event that marks the channel dead, so a normal
// ending would otherwise report an error every time.
const CHANNEL_ALREADY_GONE = /no such channel/i
// Upper bound for a deferred termination. The grace exists to let a final
// phrase finish playing; a wrong playback estimate must not defer a hangup for
// minutes. This bounds the wait only — it is not a call-duration policy.
const MAX_TERMINATION_GRACE_MS = 30 * 1000
// Hard cap on how long an ANSWERED AI call may physically exist. Owner decision:
// ten minutes, one cap for inbound and outbound alike, measured from the answer
// fact, cut immediately with no warning phrase. It is a safety and cost limit,
// not a provider failure, and deliberately not configurable through the
// environment — the number is a product decision, so it lives in the source that
// implements it. A scenario's advisory targetDurationSec is never used for this.
const DEFAULT_MAX_CALL_DURATION_MS = 10 * 60 * 1000

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
    onForkFailure = () => {},
    onTerminationEvent = () => {},
    deadChannelTtlMs = DEFAULT_DEAD_CHANNEL_TTL_MS,
    preAnswerTimeoutMs = DEFAULT_PRE_ANSWER_TIMEOUT_MS,
    maxCallDurationMs = DEFAULT_MAX_CALL_DURATION_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
}) {
    // A misconfigured mix type would make every call deaf; refuse to start instead.
    if (!FORK_MIX_TYPES.has(mixType)) {
        throw new Error(`invalid audio fork mix type "${mixType}" (expected mono, mixed or stereo)`)
    }
    // Same reasoning for the cap: a bad value here would silently remove the only
    // bound on how long a call can exist, which is worse than not starting.
    if (!(Number.isFinite(maxCallDurationMs) && maxCallDurationMs > 0)) {
        throw new Error(`invalid max call duration "${maxCallDurationMs}" (expected a positive number of ms)`)
    }
    const answeredChannels = new Set()   // the answered fact has been seen
    const forkedChannels = new Set()     // uuid_audio_fork start issued (exactly-once guard)
    const boundChannels = new Set()      // CRM session bind requested (once per channel)
    const deadChannels = new Set()       // past CHANNEL_HANGUP_COMPLETE; reaped after the TTL
    const pendingBroadcasts = new Map()  // uuid -> [{ file, durMs, resolve }]
    const preAnswerTimers = new Map()    // uuid -> timer armed by a pre-answer PARK
    const terminatingChannels = new Set()  // terminate() accepted; a termination episode is open
    const killedChannels = new Set()       // the hangup command has been sent (at-most-once guard)
    const terminationTimers = new Map()    // uuid -> { timer, requested } for a deferred terminate()
    const terminationMarkTimers = new Map()  // uuid -> TTL that expires a stale terminating mark
    const maxDurationTimers = new Map()    // uuid -> hard-cap timer armed on the answer fact

    function clearPreAnswerTimer(uuid) {
        const timer = preAnswerTimers.get(uuid)
        if (timer === undefined) return
        preAnswerTimers.delete(uuid)
        try { clearTimer(timer) } catch {}
    }

    function armPreAnswerTimer(uuid) {
        if (preAnswerTimers.has(uuid) || answeredChannels.has(uuid) || deadChannels.has(uuid)) return
        const timer = setTimer(() => {
            preAnswerTimers.delete(uuid)
            if (answeredChannels.has(uuid) || deadChannels.has(uuid)) return
            reconcileUnansweredChannel(uuid)
        }, preAnswerTimeoutMs)
        if (timer && typeof timer.unref === 'function') timer.unref()
        preAnswerTimers.set(uuid, timer)
    }

    // No CHANNEL_ANSWER or CHANNEL_HANGUP_COMPLETE within preAnswerTimeoutMs of a
    // pre-answer PARK: ask FreeSWITCH instead of guessing.
    function reconcileUnansweredChannel(uuid) {
        if (!CHANNEL_UUID_PATTERN.test(String(uuid))) {
            logError(`[esl] ${uuid} is not a channel uuid FreeSWITCH can be asked about -> releasing`)
            releaseChannel(uuid, 'unverifiable channel')
            return
        }
        let reply
        try { reply = eslApi(`uuid_dump ${uuid}`) } catch (err) { reply = Promise.reject(err) }
        Promise.resolve(reply)
            .then(out => {
                if (answeredChannels.has(uuid) || deadChannels.has(uuid)) return
                const text = String(out)
                const answerState = parseEslEventHeaders(text)['Answer-State']
                if (answerState === 'answered') {
                    logError(`[esl] ${uuid} is answered but its CHANNEL_ANSWER was not delivered -> running answer actions`)
                    onAnswerFact(uuid, 'known', 'uuid_dump')
                    return
                }
                if (answerState) {
                    log(`[esl] ${uuid} still ${answerState} ${preAnswerTimeoutMs} ms after CHANNEL_PARK -> waiting`)
                    armPreAnswerTimer(uuid)
                    return
                }
                if (text.trim().startsWith('-ERR')) {
                    logError(`[esl] ${uuid} no longer exists and its CHANNEL_HANGUP_COMPLETE was not delivered -> releasing`)
                    releaseChannel(uuid, 'channel gone')
                    return
                }
                logError(`[esl] ${uuid} unreadable uuid_dump reply -> waiting`)
                armPreAnswerTimer(uuid)
            })
            .catch(err => {
                logError(`[esl] ${uuid} answer-state check failed: ${err.message} -> waiting`)
                armPreAnswerTimer(uuid)
            })
    }

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
            logError(`[esl] auto-fork REFUSED for ${uuid}: invalid channel uuid`)
            notifyForkFailure(uuid, 'refused')
            return
        }
        log(`[esl] auto-forking audio for ${uuid} (ext ${ext}, mix=${mixType}, via ${via})`)
        let reply
        try { reply = eslApi(cmd) } catch (err) { reply = Promise.reject(err) }
        Promise.resolve(reply)
            .then(out => {
                const text = String(out).trim()
                if (text.startsWith('+OK')) {
                    log(`[esl] auto-fork ${uuid}: ${text}`)
                    return
                }
                logError(`[esl] auto-fork REJECTED for ${uuid}: ${text.slice(0, 120)}`)
                notifyForkFailure(uuid, 'rejected')
            })
            .catch(err => {
                logError(`[esl] auto-fork FAILED for ${uuid}: ${err.message}`)
                notifyForkFailure(uuid, 'failed')
            })
    }

    function notifyForkFailure(uuid, reason) {
        try { onForkFailure(uuid, reason) } catch (err) { logError(`[esl] fork failure hook threw for ${uuid}: ${err.message}`) }
    }

    // Six bounded event kinds — armed, requested, escalated, issued, suppressed,
    // failed — and never a value that could carry a secret: the channel uuid, the
    // caller's reason, the cause, the grace, the cap and at most a truncated
    // FreeSWITCH reply.
    function emitTermination(kind, uuid, detail) {
        try { onTerminationEvent(kind, { callUuid: uuid, ...detail }) } catch (err) {
            logError(`[esl] termination hook threw for ${uuid}: ${err.message}`)
        }
    }

    function clearTerminationTimers(uuid) {
        const pending = terminationTimers.get(uuid)
        if (pending !== undefined) {
            terminationTimers.delete(uuid)
            try { clearTimer(pending.timer) } catch {}
        }
        const mark = terminationMarkTimers.get(uuid)
        if (mark !== undefined) {
            terminationMarkTimers.delete(uuid)
            try { clearTimer(mark) } catch {}
        }
    }

    function clearMaxDurationTimer(uuid) {
        const timer = maxDurationTimers.get(uuid)
        if (timer === undefined) return
        maxDurationTimers.delete(uuid)
        try { clearTimer(timer) } catch {}
    }

    /**
     * The hard cap, armed once on the first answer fact this module accepts.
     *
     * It is a backstop, not the normal way a call ends: everything else — the
     * bot's own end_call, the silence strikes, the lead hanging up — should get
     * there first. It exists for the cases nothing else covers: a hung dialog, a
     * lost end_call, an LLM or STT that never returns, and a channel that never
     * bound a CallSession at all (the CRM lookup can 404), which is why it lives
     * here with the channel state rather than in the session.
     *
     * A channel whose CHANNEL_ANSWER was lost and is only discovered by the
     * pre-answer re-check starts its cap from that discovery, so its ceiling is
     * the cap plus at most one re-check interval. FreeSWITCH's own answer time is
     * not available at that point, and a late cap is still a cap.
     */
    function armMaxDurationTimer(uuid) {
        if (maxDurationTimers.has(uuid) || deadChannels.has(uuid)) return
        const timer = setTimer(() => {
            maxDurationTimers.delete(uuid)
            onMaxCallDuration(uuid)
        }, maxCallDurationMs)
        if (timer && typeof timer.unref === 'function') timer.unref()
        maxDurationTimers.set(uuid, timer)
        log(`[esl] ${uuid} answered -> hard duration cap armed at ${maxCallDurationMs} ms`)
        emitTermination('armed', uuid, { reason: 'max_duration', maxCallDurationMs })
    }

    /**
     * The cap expired. Two independent actions, neither nested in the other:
     * the session's own terminal transition, then the physical safety action.
     *
     * The session's reason is `max_duration`, which is deliberately not one of
     * the reasons a session asks termination for — the kill below is this
     * module's, so wiring it through the session would rebuild exactly the cycle
     * the primitive avoids. A session that already ended keeps the reason it
     * ended with; stop() is idempotent.
     */
    function onMaxCallDuration(uuid) {
        if (deadChannels.has(uuid)) {
            log(`[esl] hard duration cap for ${uuid} found the channel already hung up`)
            emitTermination('suppressed', uuid, { reason: 'max_duration', detail: 'channel already hung up' })
            return
        }
        logError(`[esl] ${uuid} hit the hard duration cap after ${maxCallDurationMs} ms -> terminating`)
        const session = getSession(uuid)
        if (session) {
            try { session.stop('max_duration') } catch (err) {
                logError(`[esl] session stop failed for ${uuid} at the duration cap: ${err.message}`)
            }
        }
        const disposition = terminate(uuid, { reason: 'max_duration', graceMs: 0 })
        // The cap was spent on a channel whose earlier hangup is still outstanding.
        // If that one lands the channel dies and this timer is cleared with it; if
        // it does not, the backstop has to still be there.
        if (disposition === 'duplicate') rearmCapAfterUnlandedAttempt(uuid)
    }

    // A kill FreeSWITCH accepted is answered by CHANNEL_HANGUP_COMPLETE, and
    // releaseChannel drops the mark then. If that event is lost (an event-socket
    // reconnect can lose one), this bounds the mark the same way the dead set is
    // bounded, so the state converges instead of growing for the process lifetime.
    // A failed attempt leaves the channel free to be terminated again: it may well
    // still be up, and the hard duration cap — or any later independent trigger —
    // must be able to act. One attempt per trigger, so this is bounded by triggers,
    // never a retry loop.
    function releaseTerminationEpisode(uuid) {
        terminatingChannels.delete(uuid)
        killedChannels.delete(uuid)
    }

    // A hangup that did not land leaves an answered channel that may still be up,
    // and the cap is the only thing that would ever end it — but the cap is a
    // one-shot timer and may already have been spent (consumed by its own failing
    // attempt, or burnt as a duplicate while an earlier kill was still in flight).
    // Re-arming it here is what keeps the ten-minute guarantee from degrading into
    // "we tried once". It is not a retry loop: one command per cap period at most,
    // and it converges — a success, an "already gone" reply, or the real hangup
    // clears the timer for good.
    function rearmCapAfterUnlandedAttempt(uuid) {
        if (deadChannels.has(uuid) || killedChannels.has(uuid)) return
        if (!answeredChannels.has(uuid)) return
        armMaxDurationTimer(uuid)
        log(`[esl] ${uuid} hangup did not land -> duration cap re-armed`)
    }

    function expireTerminationMark(uuid) {
        if (terminationMarkTimers.has(uuid)) return
        const timer = setTimer(() => {
            terminationMarkTimers.delete(uuid)
            releaseTerminationEpisode(uuid)
        }, deadChannelTtlMs)
        if (timer && typeof timer.unref === 'function') timer.unref()
        terminationMarkTimers.set(uuid, timer)
    }

    // The single place that ends a channel, and it attempts the command exactly
    // once per accepted request: there is no retry here and no loop.
    //
    // A rejected or failed attempt releases the mark. The channel may well still
    // be up, and an independent later safety trigger — a duration cap, an
    // operator action — must be able to act on it; a permanent mark would turn
    // one transient ESL failure into a call nothing can ever end. That is bounded
    // by the number of triggers, not by retries: each one gets a single attempt.
    function issueKill(uuid, requested) {
        // Synchronously, before the command leaves: from here on every further
        // request for this channel is a duplicate, including an immediate safety
        // one. Escalation is only possible while a kill is still *pending*.
        killedChannels.add(uuid)
        let reply
        try { reply = eslApi(`uuid_kill ${uuid} ${requested.cause}`) } catch (err) { reply = Promise.reject(err) }
        Promise.resolve(reply)
            .then(out => {
                const text = String(out).trim()
                if (text.startsWith('+OK')) {
                    log(`[esl] ${uuid} terminated (${requested.reason}): ${text.slice(0, 120)}`)
                    emitTermination('issued', uuid, { ...requested, reply: text.slice(0, 120) })
                    if (!deadChannels.has(uuid)) expireTerminationMark(uuid)
                    return
                }
                if (CHANNEL_ALREADY_GONE.test(text)) {
                    log(`[esl] termination for ${uuid} (${requested.reason}) found the channel already gone`)
                    emitTermination('suppressed', uuid, { ...requested, detail: 'channel already gone' })
                    if (!deadChannels.has(uuid)) expireTerminationMark(uuid)
                    return
                }
                logError(`[esl] termination REJECTED for ${uuid} (${requested.reason}): ${text.slice(0, 120)}`)
                releaseTerminationEpisode(uuid)
                emitTermination('failed', uuid, { ...requested, detail: text.slice(0, 120) })
                rearmCapAfterUnlandedAttempt(uuid)
            })
            .catch(err => {
                logError(`[esl] termination FAILED for ${uuid} (${requested.reason}): ${err.message}`)
                releaseTerminationEpisode(uuid)
                emitTermination('failed', uuid, { ...requested, detail: String(err.message).slice(0, 120) })
                rearmCapAfterUnlandedAttempt(uuid)
            })
    }

    /**
     * Physical channel termination — one direction only.
     *
     * This is the only code path that ends a FreeSWITCH channel, and it never
     * calls back into a CallSession. A session's own terminal transition (its
     * exactly-once finalize) belongs to the session; the two lifecycles are
     * connected by this contract, not by mutual calls, so no cycle exists. A
     * second safety trigger therefore performs two independent actions —
     * stopping its session and calling terminate() — rather than one nested in
     * the other.
     *
     * At most one hangup per channel per termination episode. `killedChannels` is
     * marked synchronously inside issueKill, before the command leaves, so no
     * trigger and no repeated event can produce a second one. A channel
     * FreeSWITCH already reported dead is never touched.
     *
     * `graceMs` defers the kill so a final phrase can finish playing. The wait
     * uses the injected timer and is bounded; a real CHANNEL_HANGUP_COMPLETE in
     * the meantime cancels it (releaseChannel clears the timer, and the deferred
     * kill re-checks the dead set before sending anything).
     *
     * While a kill is only *scheduled*, an immediate request (a grace of 0) takes
     * over: the pending wait is cancelled and the hangup is sent now. That is the
     * whole urgency mechanism — no priorities, no queue. It is what lets the hard
     * duration cap cut a call that is sitting inside a goodbye grace, without ever
     * sending two hangups. A request that itself wants a grace never preempts.
     *
     * Returns its disposition and never throws: callers are terminal paths that
     * must not be broken by a telephony-side problem.
     */
    function terminate(uuid, { reason = 'unspecified', cause = DEFAULT_HANGUP_CAUSE, graceMs = 0 } = {}) {
        const requested = { reason, cause, graceMs }
        if (!CHANNEL_UUID_PATTERN.test(String(uuid))) {
            logError(`[esl] termination REFUSED for ${uuid}: not a channel uuid FreeSWITCH can be asked about`)
            emitTermination('failed', uuid, { ...requested, detail: 'not a channel uuid' })
            return 'refused'
        }
        if (!HANGUP_CAUSE_PATTERN.test(String(cause))) {
            logError(`[esl] termination REFUSED for ${uuid}: invalid hangup cause`)
            emitTermination('failed', uuid, { ...requested, detail: 'invalid hangup cause' })
            return 'refused'
        }
        if (deadChannels.has(uuid)) {
            log(`[esl] termination suppressed for ${uuid} (${reason}): channel already hung up`)
            emitTermination('suppressed', uuid, { ...requested, detail: 'channel already hung up' })
            return 'suppressed'
        }
        if (killedChannels.has(uuid)) {
            log(`[esl] termination suppressed for ${uuid} (${reason}): hangup already sent`)
            emitTermination('suppressed', uuid, { ...requested, detail: 'hangup already sent' })
            return 'duplicate'
        }
        const waitMs = Number.isFinite(graceMs) && graceMs > 0 ? Math.min(graceMs, MAX_TERMINATION_GRACE_MS) : 0
        const pending = terminationTimers.get(uuid)
        if (pending !== undefined) {
            // A kill is scheduled but not sent. An immediate request replaces that
            // wait instead of being dropped as a duplicate: the hard duration cap
            // must not be made to wait behind a goodbye phrase. Still one command —
            // the pending timer is cancelled, never fired.
            if (waitMs > 0) {
                log(`[esl] termination suppressed for ${uuid} (${reason}): termination already in progress`)
                emitTermination('suppressed', uuid, { ...requested, detail: 'termination already in progress' })
                return 'duplicate'
            }
            terminationTimers.delete(uuid)
            try { clearTimer(pending.timer) } catch {}
            logError(`[esl] ${uuid} escalating pending termination (${pending.requested.reason}) to immediate (${reason})`)
            emitTermination('escalated', uuid, {
                ...requested,
                graceMs: waitMs,
                preempted_reason: pending.requested.reason,
                preempted_grace_ms: pending.requested.graceMs,
            })
            issueKill(uuid, { ...requested, graceMs: waitMs })
            return 'escalated'
        }
        if (terminatingChannels.has(uuid)) {
            log(`[esl] termination suppressed for ${uuid} (${reason}): termination already in progress`)
            emitTermination('suppressed', uuid, { ...requested, detail: 'termination already in progress' })
            return 'duplicate'
        }
        terminatingChannels.add(uuid)
        emitTermination('requested', uuid, { ...requested, graceMs: waitMs })
        log(`[esl] terminating ${uuid} (${reason}, cause ${cause}, grace ${waitMs} ms)`)
        if (waitMs === 0) {
            issueKill(uuid, { ...requested, graceMs: waitMs })
            return 'issued'
        }
        const timer = setTimer(() => {
            terminationTimers.delete(uuid)
            if (deadChannels.has(uuid)) {
                log(`[esl] deferred termination suppressed for ${uuid} (${reason}): channel already hung up`)
                emitTermination('suppressed', uuid, { ...requested, graceMs: waitMs, detail: 'channel already hung up' })
                return
            }
            issueKill(uuid, { ...requested, graceMs: waitMs })
        }, waitMs)
        if (timer && typeof timer.unref === 'function') timer.unref()
        terminationTimers.set(uuid, { timer, requested: { ...requested, graceMs: waitMs } })
        return 'scheduled'
    }

    function onAnswerFact(uuid, ext, via) {
        if (deadChannels.has(uuid)) return
        clearPreAnswerTimer(uuid)
        if (!answeredChannels.has(uuid)) {
            answeredChannels.add(uuid)
            flushPendingBroadcasts(uuid)
            armMaxDurationTimer(uuid)
        }
        startFork(uuid, ext, via)
    }

    function releaseChannel(uuid, cause) {
        clearPreAnswerTimer(uuid)
        // FreeSWITCH ended the channel, so a pending deferred kill has nothing
        // left to end. Dropping the mark as well keeps the state of a reaped
        // uuid identical to one this lifecycle never terminated.
        clearTerminationTimers(uuid)
        clearMaxDurationTimer(uuid)
        releaseTerminationEpisode(uuid)
        const queued = pendingBroadcasts.get(uuid)
        if (queued && queued.length) {
            log(`[esl] ${cause} ${uuid} -> dropping ${queued.length} unplayed broadcast(s)`)
            // durMs=0 lets an awaiting _speak() fall through its mute-window math.
            for (const item of queued) { try { item.resolve(0) } catch {} }
        }
        pendingBroadcasts.delete(uuid)
        answeredChannels.delete(uuid)
        forkedChannels.delete(uuid)
        boundChannels.delete(uuid)
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
        const knownUuid = answeredChannels.has(uuid) || forkedChannels.has(uuid) || boundChannels.has(uuid)
            || pendingBroadcasts.has(uuid) || deadChannels.has(uuid) || Boolean(getSession(uuid))
        // Channels that are neither ours nor already tracked never create state.
        if (!matched && !knownUuid) return

        const answerState = headers['Answer-State']
        log(`[esl] ${eventName} uuid=${uuid} dialed=[${dialedExts.join(',')}] matched=${matched ?? 'none'} answerState=${answerState ?? '?'}`)

        if (eventName === 'CHANNEL_HANGUP_COMPLETE') {
            releaseChannel(uuid, 'CHANNEL_HANGUP_COMPLETE')
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
            if (boundChannels.has(uuid)) {
                log(`[esl] CHANNEL_PARK repeated for ${uuid}: session bind already requested`)
            } else {
                boundChannels.add(uuid)
                let bind
                try { bind = ensureSession(uuid, () => deadChannels.has(uuid)) } catch (err) { bind = Promise.reject(err) }
                Promise.resolve(bind).catch(err => logError(`[esl] session bind failed for ${uuid}: ${err.message}`))
            }
            if (answerState === 'answered') onAnswerFact(uuid, ext, 'CHANNEL_PARK')
            else armPreAnswerTimer(uuid)
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
        terminate,
        isDead: uuid => deadChannels.has(uuid),
        isTerminating: uuid => terminatingChannels.has(uuid),
        isKilled: uuid => killedChannels.has(uuid),
        snapshot: () => ({
            answered: [...answeredChannels],
            forked: [...forkedChannels],
            bound: [...boundChannels],
            dead: [...deadChannels],
            pending: [...pendingBroadcasts.keys()],
            preAnswerTimers: [...preAnswerTimers.keys()],
            terminating: [...terminatingChannels],
            killed: [...killedChannels],
            terminationTimers: [...terminationTimers.keys()],
            maxDurationTimers: [...maxDurationTimers.keys()],
        }),
    }
}

module.exports = {
    createChannelLifecycle,
    createSessionResolver,
    parseEslEventHeaders,
    buildAudioForkCommand,
    DEFAULT_DEAD_CHANNEL_TTL_MS,
    DEFAULT_PRE_ANSWER_TIMEOUT_MS,
    DEFAULT_HANGUP_CAUSE,
    MAX_TERMINATION_GRACE_MS,
    DEFAULT_MAX_CALL_DURATION_MS,
}
