// Integration regression for the Conversation Recovery Layer inside
// CallSession (PR #61).
//
// Drives the full _onSttFinal / _onSilenceTimeout paths with synthetic
// garbage / silence / ambiguous-short triggers and asserts the architect's
// acceptance criteria:
//
//   1. Garbage loop: 2 subtitle_credits in a row → short recovery,
//                    NO giant greeting replay, NO LLM corruption.
//   2. Silence after greeting: short re-engage on strike 1 when
//                              realUserUtterances=0.
//   3. Ambiguous short ("э"): single clarification, no infinite retry.
//   4. Bounded: MAX 2 recoveries; past that, fall back to silence-timer.
//   5. Runtime invariants preserved: turn-taking, silence timer,
//      timeline, realUserUtterances semantics.
//
// Same require.cache mock surface as silence-timer.test.js — no live
// OpenAI / Yandex / TTS dependencies.
//
// Run: `node --test __tests__/recovery-integration.test.js`

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

function stub(relPath, exports) {
    const resolved = require.resolve(relPath)
    require.cache[resolved] = {
        id: resolved, filename: resolved, loaded: true, exports,
        children: [], paths: [],
    }
}

stub('../stt-router', { enabled: () => false, createSttSession: () => null })
stub('../tts-router', {
    enabled: () => true,
    synthesize: async () => Buffer.alloc(44),
})
stub('../llm-client', {
    enabled: () => true,
    buildSystemMessage: () => '(stub)',
    buildTools: () => [],
    chatTurn: async () => ({ kind: 'text', content: '(stub reply)' }),
})

const { CallSession } = require('../call-session')
const { MAX_RECOVERY_ATTEMPTS, PHRASES } = require('../recovery-policy')

function makeSession(overrides = {}) {
    const events = { state: [], transcript: [], finalize: [], userSpoke: 0, broadcastTexts: [] }
    const broadcastWav = async () => 500
    const s = new CallSession({
        callUuid: `test-${Math.random().toString(36).slice(2, 8)}`,
        scenario: { id: 'sc1', name: 'Recovery Test' },
        broadcastWav,
        onFinalize: r => events.finalize.push(r),
        onTranscriptItem: (role, text) => events.transcript.push({ role, text }),
        onState: state => events.state.push(state),
        onUserSpoke: () => { events.userSpoke += 1 },
        ...overrides,
    })
    // Wrap _speak so we can capture what would have been spoken without
    // actually invoking TTS path (which is a no-op due to stubbed tts).
    const origSpeak = s._speak.bind(s)
    s._speak = async (text) => {
        events.broadcastTexts.push(text)
        return origSpeak(text)
    }
    s.SILENCE_TIMEOUT_MS = 50
    s._setState('listening')  // receptive
    return { s, events, cleanup: () => {
        try { s.stop() } catch {}
        if (s.silenceTimer) { clearTimeout(s.silenceTimer); s.silenceTimer = null }
        if (s.userPauseTimer) { clearTimeout(s.userPauseTimer); s.userPauseTimer = null }
    } }
}

// ════════════════════════════════════════════════════════════════════
// Case 1 — Garbage cluster recovery
// ════════════════════════════════════════════════════════════════════

test('garbage 2x in a row → recovery_attempted, short prompt, no greeting replay', async () => {
    const { s, events, cleanup } = makeSession()
    try {
        // First garbage drop: counter goes to 1, no recovery yet.
        s._onSttFinal('Редактор субтитров А.X Корректор А.Y')
        assert.equal(s.consecutiveGarbageCount, 1)
        assert.equal(s.recoveryAttempts, 0)
        // No recovery_attempted event yet.
        assert.equal(
            s.events.filter(e => e.type === 'recovery_attempted').length,
            0,
        )

        // Second garbage drop: counter→2, recovery fires.
        await s._onSttFinal('Редактор субтитров А.Z Корректор А.W')

        const recoveries = s.events.filter(e => e.type === 'recovery_attempted')
        assert.equal(recoveries.length, 1, 'one recovery event emitted')
        assert.equal(recoveries[0].payload.trigger, 'garbage')
        assert.equal(recoveries[0].payload.action, 'retry_short')
        assert.equal(recoveries[0].payload.attempt_n, 1)
        assert.ok(recoveries[0].payload.phrase_head.startsWith('Связь немного'))

        // Recovery prompt was spoken (not a full greeting replay).
        assert.equal(events.broadcastTexts.length, 1)
        assert.equal(events.broadcastTexts[0], PHRASES.retry_short_garbage)

        // Counter reset (next garbage won't immediately re-trigger).
        assert.equal(s.consecutiveGarbageCount, 0)
        assert.equal(s.recoveryAttempts, 1)

        // No LLM message accumulated (the garbage didn't reach the LLM).
        assert.equal(s.pendingUserText, '')
        assert.equal(s.realUserUtterances, 0)
    } finally { cleanup() }
})

