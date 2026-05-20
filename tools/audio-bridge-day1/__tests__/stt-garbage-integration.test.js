// Integration regression for the STT garbage filter inside CallSession.
//
// Drives the full _onSttFinal path with synthetic garbage + synthetic
// normal speech, and asserts the 4 acceptance criteria from the
// architect's brief:
//   1. Synthetic STT garbage → suppressed (no pendingUserText,
//      realUserUtterances stays at 0, no transcript callback)
//   2. Real normal speech → untouched (state advances normally)
//   3. Timeline: stt_suspicious_pattern event accumulated
//   4. Silence-timer machinery preserved (no regression on PR #59)
//
// Uses the same require.cache mock surface as silence-timer.test.js so
// the test runs without OPENAI / Yandex / TTS infrastructure.
//
// Run: `node --test __tests__/stt-garbage-integration.test.js`

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

// Mock stt/tts/llm BEFORE call-session is required.
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
    synthesize: async () => Buffer.alloc(44),
})
stub('../llm-client', {
    enabled: () => true,
    buildSystemMessage: () => '(stub system prompt)',
    buildTools: () => [],
    chatTurn: async () => ({ kind: 'text', content: '(stub bot reply)' }),
})

const { CallSession } = require('../call-session')

function makeSession(overrides = {}) {
    const events = { state: [], transcript: [], finalize: [], userSpoke: 0 }
    const s = new CallSession({
        callUuid: `test-${Math.random().toString(36).slice(2, 8)}`,
        scenario: { id: 'sc1', name: 'Test Scenario' },
        broadcastWav: async () => 500,
        onFinalize: r => events.finalize.push(r),
        onTranscriptItem: (role, text) => events.transcript.push({ role, text }),
        onState: state => events.state.push(state),
        onUserSpoke: () => { events.userSpoke += 1 },
        ...overrides,
    })
    s.SILENCE_TIMEOUT_MS = 50  // squash for fast suite teardown
    s._setState('listening')   // put session into receptive state
    return { s, events, cleanup: () => {
        try { s.stop() } catch {}
        if (s.silenceTimer) { clearTimeout(s.silenceTimer); s.silenceTimer = null }
        if (s.userPauseTimer) { clearTimeout(s.userPauseTimer); s.userPauseTimer = null }
    } }
}

// ════════════════════════════════════════════════════════════════════
// Acceptance 1: garbage is fully suppressed
// ════════════════════════════════════════════════════════════════════

test('subtitle_credits garbage: suppressed, no side-effects', () => {
    const { s, events, cleanup } = makeSession()
    try {
        s._onSttFinal('Редактор субтитров А.Синецкая Корректор А.Егорова')

        // 1. NO append to pendingUserText
        assert.equal(s.pendingUserText, '', 'pendingUserText untouched')
        // 2. NO counter increment
        assert.equal(s.realUserUtterances, 0, 'realUserUtterances stays at 0')
        // 3. NO transcript callback (manager UI doesn't see garbage)
        assert.equal(events.transcript.length, 0, 'onTranscriptItem not called')
        // 4. NO onUserSpoke (no premature 'active' state push to CRM)
        assert.equal(events.userSpoke, 0, 'onUserSpoke not called')
        // 5. NO LLM turn triggered (no userPauseTimer scheduled)
        assert.equal(s.userPauseTimer, null, 'userPauseTimer not scheduled')
    } finally { cleanup() }
})

test('emoji garbage: suppressed', () => {
    const { s, events, cleanup } = makeSession()
    try {
        s._onSttFinal('😎')
        assert.equal(s.pendingUserText, '')
        assert.equal(s.realUserUtterances, 0)
        assert.equal(events.transcript.length, 0)
    } finally { cleanup() }
})

test('pure-Latin garbage: suppressed', () => {
    const { s, events, cleanup } = makeSession()
    try {
        s._onSttFinal('Listen listen listen')
        assert.equal(s.pendingUserText, '')
        assert.equal(s.realUserUtterances, 0)
        assert.equal(events.transcript.length, 0)
    } finally { cleanup() }
})

// ════════════════════════════════════════════════════════════════════
// Acceptance 2: normal speech untouched
// ════════════════════════════════════════════════════════════════════

test('normal Russian "да удобно": passes through unchanged', () => {
    const { s, events, cleanup } = makeSession()
    try {
        s._onSttFinal('да удобно')
        assert.equal(s.pendingUserText, 'да удобно')
        assert.equal(s.realUserUtterances, 1)
        assert.equal(events.transcript.length, 1)
        assert.equal(events.transcript[0].text, 'да удобно')
        assert.equal(events.userSpoke, 1)
    } finally { cleanup() }
})

test('normal Russian sentence: state advances correctly', () => {
    const { s, events, cleanup } = makeSession()
    try {
        s._onSttFinal('Есть права категории B, стаж 5 лет')
        assert.equal(s.realUserUtterances, 1)
        assert.equal(events.transcript.length, 1)
        // first_real_user_speech event emitted (the 0→1 transition)
        const firstSpeechEvents = s.events.filter(e => e.type === 'first_real_user_speech')
        assert.equal(firstSpeechEvents.length, 1, 'one first_real_user_speech emitted')
        assert.ok(firstSpeechEvents[0].payload.first_phrase_head.startsWith('Есть права'))
    } finally { cleanup() }
})

