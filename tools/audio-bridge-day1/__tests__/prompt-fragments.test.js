// Unit regression for the Prompt Fragment Layer v1 (PR #63).
//
// Locks: backward-compat fallback, required-slot validation,
// deterministic composition order, version extraction for measurement.
//
// Run: `node --test __tests__/prompt-fragments.test.js`

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
    buildConversationPrompt,
    hasValidFragments,
    getFragmentVersions,
    isValidFragment,
    REQUIRED_SLOTS,
    OPTIONAL_SLOTS,
    ALL_SLOTS,
} = require('../prompt-fragments')

// ── tiny stub legacy builder ────────────────────────────────────────

function captureLegacy() {
    const calls = []
    const fn = (scenario) => {
        calls.push(scenario)
        return '<<LEGACY_PROMPT>>'
    }
    fn.calls = calls
    return fn
}

const VALID_FRAGMENTS = {
    greeting:            { id: 'g-v1', version: 1, text: '[GREETING TEXT]' },
    qualification_intro: { id: 'qi-v1', version: 1, text: '[QUAL INTRO TEXT]' },
    recovery:            { id: 'r-v1', version: 1, text: '[RECOVERY TEXT]' },
    transfer_framing:    { id: 'tf-v1', version: 1, text: '[TRANSFER TEXT]' },
}

const SAMPLE_SCENARIO = {
    id: 'sc1',
    name: 'Test',
    questions: [{ text: 'Есть права?' }, { text: 'Какой стаж?' }],
    fragments: VALID_FRAGMENTS,
}

// ════════════════════════════════════════════════════════════════════
// Surface contract
// ════════════════════════════════════════════════════════════════════

test('REQUIRED_SLOTS = 4 architect-mandated values', () => {
    assert.deepEqual([...REQUIRED_SLOTS].sort(), [
        'greeting',
        'qualification_intro',
        'recovery',
        'transfer_framing',
    ])
})

test('OPTIONAL_SLOTS = 2 architect-mandated values', () => {
    assert.deepEqual([...OPTIONAL_SLOTS].sort(), [
        'closing',
        'objection_soft',
    ])
})

test('All slot sets are frozen', () => {
    assert.equal(Object.isFrozen(REQUIRED_SLOTS), true)
    assert.equal(Object.isFrozen(OPTIONAL_SLOTS), true)
    assert.equal(Object.isFrozen(ALL_SLOTS), true)
})

// ════════════════════════════════════════════════════════════════════
// isValidFragment
// ════════════════════════════════════════════════════════════════════

test('isValidFragment: complete row → true', () => {
    assert.equal(isValidFragment({ id: 'x', version: 1, text: 'hi' }), true)
    assert.equal(isValidFragment({ id: 'x', version: 'v1', text: 'hi', hypothesis: 'h' }), true)
})

test('isValidFragment: empty id / text → false', () => {
    assert.equal(isValidFragment({ id: '', version: 1, text: 'hi' }), false)
    assert.equal(isValidFragment({ id: 'x', version: 1, text: '' }), false)
    assert.equal(isValidFragment({ id: 'x', version: 1, text: '   ' }), false)
})

test('isValidFragment: missing version → false', () => {
    assert.equal(isValidFragment({ id: 'x', text: 'hi' }), false)
})

test('isValidFragment: null / undefined / wrong shape → false', () => {
    assert.equal(isValidFragment(null), false)
    assert.equal(isValidFragment(undefined), false)
    assert.equal(isValidFragment('hi'), false)
    assert.equal(isValidFragment([]), false)
})

// ════════════════════════════════════════════════════════════════════
// hasValidFragments — gating for fragments-vs-legacy path
// ════════════════════════════════════════════════════════════════════

test('hasValidFragments: all 4 required present → true', () => {
    assert.equal(hasValidFragments(SAMPLE_SCENARIO), true)
})

test('hasValidFragments: missing one required slot → false', () => {
    const noRecovery = {
        ...SAMPLE_SCENARIO,
        fragments: { ...VALID_FRAGMENTS, recovery: undefined },
    }
    assert.equal(hasValidFragments(noRecovery), false)
})

test('hasValidFragments: malformed required slot → false', () => {
    const badText = {
        ...SAMPLE_SCENARIO,
        fragments: { ...VALID_FRAGMENTS, greeting: { id: 'x', version: 1, text: '' } },
    }
    assert.equal(hasValidFragments(badText), false)
})