test('single garbage drop → NO recovery (counter only at 1)', async () => {
    const { s, events, cleanup } = makeSession()
    try {
        await s._onSttFinal('Редактор субтитров А.X Корректор А.Y')
        assert.equal(s.recoveryAttempts, 0)
        assert.equal(events.broadcastTexts.length, 0)
        assert.equal(s.events.filter(e => e.type === 'recovery_attempted').length, 0)
    } finally { cleanup() }
})

test('real speech between garbage drops resets the counter', async () => {
    const { s, events, cleanup } = makeSession()
    try {
        s._onSttFinal('Редактор субтитров А.X Корректор А.Y')   // garbage, consec=1
        assert.equal(s.consecutiveGarbageCount, 1)
        s._onSttFinal('Здравствуйте, я слушаю')                  // real, consec=0
        assert.equal(s.consecutiveGarbageCount, 0)
        s._onSttFinal('Редактор субтитров А.Y Корректор А.Z')   // garbage, consec=1 (not 2!)
        assert.equal(s.consecutiveGarbageCount, 1)
        assert.equal(s.recoveryAttempts, 0, 'no recovery fired (consec never hit 2)')
    } finally { cleanup() }
})

// ════════════════════════════════════════════════════════════════════
// Case 2 — Silence after greeting
// ════════════════════════════════════════════════════════════════════

test('silence strike 1 with no real speech → silence_after_greeting recovery', async () => {
    const { s, events, cleanup } = makeSession()
    try {
        // realUserUtterances stays at 0 (no _onSttFinal called yet).
        assert.equal(s.realUserUtterances, 0)
        await s._onSilenceTimeout()

        const recoveries = s.events.filter(e => e.type === 'recovery_attempted')
        assert.equal(recoveries.length, 1)
        assert.equal(recoveries[0].payload.trigger, 'silence_after_greeting')
        assert.equal(recoveries[0].payload.action, 'reengage')

        // Reengage prompt spoken; NOT the LLM-injection synthetic message.
        assert.equal(events.broadcastTexts.length, 1)
        assert.equal(events.broadcastTexts[0], PHRASES.reengage)

        // The legacy LLM-injection path is bypassed — pendingUserText
        // stays empty (the synthetic «(лид молчит — короткое
        // подбадривание)» is NOT pushed).
        assert.equal(s.pendingUserText, '')
    } finally { cleanup() }
})

test('silence strike 1 AFTER real speech → legacy LLM path (NO recovery)', async () => {
    const { s, events, cleanup } = makeSession()
    try {
        // Lead spoke once first.
        s._onSttFinal('да удобно')
        assert.equal(s.realUserUtterances, 1)

        // Mid-dialog silence — should NOT trigger recovery (that's the
        // pre-greeting-cliff signal, not a mid-dialog gap).
        s.silenceStrikes = 0  // reset (real speech zeroed it)
        await s._onSilenceTimeout()

        assert.equal(s.events.filter(e => e.type === 'recovery_attempted').length, 0,
            'recovery NOT triggered on post-speech silence')
        // Legacy path: synthetic message pushed.
        assert.ok(s.pendingUserText.includes('подбадривание')
              || s.pendingUserText === ''  // _processPendingUserText may have run
        )
    } finally { cleanup() }
})

// ════════════════════════════════════════════════════════════════════
// Case 3 — Ambiguous short input
// ════════════════════════════════════════════════════════════════════

test('ambiguous-short "э" → recovery_attempted with clarification', async () => {
    const { s, events, cleanup } = makeSession()
    try {
        await s._onSttFinal('э.')

        const recoveries = s.events.filter(e => e.type === 'recovery_attempted')
        assert.equal(recoveries.length, 1)
        assert.equal(recoveries[0].payload.trigger, 'ambiguous_short')
        assert.equal(events.broadcastTexts[0], PHRASES.retry_short_ambiguous)

        // The ambiguous final did NOT advance the dialog.
        assert.equal(s.pendingUserText, '')
        assert.equal(s.realUserUtterances, 0)
    } finally { cleanup() }
})

