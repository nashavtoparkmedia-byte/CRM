// Regression harness for the silence-timer machinery in CallSession.
//
// Why this file exists: the silence-timer was added in PR #30 but had no
// automated coverage — its behaviour was only observed by running a real
// AI-call and waiting in silence. That's expensive, non-deterministic, and
// brittle (depends on a live FreeSWITCH + bridge + STT/LLM/TTS stack). The
// underlying state machine is pure, so we can drive it directly:
//
//   • mock stt-router/tts-router/llm-client via require.cache injection
//     BEFORE call-session.js is loaded;
//   • build a CallSession with that mock surface;
//   • call _setState() and _onSilenceTimeout() / _onSttFinal() directly to
//     verify each acceptance criterion without waiting on real timers.
//
// Run: `node --test __tests__/silence-timer.test.js` (or `npm test`).
//
// Covers the six acceptance criteria for the silence-timer:
//   1. listening state arms the timer
//   2. timeout produces a strike + bumps strike counter
//   3. first strike does NOT end the call (only re-prompts)
//   4. second strike ends the call with qualification_status='unclear'
//   5. STT activity resets strikes + clears the armed timer
//   6. stop() clears the timer (no leaked setTimeout on session teardown)
//
// It also covers the terminal-transition contract the physical-termination
// primitive depends on: exactly one finalize, a first-writer-wins terminal
// reason, and exactly one provider-agnostic termination request per session.

const test = require('node:test')
const assert = require('node:assert/strict')

// ---- Mock surface ---------------------------------------------------------
// CallSession requires stt-router/tts-router/llm-client at module load.
// We pre-populate require.cache so the real impls never get evaluated
// (avoids needing OPENAI_API_KEY / Yandex creds / ws to even import).

const mockState = {
    // What llm.chatTurn returns. Tests reassign before triggering a turn.
    llmReturn: { kind: 'text', content: '(stub bot reply)' },
    // Captures of every LLM call so tests can assert what the bot saw.
    llmCalls: [],
    // Optional promise that tts.synthesize awaits before returning.
    synthGate: null,
}

function stub(relPath, exports) {
    const resolved = require.resolve(relPath)
    require.cache[resolved] = {
        id: resolved, filename: resolved, loaded: true, exports,
        children: [], paths: [],
    }
}

stub('../stt-router', {
    enabled: () => false,
    createSttSession: () => null,
})

stub('../tts-router', {
    enabled: () => true,
    // Minimal WAV header — broadcastWav doesn't inspect it.
    synthesize: async () => {
        if (mockState.synthGate) await mockState.synthGate
        return Buffer.alloc(44)
    },
})

stub('../llm-client', {
    enabled: () => true,
    buildSystemMessage: () => '(stub system prompt)',
    chatTurn: async ({ messages }) => {
        mockState.llmCalls.push({ messages: messages.map(m => ({ role: m.role, content: m.content })) })
        return mockState.llmReturn
    },
})

// Now safe to load the SUT.
const { CallSession } = require('../call-session')

// ---- Helpers --------------------------------------------------------------

function makeSession(overrides = {}) {
    const events = { state: [], transcript: [], finalize: [], termination: [] }
    const s = new CallSession({
        callUuid: `test-${Math.random().toString(36).slice(2, 8)}`,
        scenario: {},
        broadcastWav: async () => 1000, // estimated playback ms
        onFinalize: r => events.finalize.push(r),
        onTranscriptItem: (role, text) => events.transcript.push({ role, text }),
        onState: state => events.state.push(state),
        // Stands in for the channel lifecycle's terminate(). The session is
        // provider-agnostic: it passes a reason and a grace and learns nothing
        // back, so a plain recorder is the whole contract.
        requestTermination: request => events.termination.push(request),
        ...overrides,
    })
    // Squash the silence-timeout window for test runs: the production
    // default is 8 s, which means any leaked setTimeout (e.g. from a
    // post-_doTurn re-armed listener) would keep the Node event loop
    // alive that long and slow the suite to ~8 s. Tests call
    // _onSilenceTimeout() directly so the actual delay doesn't matter
    // for behavioural coverage — only for «if I forgot to clean up,
    // how long does the suite stall?».
    s.SILENCE_TIMEOUT_MS = 50
    // Defensive teardown — even if a test forgets, no real timer can
    // outlive the test.
    return {
        s, events,
        cleanup: () => {
            try { s.stop() } catch {}
            if (s.silenceTimer) { clearTimeout(s.silenceTimer); s.silenceTimer = null }
            if (s.userPauseTimer) { clearTimeout(s.userPauseTimer); s.userPauseTimer = null }
        },
    }
}