test('mixed-script "iPhone уже есть" passes (FP floor)', () => {
    const { s, events, cleanup } = makeSession()
    try {
        s._onSttFinal('iPhone уже есть')
        assert.equal(s.realUserUtterances, 1)
        assert.equal(events.transcript.length, 1)
    } finally { cleanup() }
})

// ════════════════════════════════════════════════════════════════════
// Acceptance 3: timeline event captured
// ════════════════════════════════════════════════════════════════════

test('garbage emission: stt_suspicious_pattern event with full payload', () => {
    const { s, cleanup } = makeSession()
    try {
        s._onSttFinal('Редактор субтитров А.Семкин Корректор А.Егорова')

        const susEvents = s.events.filter(e => e.type === 'stt_suspicious_pattern')
        assert.equal(susEvents.length, 1, 'exactly one suspicious event emitted')
        const ev = susEvents[0]
        assert.equal(ev.payload.pattern_name, 'subtitle_credits')
        assert.equal(ev.payload.action, 'drop')
        assert.equal(ev.payload.source, 'final')
        assert.ok(typeof ev.payload.matched_text === 'string')
        assert.ok(ev.payload.matched_text.includes('Редактор'))
        // The event still has a monotonic seq.
        assert.ok(typeof ev.seq === 'number' && ev.seq > 0)
    } finally { cleanup() }
})

test('multiple garbage inputs: one event per drop', async () => {
    const { s, cleanup } = makeSession()
    try {
        // PR #61: _onSttFinal is async (recovery layer awaits TTS).
        // The 2nd consecutive garbage triggers a recovery that calls
        // _speak() and sets acceptSttAfter ~500ms in the future. To
        // assert all 3 STT drops are recorded as separate events
        // without waiting on real wall-clock for the grace window,
        // reset acceptSttAfter before each call. Production runs STT
        // asynchronously over time so this isn't an issue there.
        s.acceptSttAfter = 0
        await s._onSttFinal('Редактор субтитров А.X Корректор А.Y')
        s.acceptSttAfter = 0
        await s._onSttFinal('😎')
        s.acceptSttAfter = 0
        await s._onSttFinal('Yes ok ok')

        const susEvents = s.events.filter(e => e.type === 'stt_suspicious_pattern')
        assert.equal(susEvents.length, 3)
        // Each gets a unique seq.
        const seqs = susEvents.map(e => e.seq)
        assert.equal(new Set(seqs).size, 3, 'each event has unique seq')
        // Pattern names are correct.
        const names = susEvents.map(e => e.payload.pattern_name).sort()
        assert.deepEqual(names, ['non_russian_garbage', 'non_russian_garbage', 'subtitle_credits'])
    } finally { cleanup() }
})

// ════════════════════════════════════════════════════════════════════
// Acceptance 4: silence-timer machinery preserved
// ════════════════════════════════════════════════════════════════════

test('garbage drop does NOT reset silenceStrikes (silence-timer can still end the call)', () => {
    const { s, cleanup } = makeSession()
    try {
        s.silenceStrikes = 1  // pretend strike 1 already fired
        s._onSttFinal('Редактор субтитров А.X Корректор А.Y')
        // After garbage drop, strikes stay at 1 — silence-timer still has
        // strike 2 to fire if no real speech comes in.
        assert.equal(s.silenceStrikes, 1,
            'silenceStrikes preserved — call can terminate via silence-timeout')
    } finally { cleanup() }
})

test('mixed garbage + real speech: only real speech advances the dialog', () => {
    const { s, events, cleanup } = makeSession()
    try {
        s._onSttFinal('Редактор субтитров А.X Корректор А.Y')   // dropped
        s._onSttFinal('Да, я слушаю')                            // accepted
        s._onSttFinal('😎')                                       // dropped

        assert.equal(s.realUserUtterances, 1, 'only the real utterance counted')
        assert.equal(events.transcript.length, 1)
        assert.equal(events.transcript[0].text, 'Да, я слушаю')

        // Timeline shows 2 garbage drops + 1 first_real_user_speech.
        const sus = s.events.filter(e => e.type === 'stt_suspicious_pattern')
        const firstSpeech = s.events.filter(e => e.type === 'first_real_user_speech')
        assert.equal(sus.length, 2)
        assert.equal(firstSpeech.length, 1)
    } finally { cleanup() }
})

// ════════════════════════════════════════════════════════════════════
// Defensive: classifier never throws even on weird inputs
// ════════════════════════════════════════════════════════════════════

test('whitespace-only STT final: handled by existing empty-check, no classifier crash', () => {
    const { s, cleanup } = makeSession()
    try {
        s._onSttFinal('   ')
        assert.equal(s.realUserUtterances, 0)
        assert.equal(s.events.filter(e => e.type === 'stt_suspicious_pattern').length, 0,
            'no suspicious event for empty-after-trim')
    } finally { cleanup() }
})