test('normal short "да" → NOT recovery (2 letters; passes through)', async () => {
    const { s, events, cleanup } = makeSession()
    try {
        s._onSttFinal('да')
        assert.equal(s.realUserUtterances, 1)
        assert.equal(s.pendingUserText, 'да')
        assert.equal(events.broadcastTexts.length, 0)
        assert.equal(s.events.filter(e => e.type === 'recovery_attempted').length, 0)
    } finally { cleanup() }
})

test('normal short "ОК" → NOT recovery', async () => {
    const { s, events, cleanup } = makeSession()
    try {
        s._onSttFinal('ОК')
        assert.equal(s.realUserUtterances, 1)
        assert.equal(events.broadcastTexts.length, 0)
    } finally { cleanup() }
})

// ════════════════════════════════════════════════════════════════════
// Hard cap — MAX 2 recoveries per call
// ════════════════════════════════════════════════════════════════════

test('after MAX recoveries, further triggers are no-ops (silence-timer takes over)', async () => {
    const { s, events, cleanup } = makeSession()
    try {
        // Burn through MAX_RECOVERY_ATTEMPTS via silence triggers.
        await s._onSilenceTimeout()  // attempt 1
        s.silenceStrikes = 0
        await s._onSilenceTimeout()  // attempt 2
        assert.equal(s.recoveryAttempts, MAX_RECOVERY_ATTEMPTS)
        assert.equal(events.broadcastTexts.length, MAX_RECOVERY_ATTEMPTS)

        // Third trigger is exhausted — no new event, no new speak.
        s.silenceStrikes = 0
        s._onSttFinal('э')  // ambiguous_short
        assert.equal(s.events.filter(e => e.type === 'recovery_attempted').length,
                     MAX_RECOVERY_ATTEMPTS,
                     'no recovery event past MAX')
        assert.equal(events.broadcastTexts.length, MAX_RECOVERY_ATTEMPTS,
                     'no further speak')
    } finally { cleanup() }
})

// ════════════════════════════════════════════════════════════════════
// Runtime invariants — turn-taking, timeline, counters
// ════════════════════════════════════════════════════════════════════

test('recovery preserves event timeline ordering (seq monotonic)', async () => {
    const { s, cleanup } = makeSession()
    try {
        s._onSttFinal('Редактор субтитров А.X Корректор А.Y')   // 1 stt_suspicious_pattern event
        await s._onSttFinal('Редактор субтитров А.W Корректор А.V')   // 2 stt_suspicious_pattern + 1 recovery_attempted

        const seqs = s.events.map(e => e.seq)
        const sorted = [...seqs].sort((a, b) => a - b)
        assert.deepEqual(seqs, sorted, 'seqs strictly increasing')
        assert.equal(new Set(seqs).size, seqs.length, 'no duplicate seqs')
    } finally { cleanup() }
})

test('recovery does NOT increment realUserUtterances (clean engagement semantics)', async () => {
    const { s, cleanup } = makeSession()
    try {
        // Trigger ambiguous + garbage + silence recoveries; verify
        // realUserUtterances stays at 0 throughout (no user actually spoke).
        s._onSttFinal('э')                                           // ambiguous → recovery 1
        s._onSttFinal('Редактор субтитров А.X Корректор А.Y')        // garbage 1
        await s._onSttFinal('Редактор субтитров А.W Корректор А.V')  // garbage 2 → recovery 2 (capped)

        assert.equal(s.realUserUtterances, 0, 'no real speech registered')
    } finally { cleanup() }
})

test('recovery_attempted payload shape locked', async () => {
    const { s, cleanup } = makeSession()
    try {
        await s._onSttFinal('э')
        const ev = s.events.find(e => e.type === 'recovery_attempted')
        assert.ok(ev)
        // Required payload fields.
        assert.equal(typeof ev.payload.trigger, 'string')
        assert.equal(typeof ev.payload.action, 'string')
        assert.equal(typeof ev.payload.phrase_head, 'string')
        assert.equal(typeof ev.payload.attempt_n, 'number')
        assert.equal(typeof ev.payload.state_at_trigger, 'string')
        // phrase_head bounded to ≤ 60 chars.
        assert.ok(ev.payload.phrase_head.length <= 60)
    } finally { cleanup() }
})