function resetMocks() {
    mockState.llmReturn = { kind: 'text', content: '(stub bot reply)' }
    mockState.llmCalls = []
    mockState.synthGate = null
}

// ---- Acceptance #1: listening arms the silence timer ----------------------

test('listening state arms the silence timer', (t) => {
    resetMocks()
    const { s, cleanup } = makeSession()
    t.after(cleanup)

    assert.equal(s.silenceTimer, null, 'no timer before listening')
    s._setState('listening')
    assert.notEqual(s.silenceTimer, null, 'timer armed on entering listening')
})

// ---- Acceptance #2: a silence timeout produces a strike -------------------

test('silence timeout increments strike counter', async (t) => {
    resetMocks()
    // Bot text reply — keeps the call alive after the re-prompt.
    mockState.llmReturn = { kind: 'text', content: 'Алло, вы меня слышите?' }
    const { s, cleanup } = makeSession()
    t.after(cleanup)

    s._setState('listening')
    assert.equal(s.silenceStrikes, 0, 'no strikes initially')

    await s._onSilenceTimeout()
    assert.equal(s.silenceStrikes, 1, 'one strike after first timeout')
})

// ---- Acceptance #3: first strike does NOT end the call --------------------

test('first silence strike does not end the call', async (t) => {
    resetMocks()
    mockState.llmReturn = { kind: 'text', content: 'Алло?' }
    const { s, events, cleanup } = makeSession()
    t.after(cleanup)

    s._setState('listening')
    await s._onSilenceTimeout()

    assert.equal(events.finalize.length, 0, 'onFinalize NOT called after 1 strike')
    assert.notEqual(s.state, 'ended', 'session not in ended state after 1 strike')

    // PR #61 — Conversation Recovery Layer. On strike 1 with
    // realUserUtterances=0 (pre-greeting-cliff territory) the recovery
    // layer intercepts BEFORE the legacy LLM-injection path. Instead
    // of bouncing a synthetic «(лид молчит)» message off the model,
    // the bridge speaks a short deterministic re-engage prompt and
    // re-enters listening state. The LLM is never consulted on this
    // strike — saves a round-trip and gives the lead a chance before
    // strike 2 fires.
    assert.equal(
        mockState.llmCalls.length, 0,
        'PR #61: LLM NOT consulted on strike-1 (recovery layer intercepted)',
    )
    const recoveryEvents = s.events.filter(e => e.type === 'recovery_attempted')
    assert.equal(recoveryEvents.length, 1, 'recovery_attempted event emitted')
    assert.equal(recoveryEvents[0].payload.trigger, 'silence_after_greeting')
    assert.equal(recoveryEvents[0].payload.action, 'reengage')
})

// PR #61 regression: after the lead HAS spoken (realUserUtterances > 0),
// a mid-dialog silence on strike 1 should still go through the legacy
// LLM-injection path — recovery layer only fires for the pre-greeting
// cliff, not for mid-dialog gaps. Different shapes need different
// responses (a real lead pause shouldn't get "Вас слышно?" — they're
// already engaged).
test('first silence strike AFTER real speech → legacy LLM path (PR #61 boundary)', async (t) => {
    resetMocks()
    mockState.llmReturn = { kind: 'text', content: 'Понял, продолжу.' }
    const { s, cleanup } = makeSession()
    t.after(cleanup)

    s._setState('listening')
    // Lead spoke once → realUserUtterances bumps to 1 (PR #57).
    await s._onSttFinal('да удобно')
    s.silenceStrikes = 0  // reset (real speech zeroed it)

    await s._onSilenceTimeout()

    assert.equal(
        s.events.filter(e => e.type === 'recovery_attempted').length, 0,
        'recovery NOT triggered (lead already engaged — mid-dialog silence)',
    )
    assert.ok(mockState.llmCalls.length >= 1, 'LLM consulted on mid-dialog silence')
})

// ---- Acceptance #4: second strike ends the call with unclear --------------

