// Integration regression for the Greeting Optimization Layer (PR #62)
// inside CallSession.
//
// Drives session.start() against scenarios with / without greetingVariants
// and asserts:
//   1. With variants: variant picked, spoken directly, NO LLM round-trip
//      on greeting, variant_id in greeting_started event payload.
//   2. Without variants: legacy LLM-generated greeting (consults LLM).
//   3. Determinism: same callUuid → same variant.
//   4. Picked variant text appears in messages[] so subsequent LLM
//      turns see the right context.
//
// Run: `node --test __tests__/greeting-variants-integration.test.js`

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

const llmState = { calls: [] }

stub('../stt-router', { enabled: () => false, createSttSession: () => null })
stub('../tts-router', {
    enabled: () => true,
    synthesize: async () => Buffer.alloc(44),
})
stub('../llm-client', {
    enabled: () => true,
    buildSystemMessage: () => '(stub system prompt)',
    buildTools: () => [],
    chatTurn: async ({ messages }) => {
        llmState.calls.push({ messages: messages.map(m => ({ role: m.role, content: m.content })) })
        return { kind: 'text', content: '(legacy LLM-generated greeting)' }
    },
})

const { CallSession } = require('../call-session')

function resetLlmState() { llmState.calls = [] }

const VARIANTS = [
    { id: 'A', label: 'baseline', text: 'Здравствуйте! Это вариант A.' },
    { id: 'B', label: 'short',    text: 'Здравствуйте! Это B.' },
    { id: 'C', label: 'human',    text: 'Здравствуйте! Это вариант C.' },
]

function makeSession({ callUuid, scenario, ...overrides } = {}) {
    const events = { state: [], transcript: [], finalize: [], speak: [] }
    const s = new CallSession({
        callUuid: callUuid ?? `test-${Math.random().toString(36).slice(2, 8)}`,
        scenario: scenario ?? { id: 'sc1', name: 'No-variant scenario' },
        broadcastWav: async () => 500,
        onFinalize: r => events.finalize.push(r),
        onTranscriptItem: (role, text) => events.transcript.push({ role, text }),
        onState: state => events.state.push(state),
        onUserSpoke: () => {},
        ...overrides,
    })
    // Capture what _speak was called with so we can assert greeting text.
    const origSpeak = s._speak.bind(s)
    s._speak = async (text) => {
        events.speak.push(text)
        return origSpeak(text)
    }
    s.SILENCE_TIMEOUT_MS = 50
    return { s, events, cleanup: () => {
        try { s.stop() } catch {}
        if (s.silenceTimer) { clearTimeout(s.silenceTimer); s.silenceTimer = null }
        if (s.userPauseTimer) { clearTimeout(s.userPauseTimer); s.userPauseTimer = null }
    } }
}

// ════════════════════════════════════════════════════════════════════
// Scenario WITH variants — variant path taken, no LLM on greeting
// ════════════════════════════════════════════════════════════════════

test('scenario with variants → variant picked, spoken directly, NO LLM call', async () => {
    resetLlmState()
    const scenario = { id: 'sc1', name: 'AB Test', greetingVariants: VARIANTS }
    const { s, events, cleanup } = makeSession({ scenario })
    try {
        await s.start()
        assert.ok(s.greetingVariant, 'a variant was picked')
        assert.ok(['A', 'B', 'C'].includes(s.greetingVariant.id))
        assert.equal(events.speak.length, 1, 'exactly one speak — the greeting')
        assert.equal(events.speak[0], s.greetingVariant.text,
            'spoken text equals the picked variant')
        assert.equal(llmState.calls.length, 0,
            'LLM NOT consulted on greeting (deterministic path)')
    } finally { cleanup() }
})

test('greeting_started event carries variant_id', async () => {
    resetLlmState()
    const scenario = { id: 'sc1', name: 'AB', greetingVariants: VARIANTS }
    const { s, cleanup } = makeSession({ scenario })
    try {
        await s.start()
        const gs = s.events.find(e => e.type === 'greeting_started')
        assert.ok(gs)
        assert.equal(gs.payload.variant_id, s.greetingVariant.id)
        assert.ok(['A', 'B', 'C'].includes(gs.payload.variant_id))
    } finally { cleanup() }
})

