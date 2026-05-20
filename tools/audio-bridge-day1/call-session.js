/**
 * Per-call dialog orchestrator.
 *
 *      mod_audio_fork  →  PCM frames  →  STT  →  text
 *                                                  │
 *                                                  ▼
 *                                                 LLM  ─► tool_calls
 *                                                  │       (save_lead_data,
 *                                                  ▼        end_call, transfer)
 *                                                 text  ─► TTS  ─► WAV
 *                                                                   │
 *                                                                   ▼
 *                                                         bridge.broadcast()
 *                                                         (uuid_broadcast)
 *
 * The CallSession owns the full message history for one call, debounces
 * STT finals into LLM turns, dispatches tool calls, and emits text-to-say
 * back through a `broadcast(wavBuffer)` callback wired by the bridge.
 *
 * Lifecycle:
 *   const s = new CallSession({...})
 *   await s.start()
 *   s.onPcm(buf)         // forwarded from WS
 *   ...
 *   s.stop()             // WS close OR end_call tool
 *
 * Without OPENAI_API_KEY the session degrades to "log-only mode": STT
 * (if present) still records the transcript, but the bot won't respond.
 * That preserves the Day-1 audio-only behaviour for boxes with no keys.
 */

const stt = require('./stt-router')
const tts = require('./tts-router')
const llm = require('./llm-client')

/**
 * State transitions:
 *   'idle'      — created, not started
 *   'greeting'  — bot is producing the first phrase
 *   'listening' — waiting for user speech / STT finals
 *   'thinking'  — LLM round-trip in flight
 *   'speaking'  — TTS audio is being broadcast
 *   'ended'     — call wrapped up (normal or error)
 */
const STATES = ['idle', 'greeting', 'listening', 'thinking', 'speaking', 'ended']