test('hasValidFragments: null / undefined / non-object → false', () => {
    assert.equal(hasValidFragments(null), false)
    assert.equal(hasValidFragments(undefined), false)
    assert.equal(hasValidFragments({ fragments: null }), false)
    assert.equal(hasValidFragments({ fragments: 'oops' }), false)
    assert.equal(hasValidFragments({ fragments: [] }), false)
})

// ════════════════════════════════════════════════════════════════════
// buildConversationPrompt — legacy fallback
// ════════════════════════════════════════════════════════════════════

test('buildConversationPrompt: no fragments → calls legacyBuilder', () => {
    const legacy = captureLegacy()
    const scenario = { id: 'sc', questions: [], systemPrompt: 'X' }
    const out = buildConversationPrompt({ scenario, legacyBuilder: legacy })
    assert.equal(out, '<<LEGACY_PROMPT>>')
    assert.equal(legacy.calls.length, 1)
    assert.equal(legacy.calls[0], scenario, 'legacy receives the scenario verbatim')
})

test('buildConversationPrompt: empty fragments object → legacy fallback', () => {
    const legacy = captureLegacy()
    buildConversationPrompt({ scenario: { fragments: {} }, legacyBuilder: legacy })
    assert.equal(legacy.calls.length, 1)
})

test('buildConversationPrompt: missing required slot → legacy fallback', () => {
    const legacy = captureLegacy()
    const scenario = {
        ...SAMPLE_SCENARIO,
        fragments: { ...VALID_FRAGMENTS, recovery: undefined },
    }
    buildConversationPrompt({ scenario, legacyBuilder: legacy })
    assert.equal(legacy.calls.length, 1, 'falls back when required slot missing')
})

test('buildConversationPrompt: missing legacyBuilder + no fragments → empty string (defensive)', () => {
    const out = buildConversationPrompt({ scenario: { id: 'x' } })
    assert.equal(out, '')
})

// ════════════════════════════════════════════════════════════════════
// buildConversationPrompt — composition order + content
// ════════════════════════════════════════════════════════════════════

test('buildConversationPrompt: all 4 required texts present in output', () => {
    const out = buildConversationPrompt({
        scenario: SAMPLE_SCENARIO,
        legacyBuilder: () => '<<LEGACY>>',
    })
    assert.ok(out.includes('[GREETING TEXT]'))
    assert.ok(out.includes('[QUAL INTRO TEXT]'))
    assert.ok(out.includes('[RECOVERY TEXT]'))
    assert.ok(out.includes('[TRANSFER TEXT]'))
    assert.ok(!out.includes('<<LEGACY>>'), 'legacy NOT used when fragments valid')
})

test('buildConversationPrompt: composition order matches architect spec', () => {
    const out = buildConversationPrompt({
        scenario: SAMPLE_SCENARIO,
        legacyBuilder: () => '',
    })
    const idxGreeting   = out.indexOf('[GREETING TEXT]')
    const idxQualIntro  = out.indexOf('[QUAL INTRO TEXT]')
    const idxQuestions  = out.indexOf('Вопросы по порядку')
    const idxSpeech     = out.indexOf('Правила речи')
    const idxTransfer   = out.indexOf('[TRANSFER TEXT]')
    const idxRecovery   = out.indexOf('[RECOVERY TEXT]')

    // greeting < qual_intro < questions < speech_rules < transfer < recovery
    assert.ok(idxGreeting >= 0 && idxGreeting < idxQualIntro, 'greeting before qual_intro')
    assert.ok(idxQualIntro < idxQuestions, 'qual_intro before questions block')
    assert.ok(idxQuestions < idxSpeech, 'questions before speech rules')
    assert.ok(idxSpeech < idxTransfer, 'speech rules before transfer_framing')
    assert.ok(idxTransfer < idxRecovery, 'transfer_framing before recovery')
})

test('buildConversationPrompt: optional objection_soft INCLUDED when present', () => {
    const scenario = {
        ...SAMPLE_SCENARIO,
        fragments: {
            ...VALID_FRAGMENTS,
            objection_soft: { id: 'os-v1', version: 1, text: '[OBJECTION TEXT]' },
        },
    }
    const out = buildConversationPrompt({ scenario, legacyBuilder: () => '' })
    assert.ok(out.includes('[OBJECTION TEXT]'))
    // Order: transfer_framing before objection_soft before recovery
    const idxTransfer = out.indexOf('[TRANSFER TEXT]')
    const idxObj      = out.indexOf('[OBJECTION TEXT]')
    const idxRecovery = out.indexOf('[RECOVERY TEXT]')
    assert.ok(idxTransfer < idxObj && idxObj < idxRecovery)
})