test('second silence strike ends the call via end_call unclear', async (t) => {
    resetMocks()
    // Pretend the model decides to wrap up after the «длительная тишина» hint.
    mockState.llmReturn = {
        kind: 'function',
        name: 'end_call',
        args: {
            qualification_status: 'unclear',
            lead_summary: 'Лид не отвечал.',
            reason: 'Длительная тишина.',
        },
        callId: 'call_test',
    }
    const { s, events, cleanup } = makeSession()
    t.after(cleanup)

    s._setState('listening')
    s.silenceStrikes = 1 // simulate one prior strike (acceptance flow)

    await s._onSilenceTimeout()

    assert.equal(s.silenceStrikes, 2, 'strikes bumped to MAX_SILENT_STRIKES')
    assert.equal(s.state, 'ended', 'session moved to ended')
    assert.equal(events.finalize.length, 1, 'onFinalize called exactly once')
    assert.equal(events.finalize[0].reason, 'completed', 'finalize reason=completed')
    assert.equal(
        events.finalize[0].result.qualification_status,
        'unclear',
        'qualification_status=unclear on silent abandonment',
    )

    // The synthetic user msg pushed in the 2nd strike should explicitly
    // direct the model to end_call unclear.
    const lastUserMsg = mockState.llmCalls[0].messages.filter(m => m.role === 'user').pop()
    assert.match(
        lastUserMsg.content,
        /завершай разговор|end_call|unclear/i,
        'synthetic message tells the model to end the call as unclear',
    )
})

// ---- Acceptance #5: STT activity resets the strike counter + clears timer

test('STT final resets silence strikes and clears the armed timer', (t) => {
    resetMocks()
    const { s, cleanup } = makeSession()
    t.after(cleanup)

    s._setState('listening')
    s.silenceStrikes = 1 // mid-call, one prior strike

    assert.notEqual(s.silenceTimer, null, 'timer armed pre-STT')
    s._onSttFinal('да, всё хорошо')

    assert.equal(s.silenceStrikes, 0, 'strikes reset on STT activity')
    assert.equal(s.silenceTimer, null, 'armed timer cleared on STT activity')

    // _onSttFinal also schedules a userPauseTimer to commit the pending
    // turn — cancel it so the test doesn't leak an LLM call into the next.
    if (s.userPauseTimer) {
        clearTimeout(s.userPauseTimer)
        s.userPauseTimer = null
    }
})

// ---- Acceptance #6: stop() tears down the silence timer -------------------

test('stop() clears the silence timer', (t) => {
    resetMocks()
    const { s } = makeSession()

    s._setState('listening')
    assert.notEqual(s.silenceTimer, null, 'timer armed pre-stop')

    s.stop()

    assert.equal(s.silenceTimer, null, 'timer cleared after stop()')
    assert.equal(s.state, 'ended', 'state moves to ended on stop()')
})

// ---- Extra: state transition out of listening also clears the timer -------
// Belt-and-suspenders for the _setState() side-effect — proves the timer
// is driven off the state machine rather than ad-hoc call sites.

test('leaving listening state clears the silence timer', (t) => {
    resetMocks()
    const { s, cleanup } = makeSession()
    t.after(cleanup)

    s._setState('listening')
    assert.notEqual(s.silenceTimer, null, 'armed in listening')

    s._setState('thinking')
    assert.equal(s.silenceTimer, null, 'cleared on listening → thinking')

    s._setState('listening')
    assert.notEqual(s.silenceTimer, null, 're-armed on re-entering listening')
})

// ---- Extra: 'ended' is terminal for in-flight turns --------------------------
// A hangup stops the session (CHANNEL_HANGUP_COMPLETE or WS close) while a turn
// may still be awaiting playback or the LLM. The continuation must not move the
// session back to 'listening', re-arm the silence timer, finalize a second time
// or pay for TTS synthesis.

test('stop() during in-flight playback keeps the session ended and finalizes once', async (t) => {
    resetMocks()
    mockState.llmReturn = { kind: 'text', content: 'Здравствуйте!' }
    let releasePlayback = null
    const { s, events, cleanup } = makeSession({
        broadcastWav: () => new Promise(resolve => { releasePlayback = resolve }),
    })
    t.after(cleanup)

    const turn = s._doTurn(false)
    for (let i = 0; i < 50 && !releasePlayback; i++) await new Promise(r => setImmediate(r))
    assert.ok(releasePlayback, 'turn reached playback')

    s.stop()
    releasePlayback(1000)
    await turn

    assert.equal(s.state, 'ended')
    assert.equal(events.finalize.length, 1, 'finalized exactly once')
    assert.equal(events.finalize[0].reason, 'closed')
    assert.equal(s.silenceTimer, null, 'no silence timer re-armed after stop()')
    assert.equal(events.termination.length, 1, 'playback finishing after stop() adds no second action')
    const endedAt = events.state.indexOf('ended')
    assert.ok(endedAt >= 0)
    assert.deepEqual(events.state.slice(endedAt + 1), [], 'no state transition after ended')
})