class CallSession {
    /**
     * @param {Object} opts
     * @param {string} opts.callUuid             FreeSWITCH call UUID
     * @param {Object} opts.scenario             AiCallScenario row from CRM
     * @param {Function} opts.broadcastWav       async (wav: Buffer) => void
     * @param {Function} [opts.onFinalize]       called once with the full result
     * @param {Function} [opts.onTranscriptItem] (role, text) for live CRM mirror
     * @param {Function} [opts.onState]          (state) for diagnostics
     * @param {Function} [opts.onUserSpoke]      called on the FIRST STT final
     *                                           that the session accepts. Used
     *                                           by the bridge to mark the
     *                                           call as `active` in CRM —
     *                                           «real dialog has started».
     *                                           Fires more than once is
     *                                           harmless; server.js guards
     *                                           against duplicate POSTs.
     */
    constructor({ callUuid, scenario, broadcastWav, onFinalize, onTranscriptItem, onState, onUserSpoke }) {
        this.callUuid = callUuid
        this.scenario = scenario
        this.broadcastWav = broadcastWav
        this.onFinalize = onFinalize ?? (() => {})
        this.onTranscriptItem = onTranscriptItem ?? (() => {})
        this.onState = onState ?? (() => {})
        this.onUserSpoke = onUserSpoke ?? (() => {})

        this.state = 'idle'
        // OpenAI message history — system + alternating user/assistant turns.
        this.messages = []
        // Snapshot of accumulated lead data from save_lead_data tool calls.
        this.leadData = {}
        // What the model decided in end_call. Filled on graceful close.
        this.finalResult = null
        // PR #57 — per-scenario tool overrides (canonical-key enum on
        // save_lead_data, qualification_score arg on end_call). Built
        // once at start() so the deep-clone happens only once per call.
        this.tools = null
        // Pending STT finals coalesced between LLM turns.
        this.pendingUserText = ''
        // PR #57 — counter of real STT-derived user turns ONLY. Synthetic
        // wake-up messages injected by the silence-timeout path push
        // directly to pendingUserText and bypass this counter, so they
        // don't inflate engagement signal in the outcome mapper.
        // Bridge sends this in the finalize body; route.ts feeds it to
        // computeOutcome to distinguish `dropped_no_input` from
        // `dropped_mid_call` and from `unclear_engaged`.
        this.realUserUtterances = 0
        // Debounce timer for "user paused → process turn"
        this.userPauseTimer = null
        this.USER_PAUSE_MS = Number(process.env.USER_PAUSE_MS ?? 1200)
        // Post-speak grace window: how long after estimated TTS playback
        // ends we keep STT muted. Sized as a TRADE-OFF:
        //   - Longer (2 s+) — kills more echo (catches Whisper finalizing
        //     stale TTS audio), BUT eats fast lead replies that come
        //     within ~1 s of the bot finishing. Users on a phone call
        //     answer immediately; if their "да удобно" lands in the mute
        //     window the bot stays silent and the call dies.
        //   - Shorter (~500 ms) — preserves quick lead replies, BUT the
        //     last 0.5–1 s of TTS may bleed into STT as a trailing
        //     fragment ("...категории B?" -> "категории B" in transcript).
        // 500 ms is the empirical sweet-spot for this build: bot's last
        // word may occasionally leak as one fragment, but the call
        // stays alive and conversational.
        this.POST_SPEAK_GRACE_MS = Number(process.env.POST_SPEAK_GRACE_MS ?? 500)
        // Timestamp after which STT finals are accepted again. While the bot
        // is in 'speaking' state we keep this set to +∞ — only flipped back
        // to a real epoch when speaking ends.
        this.acceptSttAfter = 0

        // Silence-timeout machinery. The system prompt already tells the
        // model «if STT sends garbage/silence reply briefly with "Не
        // расслышал, повторите?" once and then move on», but that
        // requires the model to be GIVEN something to react to. If the
        // lead is fully silent — STT emits no finals at all — the model
        // sits idle and the call hangs. These timers fire from the bridge
        // side, generate a synthetic user message that wakes the model up
        // (or end the call after N strikes), independent of STT activity.
        //
        // SILENCE_TIMEOUT_MS — how long to wait in `listening` before
        // counting one «strike». Default ~8 s = phone-call-natural pause
        // between turns + Yandex / Whisper final lag.
        // MAX_SILENT_STRIKES — call ends as `unclear / silence` after
        // this many consecutive misses. Default 2 (one re-prompt, then
        // give up — matches the model's instruction «Дважды не
        // переспрашивай»).
        this.SILENCE_TIMEOUT_MS = Number(process.env.SILENCE_TIMEOUT_MS ?? 8000)
        this.MAX_SILENT_STRIKES = Number(process.env.MAX_SILENT_STRIKES ?? 2)
        this.silenceTimer = null
        this.silenceStrikes = 0

        this.sttSession = null
        // Counter for unique audio filenames per call.
        this.playbackCount = 0
    }