test('buildConversationPrompt: optional objection_soft OMITTED when absent', () => {
    const out = buildConversationPrompt({
        scenario: SAMPLE_SCENARIO,
        legacyBuilder: () => '',
    })
    assert.ok(!out.includes('[OBJECTION TEXT]'))
})

test('buildConversationPrompt: optional closing INCLUDED when present', () => {
    const scenario = {
        ...SAMPLE_SCENARIO,
        fragments: {
            ...VALID_FRAGMENTS,
            closing: { id: 'cl-v1', version: 1, text: '[CLOSING TEXT]' },
        },
    }
    const out = buildConversationPrompt({ scenario, legacyBuilder: () => '' })
    assert.ok(out.includes('[CLOSING TEXT]'))
})

test('buildConversationPrompt: deterministic output (same scenario → same string)', () => {
    const a = buildConversationPrompt({ scenario: SAMPLE_SCENARIO, legacyBuilder: () => '' })
    const b = buildConversationPrompt({ scenario: SAMPLE_SCENARIO, legacyBuilder: () => '' })
    assert.equal(a, b)
})

test('buildConversationPrompt: questions block honours scenario.questions', () => {
    const out = buildConversationPrompt({
        scenario: SAMPLE_SCENARIO,
        legacyBuilder: () => '',
    })
    assert.ok(out.includes('1. Есть права?'))
    assert.ok(out.includes('2. Какой стаж?'))
})

test('buildConversationPrompt: outcomeSchema canonical hint appended when present', () => {
    const scenario = {
        ...SAMPLE_SCENARIO,
        outcomeSchema: { fields: [
            { key: 'hasLicenseB', type: 'boolean', required: true, label: 'Водительские права B' },
        ]},
    }
    const out = buildConversationPrompt({ scenario, legacyBuilder: () => '' })
    assert.ok(out.includes('Канонические поля для save_lead_data'))
    assert.ok(out.includes('hasLicenseB'))
})

test('buildConversationPrompt: end_call qualification_score nudge always present in fragmented path', () => {
    const out = buildConversationPrompt({ scenario: SAMPLE_SCENARIO, legacyBuilder: () => '' })
    assert.ok(out.includes('qualification_score 0-100'))
})

// ════════════════════════════════════════════════════════════════════
// getFragmentVersions — measurement hook
// ════════════════════════════════════════════════════════════════════

test('getFragmentVersions: returns null when no fragments', () => {
    assert.equal(getFragmentVersions({}), null)
    assert.equal(getFragmentVersions({ fragments: {} }), null)
    assert.equal(getFragmentVersions(null), null)
})

test('getFragmentVersions: returns slot → id@version map for required slots', () => {
    const v = getFragmentVersions(SAMPLE_SCENARIO)
    assert.deepEqual(v, {
        greeting:            'g-v1@1',
        qualification_intro: 'qi-v1@1',
        recovery:            'r-v1@1',
        transfer_framing:    'tf-v1@1',
    })
})

test('getFragmentVersions: includes optional slots when present', () => {
    const scenario = {
        ...SAMPLE_SCENARIO,
        fragments: {
            ...VALID_FRAGMENTS,
            objection_soft: { id: 'os-v1', version: 1, text: '[obj]' },
            closing:        { id: 'cl-v1', version: 'v1.2', text: '[cl]' },
        },
    }
    const v = getFragmentVersions(scenario)
    assert.equal(v.objection_soft, 'os-v1@1')
    assert.equal(v.closing,        'cl-v1@v1.2')
})

test('getFragmentVersions: malformed optional skipped silently', () => {
    const scenario = {
        ...SAMPLE_SCENARIO,
        fragments: {
            ...VALID_FRAGMENTS,
            objection_soft: { id: 'os', version: 1, text: '   ' },  // bad text
        },
    }
    const v = getFragmentVersions(scenario)
    assert.equal(v.objection_soft, undefined)
    // required slots still there
    assert.equal(v.greeting, 'g-v1@1')
})

// ════════════════════════════════════════════════════════════════════
// Defensive
// ════════════════════════════════════════════════════════════════════

test('buildConversationPrompt: NEVER throws on weird inputs', () => {
    buildConversationPrompt()
    buildConversationPrompt({})
    buildConversationPrompt({ scenario: null, legacyBuilder: null })
    buildConversationPrompt({ scenario: 42 })
})