test('a turn whose LLM reply arrives after stop() does not synthesise speech', async (t) => {
    resetMocks()
    let releaseLlm = null
    mockState.llmReturn = new Promise(resolve => {
        releaseLlm = () => resolve({ kind: 'text', content: 'Слишком поздно' })
    })
    let broadcasts = 0
    const { s, events, cleanup } = makeSession({
        broadcastWav: async () => { broadcasts++; return 1000 },
    })
    t.after(cleanup)

    const turn = s._doTurn(false)
    s.stop()
    releaseLlm()
    await turn

    assert.equal(broadcasts, 0, 'no playback handed to FreeSWITCH after stop()')
    assert.equal(s.state, 'ended')
    assert.equal(events.finalize.length, 1)
    assert.equal(s.silenceTimer, null)
    assert.deepEqual(events.transcript, [], 'the late reply is not recorded as spoken')
    assert.deepEqual(events.finalize[0].transcriptItems, [], 'the finalized transcript stays unchanged')
    assert.equal(events.termination.length, 1, 'a late LLM reply adds no second termination request')
})

test('a tool call whose LLM reply arrives after stop() is not applied', async (t) => {
    resetMocks()
    let releaseLlm = null
    mockState.llmReturn = new Promise(resolve => {
        releaseLlm = () => resolve({ kind: 'function', name: 'save_lead_data', args: { field: 'city', value: 'late' }, callId: 'c1' })
    })
    const { s, events, cleanup } = makeSession()
    t.after(cleanup)

    const turn = s._doTurn(false)
    s.stop()
    releaseLlm()
    await turn

    assert.deepEqual(s.leadData, {}, 'lead data is not changed after stop()')
    assert.equal(events.finalize.length, 1)
    assert.equal(events.termination.length, 1, 'a late tool call adds no second termination request')
})

test('synthesis that finishes after stop() is never broadcast', async (t) => {
    resetMocks()
    let releaseSynth = null
    mockState.synthGate = new Promise(resolve => { releaseSynth = resolve })
    let broadcasts = 0
    const { s, events, cleanup } = makeSession({
        broadcastWav: async () => { broadcasts++; return 1000 },
    })
    t.after(cleanup)

    const speaking = s._speak('Здравствуйте')
    s.stop()
    releaseSynth()
    await speaking

    assert.equal(broadcasts, 0, 'no playback handed to FreeSWITCH after stop()')
    assert.equal(s.state, 'ended')
    assert.equal(events.finalize.length, 1)
    assert.equal(events.termination.length, 1, 'late synthesis adds no second termination request')
})

test('an STT final delivered after stop() records nothing and starts no turn', async (t) => {
    resetMocks()
    let spoke = 0
    const { s, events, cleanup } = makeSession({ onUserSpoke: () => { spoke++ } })
    t.after(cleanup)

    s._setState('listening')
    s.stop()
    await s._onSttFinal('алло, да, слушаю')

    assert.deepEqual(events.transcript, [], 'no user transcript item after stop()')
    assert.equal(spoke, 0, 'onUserSpoke does not fire after stop()')
    assert.equal(mockState.llmCalls.length, 0, 'no LLM turn after stop()')
    assert.equal(events.finalize.length, 1)
    assert.equal(events.termination.length, 1, 'a late STT final adds no second termination request')
})

// ---- Physical termination request ---------------------------------------------
// Ending the dialog is not ending the call. After its terminal transition the
// session asks the injected callback to end the physical call — once, with the
// reason the first trigger chose, and with a grace that covers whatever of the
// last phrase is still playing. The session knows nothing about channels: what
// happens to that request (kill, suppressed as already dead, refused) is the
// channel lifecycle's business and is covered in channel-lifecycle.test.js.

function endCallTurn(s, args = { qualification_status: 'qualified', lead_summary: 'ok' }) {
    mockState.llmReturn = { kind: 'function', name: 'end_call', args, callId: 'call-1' }
    return s._doTurn(false)
}