    _clearSilenceTimer() {
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer)
            this.silenceTimer = null
        }
    }

    _armSilenceTimer() {
        this._clearSilenceTimer()
        if (this.state === 'ended') return
        this.silenceTimer = setTimeout(() => this._onSilenceTimeout(), this.SILENCE_TIMEOUT_MS)
    }

    async _onSilenceTimeout() {
        this.silenceTimer = null
        if (this.state !== 'listening') return  // user started speaking → ignore
        this.silenceStrikes++
        console.log(
            `[call ${this.callUuid}] silence-strike ${this.silenceStrikes}/${this.MAX_SILENT_STRIKES} ` +
            `after ${this.SILENCE_TIMEOUT_MS}ms`,
        )
        if (this.silenceStrikes >= this.MAX_SILENT_STRIKES) {
            // Hand off to the model with a tail-of-silence marker so it
            // can wrap up gracefully (the system prompt knows how to call
            // end_call with qualification_status=unclear when the lead
            // didn't engage).
            this.pendingUserText = '(длительная тишина — лид не отвечает; завершай разговор end_call с qualification_status=unclear)'
            return this._processPendingUserText()
        }
        // First strike — synthesize a short re-prompt from the model side.
        this.pendingUserText = '(лид молчит — короткое подбадривание или повтор последнего вопроса)'
        return this._processPendingUserText()
    }

    _setState(s) {
        if (!STATES.includes(s)) throw new Error(`Unknown state: ${s}`)
        this.state = s
        this.onState(s)
        // Drive the silence timer off state transitions instead of from
        // every code path — fewer places to forget.
        //   listening → arm: lead has the floor, start the no-input clock.
        //   anything else → clear: bot is speaking / thinking / ended, no
        //     pending listen.
        if (s === 'listening') {
            this._armSilenceTimer()
        } else {
            this._clearSilenceTimer()
        }
    }

    async start() {
        // PR #57 — cache scenario-specific tool overrides once. When
        // outcomeSchema is absent this is just a reference to the
        // module-level TOOLS array (no allocation); when present, it's
        // a deep clone with `save_lead_data.field` enum'd to canonical
        // keys. Each turn passes this through to chatTurn.
        this.tools = llm.enabled() ? llm.buildTools(this.scenario) : null

        // Build system prompt from scenario, push as the very first message.
        this.messages.push({
            role: 'system',
            content: llm.enabled()
                ? llm.buildSystemMessage(this.scenario)
                : 'STUB — no LLM',
        })

        // Initialise STT session if a provider is available.
        if (stt.enabled()) {
            this.sttSession = stt.createSttSession({
                callUuid: this.callUuid,   // threaded into inactivity-timeout opsLog
                onPartial: () => {}, // ignore partials at orchestrator level
                onFinal: text => this._onSttFinal(text),
                onError: err => console.error(`[call ${this.callUuid}] stt error: ${err.message}`),
            })
            try {
                await this.sttSession.start()
            } catch (err) {
                console.error(`[call ${this.callUuid}] stt start failed: ${err.message}`)
                this.sttSession = null
            }
        }

        // First greeting — only if LLM is enabled. Otherwise stay silent
        // and just record the call (Day-1 behaviour).
        if (llm.enabled() && tts.enabled()) {
            this._setState('greeting')
            await this._doTurn(/* asGreeting */ true)
        } else {
            this._setState('listening')
        }
    }

    onPcm(pcmBuffer) {
        if (!this.sttSession) return
        // Gate PCM at the SOURCE rather than only filtering STT finals
        // downstream. Audio_fork "mixed" mode delivers our own TTS in the
        // same stream as the lead's voice; if we let it reach the STT
        // engine, Whisper finalizes our own words as if the lead said
        // them. Dropping finals after the fact is too late — the STT
        // buffer is already poisoned. Skipping PCM frames entirely while
        // the bot is speaking (or in the post-speak grace window) means
        // Whisper literally never sees the echo audio.
        if (this.state === 'greeting' || this.state === 'speaking') return
        if (Date.now() < this.acceptSttAfter) return
        this.sttSession.send(pcmBuffer)
    }

    _onSttFinal(text) {
        const trimmed = text.trim()
        if (!trimmed) return

        // Turn-taking guard — drop STT finals while the bot is producing its
        // own audio. With audio_fork in mono mode this is rare, but room
        // acoustics + speakerphone echo + STT picking up our own filler
        // tones still happens. Anything STT returns while we're 'greeting'
        // or 'speaking' is treated as noise rather than user speech.
        if (this.state === 'greeting' || this.state === 'speaking') {
            console.log(`[call ${this.callUuid}] stt-drop (${this.state}): ${trimmed.slice(0, 60)}`)
            return
        }

        // Post-speak grace window — see acceptSttAfter setup in _speak().
        if (Date.now() < this.acceptSttAfter) {
            console.log(`[call ${this.callUuid}] stt-drop (grace): ${trimmed.slice(0, 60)}`)
            return
        }

        this.pendingUserText = (this.pendingUserText + ' ' + trimmed).trim()
        this.onTranscriptItem('user', trimmed)
        // Lifecycle hook: «real dialog has started». Bridge uses this
        // to mark CRM `Call.aiSessionStatus='active'` via the /state
        // endpoint. Fires once per session in practice (server.js
        // de-dupes); the helper itself is allowed to fire many times
        // — the endpoint is idempotent.
        this.onUserSpoke()
        // PR #57 — count REAL user utterances (excludes synthetic
        // wake-up messages injected by _onSilenceTimeout). This is
        // the signal the outcome mapper uses to distinguish
        // dropped_no_input (counter=0) from dropped_mid_call or
        // unclear_engaged (counter>0).
        this.realUserUtterances += 1
        // Lead actually said something — reset the no-input counter so a
        // single mid-call gap doesn't end up as «strike 2 / abandoned».
        this.silenceStrikes = 0
        this._clearSilenceTimer()
        // Reset debounce: each new final pushes back the "user is done" moment.
        if (this.userPauseTimer) clearTimeout(this.userPauseTimer)
        this.userPauseTimer = setTimeout(() => this._processPendingUserText(), this.USER_PAUSE_MS)
    }

    async _processPendingUserText() {
        if (!this.pendingUserText || this.state === 'ended') return
        const text = this.pendingUserText
        this.pendingUserText = ''
        this.messages.push({ role: 'user', content: text })
        if (llm.enabled()) await this._doTurn(false)
    }

    /**
     * One LLM round-trip + side-effects. Recurses ONLY when the model asks
     * us to act via tool_call — we never auto-respond to bot text.
     */
    async _doTurn(asGreeting = false) {
        if (this.state === 'ended') return
        this._setState('thinking')

        // For greeting, prepend a synthetic user prompt asking the model to
        // open the conversation. Without something to react to gpt-4o-mini
        // happily emits nothing.
        if (asGreeting) {
            this.messages.push({
                role: 'user',
                content: '(начни разговор: поздоровайся и задай первый вопрос из сценария)',
            })
        }

        let result
        try {
            result = await llm.chatTurn({ messages: this.messages, tools: this.tools })
        } catch (err) {
            console.error(`[call ${this.callUuid}] llm error: ${err.message}`)
            this._setState('listening')
            return
        }

        if (result.kind === 'empty') {
            this._setState('listening')
            return
        }

        if (result.kind === 'text') {
            // Append to history, then speak it.
            this.messages.push({ role: 'assistant', content: result.content })
            this.onTranscriptItem('assistant', result.content)
            await this._speak(result.content)
            this._setState('listening')
            return
        }

        // result.kind === 'function'
        // Record the model's decision into history so the next turn knows it
        // already happened (and to satisfy the tool-call/tool-response pairing).
        this.messages.push({
            role: 'assistant',
            content: null,
            tool_calls: [{
                id: result.callId,
                type: 'function',
                function: {
                    name: result.name,
                    arguments: JSON.stringify(result.args),
                },
            }],
        })

        await this._dispatchTool(result.name, result.args, result.callId)
    }

    async _dispatchTool(name, args, callId) {
        if (name === 'save_lead_data') {
            // Record into leadData; reply to the model so it can move on.
            this.leadData[args.field] = args.value
            console.log(`[call ${this.callUuid}] save_lead_data: ${args.field}=${args.value}`)
            this.messages.push({
                role: 'tool',
                tool_call_id: callId,
                name,
                content: JSON.stringify({ ok: true }),
            })
            // Re-enter the loop: the model now decides what to say next.
            return this._doTurn(false)
        }

        if (name === 'transfer_to_manager') {
            console.log(`[call ${this.callUuid}] transfer_to_manager: ${args.reason}`)
            // Live transfer not wired in this PR — for now we just speak a
            // polite handoff line and end. CRM records the intent via the
            // finalize payload (aiTransferReason).
            this.finalResult = {
                qualification_status: 'unclear',
                lead_summary: 'Лид запросил живого менеджера.',
                reason: args.reason,
                manager_task: {
                    should_create: true,
                    summary: `Перезвонить лиду — запросил живого менеджера: ${args.reason}`,
                    priority: 'high',
                },
                transfer_reason: args.reason,
            }
            await this._speak('Соединяю вас с менеджером, оставайтесь на линии.')
            return this._end('transferred')
        }

        if (name === 'end_call') {
            // PR #57 — propagate qualification_score through to the
            // finalize payload. Optional from the LLM's perspective;
            // CRM-side mapper clamps + persists into Call.qualificationScore.
            this.finalResult = {
                qualification_status: args.qualification_status,
                lead_summary: args.lead_summary,
                reason: args.reason,
                qualification_score: typeof args.qualification_score === 'number'
                    ? args.qualification_score
                    : null,
                manager_task: args.manager_task ?? { should_create: false },
                lead_data: this.leadData,
            }
            await this._speak('Спасибо за разговор, всего доброго.')
            return this._end('completed')
        }

        // Unknown tool — log and continue.
        console.warn(`[call ${this.callUuid}] unknown tool: ${name}`)
        this.messages.push({
            role: 'tool',
            tool_call_id: callId,
            name,
            content: JSON.stringify({ error: 'unknown_tool' }),
        })
        return this._doTurn(false)
    }

    async _speak(text) {
        if (!tts.enabled() || !this.broadcastWav) return
        this._setState('speaking')
        // Drop any pending user text that arrived while we were thinking —
        // it's stale relative to what the bot is about to say.
        this.pendingUserText = ''
        if (this.userPauseTimer) {
            clearTimeout(this.userPauseTimer)
            this.userPauseTimer = null
        }
        let estimatedPlaybackMs = 0
        try {
            const wav = await tts.synthesize(text)
            // broadcastWav() is fire-and-forget on the FS side
            // (uuid_broadcast doesn't block until playback completes).
            // It returns the estimated playback duration parsed from the
            // WAV header, which we use as the "how long is the bot
            // talking" oracle to size the STT mute window below.
            const ret = await this.broadcastWav(wav)
            if (typeof ret === 'number' && ret > 0) estimatedPlaybackMs = ret
        } catch (err) {
            console.error(`[call ${this.callUuid}] tts error: ${err.message}`)
        }
        // STT mute window. Must cover:
        //   (a) the entire estimated TTS playback duration on the line —
        //       FS keeps streaming our own audio through audio_fork the
        //       whole time playback runs in "mixed" mode,
        //   (b) the Whisper finalization lag — STT chunks accumulated
        //       during playback get finalized a beat after audio ends.
        // Sum is the floor before STT is allowed to listen again.
        // Combined with the state==='speaking' source-gate in onPcm(),
        // this gives a defence-in-depth against echo without requiring
        // the (broken) uuid_audio_fork pause API.
        this.acceptSttAfter = Date.now() + estimatedPlaybackMs + this.POST_SPEAK_GRACE_MS
    }

    _end(reason) {
        if (this.state === 'ended') return
        this._setState('ended')
        try {
            this.onFinalize({
                callUuid: this.callUuid,
                reason,
                result: this.finalResult,
                leadData: this.leadData,
                transcript: this.messages.filter(m => m.role === 'user' || m.role === 'assistant'),
                // PR #57 — real STT-derived user turn count (excludes
                // bridge-synthesized silence wake-ups). CRM's
                // outcome-mapper uses this to distinguish drop categories.
                realUserUtterances: this.realUserUtterances,
            })
        } catch (err) {
            console.error(`[call ${this.callUuid}] onFinalize threw: ${err.message}`)
        }
    }

    stop() {
        if (this.userPauseTimer) {
            clearTimeout(this.userPauseTimer)
            this.userPauseTimer = null
        }
        this._clearSilenceTimer()
        if (this.sttSession) {
            try { this.sttSession.stop() } catch {}
            this.sttSession = null
        }
        if (this.state !== 'ended') this._end('closed')
    }
}

module.exports = { CallSession }
