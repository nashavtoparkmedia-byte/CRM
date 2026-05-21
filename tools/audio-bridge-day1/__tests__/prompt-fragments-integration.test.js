// Integration regression for the Prompt Fragment Layer (PR #63)
// inside CallSession.
//
// Locks the wiring contract:
//   - Scenario with valid fragments → greeting_started event payload
//     carries fragment_versions (slot → id@version map).
//   - Scenario without fragments → fragment_versions = null (legacy path).
//   - Scenario with partial/invalid fragments → fragment_versions = null
//     (composer falls back to legacy; getFragmentVersions returns null).
//
// Runtime invariants (turn-taking, silence timer, recovery, greeting
// variants) are unchanged — covered by their own integration suites.
// This test only verifies the new payload field.
//
// Run: `node --test __tests__/prompt-fragments-integration.test.js`

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
    buildSystemMessage: () => '(stub system prompt)',
    buildTools: () => [],
    chatTurn: async () => ({ kind: 'text', content: '(stub reply)' }),
})

const { CallSession } = require('../call-session')

const VALID_FRAGMENTS = {
    greeting:            { id: 'g-v1',  version: 1, text: '[GREETING]' },
    qualification_intro: { id: 'qi-v1', version: 1, text: '[QUAL INTRO]' },
    recovery:            { id: 'r-v1',  version: 1, text: '[RECOVERY]' },
    transfer_framing:    { id: 'tf-v1', version: 1, text: '[TRANSFER]' },
}

function makeSession({ scenario } = {}) {
    const events = { state: [], transcript: [], finalize: [] }
    const s = new CallSession({
        callUuid: `test-${Math.random().toString(36).slice(2, 8)}`,
        scenario,
        broadcastWav: async () => 500,
        onFinalize: r => events.finalize.push(r),
        onTranscriptItem: (role, text) => events.transcript.push({ role, text }),
        onState: state => events.state.push(state),
        onUserSpoke: () => {},
    })
    s.SILENCE_TIMEOUT_MS = 50
    return { s, events, cleanup: () => {
        try { s.stop() } catch {}
        if (s.silenceTimer) { clearTimeout(s.silenceTimer); s.silenceTimer = null }
        if (s.userPauseTimer) { clearTimeout(s.userPauseTimer); s.userPauseTimer = null }
    } }
}

// ════════════════════════════════════════════════════════════════════
// Scenario WITH valid fragments → fragment_versions populated
// ════════════════════════════════════════════════════════════════════

test('scenario with valid fragments → greeting_started carries fragment_versions', async () => {
    const scenario = { id: 'sc1', name: 'Fragmented', fragments: VALID_FRAGMENTS }
    const { s, cleanup } = makeSession({ scenario })
    try {
        await s.start()
        const gs = s.events.find(e => e.type === 'greeting_started')
        assert.ok(gs)
        assert.ok(gs.payload.fragment_versions, 'fragment_versions present')
        assert.equal(gs.payload.fragment_versions.greeting, 'g-v1@1')
        assert.equal(gs.payload.fragment_versions.qualification_intro, 'qi-v1@1')
        assert.equal(gs.payload.fragment_versions.recovery, 'r-v1@1')
        assert.equal(gs.payload.fragment_versions.transfer_framing, 'tf-v1@1')
    } finally { cleanup() }
})

test('optional fragments present → versions map includes them', async () => {
    const scenario = {
        id: 'sc1',
        fragments: {
            ...VALID_FRAGMENTS,
            objection_soft: { id: 'os-v1', version: 2, text: '[OBJ]' },
            closing:        { id: 'cl-v1', version: 'v1.3', text: '[CL]' },
        },
    }
    const { s, cleanup } = makeSession({ scenario })
    try {
        await s.start()
        const gs = s.events.find(e => e.type === 'greeting_started')
        assert.equal(gs.payload.fragment_versions.objection_soft, 'os-v1@2')
        assert.equal(gs.payload.fragment_versions.closing,        'cl-v1@v1.3')
    } finally { cleanup() }
})

// ════════════════════════════════════════════════════════════════════
// Backward compat — null when no fragments / partial fragments
// ════════════════════════════════════════════════════════════════════

test('scenario without fragments → fragment_versions = null', async () => {
    const scenario = { id: 'sc1', name: 'Legacy', /* no fragments */ }
    const { s, cleanup } = makeSession({ scenario })
    try {
        await s.start()
        const gs = s.events.find(e => e.type === 'greeting_started')
        assert.equal(gs.payload.fragment_versions, null)
    } finally { cleanup() }
})

test('scenario with empty fragments object → fragment_versions = null', async () => {
    const { s, cleanup } = makeSession({ scenario: { id: 'sc', fragments: {} } })
    try {
        await s.start()
        const gs = s.events.find(e => e.type === 'greeting_started')
        assert.equal(gs.payload.fragment_versions, null)
    } finally { cleanup() }
})

test('scenario missing a required slot → fragment_versions = null (legacy path)', async () => {
    const scenario = {
        id: 'sc1',
        fragments: { ...VALID_FRAGMENTS, recovery: undefined },
    }
    const { s, cleanup } = makeSession({ scenario })
    try {
        await s.start()
        const gs = s.events.find(e => e.type === 'greeting_started')
        assert.equal(gs.payload.fragment_versions, null,
            'partial fragments → legacy path → null in payload')
    } finally { cleanup() }
})

test('scenario with malformed required slot text → fragment_versions = null', async () => {
    const scenario = {
        id: 'sc1',
        fragments: {
            ...VALID_FRAGMENTS,
            greeting: { id: 'g-v1', version: 1, text: '   ' },  // empty text
        },
    }
    const { s, cleanup } = makeSession({ scenario })
    try {
        await s.start()
        const gs = s.events.find(e => e.type === 'greeting_started')
        assert.equal(gs.payload.fragment_versions, null)
    } finally { cleanup() }
})

// ════════════════════════════════════════════════════════════════════
// Greeting variant (PR #62) and fragments coexist
// ════════════════════════════════════════════════════════════════════

test('greeting variant + fragments coexist in greeting_started payload', async () => {
    const scenario = {
        id: 'sc1',
        fragments: VALID_FRAGMENTS,
        greetingVariants: [
            { id: 'A', text: 'Hi from variant A.' },
            { id: 'B', text: 'Hi from variant B.' },
        ],
    }
    const { s, cleanup } = makeSession({ scenario })
    try {
        await s.start()
        const gs = s.events.find(e => e.type === 'greeting_started')
        // Both attribution fields populated, independently.
        assert.ok(['A', 'B'].includes(gs.payload.variant_id),
            'variant_id from PR #62 still set')
        assert.ok(gs.payload.fragment_versions,
            'fragment_versions from PR #63 also set')
        assert.equal(gs.payload.fragment_versions.greeting, 'g-v1@1')
    } finally { cleanup() }
})