test('end_call finalizes once and requests physical termination once', async (t) => {
    resetMocks()
    const { s, events, cleanup } = makeSession()
    t.after(cleanup)

    await endCallTurn(s)

    assert.equal(s.state, 'ended')
    assert.equal(events.finalize.length, 1, 'finalized exactly once')
    assert.equal(events.finalize[0].reason, 'completed')
    assert.equal(s.terminalReason, 'completed')
    assert.equal(events.termination.length, 1, 'exactly one termination request')
    assert.equal(events.termination[0].reason, 'completed', 'the request carries the terminal reason')
})

test('the termination grace covers the remaining playback of the goodbye phrase', async (t) => {
    resetMocks()
    const { s, events, cleanup } = makeSession({ broadcastWav: async () => 4000 })
    t.after(cleanup)

    await endCallTurn(s)

    const { graceMs } = events.termination[0]
    // Playback was estimated at 4 s and started during this turn, so the grace is
    // the remainder plus the fixed margin. Bounded, not exact: the remainder is
    // measured against the wall clock, and the whole turn is synchronous here.
    assert.ok(graceMs > 4000, `grace ${graceMs} must outlast the estimated playback`)
    assert.ok(graceMs <= 5000, `grace ${graceMs} must not exceed playback plus the margin`)
})

test('a goodbye that never reached FreeSWITCH is not waited for', async (t) => {
    resetMocks()
    // playOrQueue returns null for a channel that already hung up.
    const { s, events, cleanup } = makeSession({ broadcastWav: async () => null })
    t.after(cleanup)

    await endCallTurn(s)

    assert.equal(events.termination.length, 1)
    assert.equal(events.termination[0].graceMs, 0, 'nothing is playing, so nothing is waited for')
})

test('a hangup during the final phrase wins the reason and still requests termination once', async (t) => {
    resetMocks()
    let releaseSynth = null
    mockState.synthGate = new Promise(resolve => { releaseSynth = resolve })
    let broadcasts = 0
    const { s, events, cleanup } = makeSession({
        broadcastWav: async () => { broadcasts++; return 1000 },
    })
    t.after(cleanup)

    const turn = endCallTurn(s)
    // The lead hangs up while the goodbye is still being synthesised. This is what
    // the lifecycle's releaseChannel does on CHANNEL_HANGUP_COMPLETE.
    s.stop()
    releaseSynth()
    await turn

    assert.equal(broadcasts, 0, 'the goodbye is never handed to FreeSWITCH')
    assert.equal(events.finalize.length, 1, 'finalized exactly once')
    assert.equal(events.finalize[0].reason, 'closed', 'the hangup got there first and owns the reason')
    assert.equal(s.terminalReason, 'closed')
    assert.equal(events.termination.length, 1, 'exactly one termination request')
    assert.equal(events.termination[0].reason, 'closed')
    assert.equal(events.termination[0].graceMs, 0)
})

test('concurrent end_call and stop(): the first reason wins, one finalize, one request', async (t) => {
    resetMocks()
    const { s, events, cleanup } = makeSession()
    t.after(cleanup)

    await endCallTurn(s)
    s.stop()
    s.stop('max_duration')
    s._end('completed')

    assert.equal(s.terminalReason, 'completed', 'later triggers cannot relabel the terminal reason')
    assert.equal(events.finalize.length, 1)
    assert.equal(events.finalize[0].reason, 'completed')
    assert.equal(events.termination.length, 1, 'at most one physical termination per session')
})

test('a WS close while the channel is still alive requests termination', (t) => {
    resetMocks()
    const { s, events, cleanup } = makeSession()
    t.after(cleanup)

    s._setState('listening')
    s.stop()

    assert.equal(events.finalize[0].reason, 'closed')
    assert.equal(events.termination.length, 1, 'a bridge-side close still has to end the call')
    assert.deepEqual(events.termination[0], { reason: 'closed', graceMs: 0 })
})

test('transfer_to_manager stays outside the termination path', async (t) => {
    resetMocks()
    const { s, events, cleanup } = makeSession()
    t.after(cleanup)

    await s._dispatchTool('transfer_to_manager', { reason: 'лид просит менеджера' }, 'call-2')

    assert.equal(s.state, 'ended')
    assert.equal(events.finalize.length, 1)
    assert.equal(events.finalize[0].reason, 'transferred')
    // C1a must not change what the lead experiences after «оставайтесь на линии»:
    // the honest semantics of that promise are a separate bounded follow-up.
    assert.deepEqual(events.termination, [], 'a transfer does not end the channel here')
})

