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
    synthesize: async () => Buffer.alloc(44),
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
    const events = { state: [], transcript: [], finalize: [] }
    const s = new CallSession({
        callUuid: `test-${Math.random().toString(36).slice(2, 8)}`,
        scenario: {},
        broadcastWav: async () => 1000, // estimated playback ms
        onFinalize: r => events.finalize.push(r),
        onTranscriptItem: (role, text) => events.transcript.push({ role, text }),
        onState: state => events.state.push(state),
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
