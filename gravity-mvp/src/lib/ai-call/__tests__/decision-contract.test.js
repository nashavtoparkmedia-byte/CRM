/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const {
    decisionFromQualification,
    parseAiCallDecision,
    validateAiCallDecision,
} = require('../decision-contract')

const valid = {
    kind: 'complete',
    nextAction: 'end_call',
    replyText: 'Спасибо за разговор.',
    qualification: 'qualified',
    extractedData: { city: 'Казань', experienceYears: 3, hasLicense: true },
    transferRequested: false,
    stopReason: 'scenario_complete',
    errors: [],
}

test('accepts the complete typed decision contract', () => {
    const result = validateAiCallDecision(valid)
    assert.equal(result.ok, true)
    assert.deepEqual(result.decision, valid)
})

test('returns a controlled failure for invalid provider JSON', () => {
    const result = parseAiCallDecision('{broken')
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'invalid_json')
    assert.equal(result.error.decision.kind, 'error')
    assert.equal(result.error.decision.nextAction, 'none')
})

test('rejects missing required fields and unsupported kinds', () => {
    const missing = validateAiCallDecision({ kind: 'complete' })
    assert.equal(missing.ok, false)
    assert.match(missing.error.detail, /missing_fields/)

    const unsupported = validateAiCallDecision({ ...valid, kind: 'invented' })
    assert.equal(unsupported.ok, false)
    assert.equal(unsupported.error.detail, 'unsupported_kind')
})

test('rejects an inconsistent transfer action', () => {
    const result = validateAiCallDecision({
        ...valid,
        kind: 'transfer',
        nextAction: 'transfer_to_manager',
        transferRequested: false,
    })
    assert.equal(result.ok, false)
    assert.equal(result.error.detail, 'transfer_action_mismatch')
})

test('maps a qualification payload to the stable decision contract', () => {
    const decision = decisionFromQualification({
        qualification_status: 'not_qualified',
        reason: 'Нет прав',
        lead_data: { hasLicense: false },
    })
    const result = validateAiCallDecision(decision)
    assert.equal(result.ok, true)
    assert.equal(result.decision.qualification, 'not_qualified')
    assert.deepEqual(result.decision.extractedData, { hasLicense: false })
})