test('a finalize that throws still ends the physical call', async (t) => {
    resetMocks()
    const { s, events, cleanup } = makeSession({
        onFinalize: () => { throw new Error('CRM unreachable') },
    })
    t.after(cleanup)

    await endCallTurn(s)

    assert.equal(s.state, 'ended')
    assert.equal(events.termination.length, 1, 'a CRM failure must not leave a live call on the line')
    assert.equal(events.termination[0].reason, 'completed')
})

test('a termination request that throws does not break the terminal transition', async (t) => {
    resetMocks()
    const { s, events, cleanup } = makeSession({
        requestTermination: () => { throw new Error('esl unavailable') },
    })
    t.after(cleanup)

    await endCallTurn(s)

    assert.equal(s.state, 'ended')
    assert.equal(events.finalize.length, 1, 'the canonical finalize already happened and stands')
    assert.equal(s.terminalReason, 'completed', 'the chosen reason is unchanged by a telephony failure')
})

test('a session with no termination callback behaves exactly as before', async (t) => {
    resetMocks()
    // The bridge's own audio-only mode and every existing caller that does not
    // pass the callback must keep working.
    const { s, events, cleanup } = makeSession({ requestTermination: undefined })
    t.after(cleanup)

    await endCallTurn(s)

    assert.equal(s.state, 'ended')
    assert.equal(events.finalize.length, 1)
})

// ---- Hard duration cap, session side ------------------------------------------
// The cap itself lives in the channel lifecycle (channel-lifecycle.test.js). What
// the session owes it: a terminal transition under the cap's reason, exactly one
// finalize, no termination request of its own — the lifecycle sends the hangup —
// and no way for late work to come back afterwards.

test('stop("max_duration") finalizes once under that reason and asks for no hangup', (t) => {
    resetMocks()
    const { s, events, cleanup } = makeSession()
    t.after(cleanup)

    s._setState('listening')
    s.stop('max_duration')

    assert.equal(s.state, 'ended')
    assert.equal(s.terminalReason, 'max_duration')
    assert.equal(events.finalize.length, 1, 'finalized exactly once')
    assert.equal(events.finalize[0].reason, 'max_duration', 'the CRM learns why the call was cut')
    assert.deepEqual(events.termination, [],
        'the channel lifecycle owns this hangup; asking from here would risk a second one')
})

test('a cap that lands together with end_call does not relabel the conversation', async (t) => {
    resetMocks()
    const { s, events, cleanup } = makeSession()
    t.after(cleanup)

    mockState.llmReturn = { kind: 'function', name: 'end_call', args: { qualification_status: 'qualified', lead_summary: 'ok' }, callId: 'c1' }
    await s._doTurn(false)
    s.stop('max_duration')

    assert.equal(s.terminalReason, 'completed', 'first writer wins: the bot did finish the conversation')
    assert.equal(events.finalize.length, 1)
    assert.equal(events.finalize[0].reason, 'completed')
    assert.equal(events.termination.length, 1, 'and its goodbye termination request stands alone')
    assert.equal(events.termination[0].reason, 'completed')
})

test('a cap during an in-flight turn lets nothing come back afterwards', async (t) => {
    resetMocks()
    let releaseLlm = null
    mockState.llmReturn = new Promise(resolve => {
        releaseLlm = () => resolve({ kind: 'function', name: 'save_lead_data', args: { field: 'city', value: 'late' }, callId: 'c2' })
    })
    let broadcasts = 0
    const { s, events, cleanup } = makeSession({ broadcastWav: async () => { broadcasts++; return 1000 } })
    t.after(cleanup)

    const turn = s._doTurn(false)
    s.stop('max_duration')
    releaseLlm()
    await turn
    await s._onSttFinal('а можно ещё вопрос')

    assert.equal(events.finalize.length, 1, 'one finalize')
    assert.equal(events.finalize[0].reason, 'max_duration')
    assert.equal(broadcasts, 0, 'no audio after the cut')
    assert.deepEqual(s.leadData, {}, 'no tool call applied after the cut')
    assert.deepEqual(events.transcript, [], 'no transcript item after the cut')
    assert.deepEqual(events.termination, [], 'and still no termination request from the session')
})

test('a repeated cap stop finalizes only once', (t) => {
    resetMocks()
    const { s, events, cleanup } = makeSession()
    t.after(cleanup)

    s._setState('listening')
    s.stop('max_duration')
    s.stop('max_duration')
    s.stop()

    assert.equal(events.finalize.length, 1)
    assert.equal(s.terminalReason, 'max_duration')
    assert.deepEqual(events.termination, [])
})