test('picked variant text appears in messages[] so LLM sees context', async () => {
    resetLlmState()
    const scenario = { id: 'sc1', name: 'AB', greetingVariants: VARIANTS }
    const { s, cleanup } = makeSession({ scenario })
    try {
        await s.start()
        const assistantMsgs = s.messages.filter(m => m.role === 'assistant')
        assert.equal(assistantMsgs.length, 1)
        assert.equal(assistantMsgs[0].content, s.greetingVariant.text)
    } finally { cleanup() }
})

test('onTranscriptItem fires with assistant + variant text', async () => {
    resetLlmState()
    const scenario = { id: 'sc1', name: 'AB', greetingVariants: VARIANTS }
    const { s, events, cleanup } = makeSession({ scenario })
    try {
        await s.start()
        const assistantItems = events.transcript.filter(t => t.role === 'assistant')
        assert.equal(assistantItems.length, 1)
        assert.equal(assistantItems[0].text, s.greetingVariant.text)
    } finally { cleanup() }
})

// ════════════════════════════════════════════════════════════════════
// Determinism — same callUuid → same variant
// ════════════════════════════════════════════════════════════════════

test('same callUuid → same variant across separate sessions', async () => {
    resetLlmState()
    const scenario = { id: 'sc1', name: 'AB', greetingVariants: VARIANTS }
    const callUuid = 'stable-uuid-pr62-test'
    const picks = []
    for (let i = 0; i < 5; i++) {
        const { s, cleanup } = makeSession({ callUuid, scenario })
        try {
            await s.start()
            picks.push(s.greetingVariant.id)
        } finally { cleanup() }
    }
    assert.equal(new Set(picks).size, 1,
        `same callUuid mapped to ${picks.length} variants: ${picks.join(',')}`)
})

// ════════════════════════════════════════════════════════════════════
// Scenario WITHOUT variants — legacy LLM path
// ════════════════════════════════════════════════════════════════════

test('scenario without greetingVariants → legacy LLM greeting path', async () => {
    resetLlmState()
    const { s, events, cleanup } = makeSession({
        scenario: { id: 'sc1', name: 'Legacy', /* no greetingVariants */ },
    })
    try {
        await s.start()
        assert.equal(s.greetingVariant, null, 'no variant picked')
        assert.ok(llmState.calls.length >= 1, 'LLM consulted (legacy path)')
        // greeting_started.payload.variant_id is null when no variant picked.
        const gs = s.events.find(e => e.type === 'greeting_started')
        assert.equal(gs.payload.variant_id, null)
    } finally { cleanup() }
})

test('scenario with empty greetingVariants array → legacy LLM path', async () => {
    resetLlmState()
    const { s, cleanup } = makeSession({
        scenario: { id: 'sc1', name: 'Empty', greetingVariants: [] },
    })
    try {
        await s.start()
        assert.equal(s.greetingVariant, null)
        assert.ok(llmState.calls.length >= 1, 'LLM consulted')
    } finally { cleanup() }
})

// ════════════════════════════════════════════════════════════════════
// 3 variants over many UUIDs — distribution proves the hash spreads
// ════════════════════════════════════════════════════════════════════

test('many distinct callUuids exercise all 3 variants', async () => {
    resetLlmState()
    const scenario = { id: 'sc1', name: 'AB', greetingVariants: VARIANTS }
    const buckets = { A: 0, B: 0, C: 0 }
    for (let i = 0; i < 60; i++) {
        const callUuid = `pr62-test-${i}-${Math.random().toString(36).slice(2, 6)}`
        const { s, cleanup } = makeSession({ callUuid, scenario })
        try {
            await s.start()
            buckets[s.greetingVariant.id] += 1
        } finally { cleanup() }
    }
    for (const id of ['A', 'B', 'C']) {
        assert.ok(buckets[id] >= 5,
            `variant ${id} got ${buckets[id]} / 60 — distribution skewed`)
    }
})
