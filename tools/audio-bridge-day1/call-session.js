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
     */
    constructor({ callUuid, scenario, broadcastWav, onFinalize, onTranscriptItem, onState }) {
        this.callUuid = callUuid
        this.scenario = scenario
        this.broadcastWav = broadcastWav
        this.onFinalize = onFinalize ?? (() => {})
        this.onTranscriptItem = onTranscriptItem ?? (() => {})
        this.onState = onState ?? (() => {})

        this.state = 'idle'
        // OpenAI message history — system + alternating user/assistant turns.
        this.messages = []
        // Snapshot of accumulated lead data from save_lead_data tool calls.
        this.leadData = {}
        // What the model decided in end_call. Filled on graceful close.
        this.finalResult = null
        // Pending STT finals coalesced between LLM turns.
        this.pendingUserText = ''
        // Debounce timer for "user paused → process turn"
        this.userPauseTimer = null
        this.USER_PAUSE_MS = Number(process.env.USER_PAUSE_MS ?? 1200)

        this.sttSession = null
        // Counter for unique audio filenames per call.
        this.playbackCount = 0
    }

    _setState(s) {
        if (!STATES.includes(s)) throw new Error(`Unknown state: ${s}`)
        this.state = s
        this.onState(s)
    }

    async start() {
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
        if (this.sttSession) this.sttSession.send(pcmBuffer)
    }

    _onSttFinal(text) {
        const trimmed = text.trim()
        if (!trimmed) return
        this.pendingUserText = (this.pendingUserText + ' ' + trimmed).trim()
        this.onTranscriptItem('user', trimmed)
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
            result = await llm.chatTurn({ messages: this.messages })
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
            this.finalResult = {
                qualification_status: args.qualification_status,
                lead_summary: args.lead_summary,
                reason: args.reason,
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
        try {
            const wav = await tts.synthesize(text)
            await this.broadcastWav(wav)
        } catch (err) {
            console.error(`[call ${this.callUuid}] tts error: ${err.message}`)
        }
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
        if (this.sttSession) {
            try { this.sttSession.stop() } catch {}
            this.sttSession = null
        }
        if (this.state !== 'ended') this._end('closed')
    }
}

module.exports = { CallSession }
