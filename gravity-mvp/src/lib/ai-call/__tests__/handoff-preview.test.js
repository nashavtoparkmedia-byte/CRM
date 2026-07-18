/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const { createPreviewScenario } = require('../scenario-preview.ts')
const { runPreviewMock } = require('../mock-preview.ts')
const { buildHandoffPreview } = require('../handoff-preview.ts')

test('transfer preview exposes reason, target, collected data and fallback', () => {
    const run = runPreviewMock({
        scenario: createPreviewScenario('qualification'),
        phone: '+79990000001',
        contactName: 'Анна',
        answers: ['Готов выйти завтра'],
        mode: 'transfer',
    })
    const handoff = buildHandoffPreview(run)
    assert.equal(handoff.state, 'transferring')
    assert.ok(handoff.reason)
    assert.ok(handoff.target)
    assert.ok(handoff.summary)
    assert.ok(handoff.unavailableFallback)
    assert.equal(handoff.liveSipExecuted, false)
})

test('completed mock has no handoff side effects', () => {
    const run = runPreviewMock({
        scenario: createPreviewScenario('survey'),
        phone: '+79990000003',
        contactName: 'Тест',
        answers: ['Оценка 10'],
    })
    const handoff = buildHandoffPreview(run)
    assert.equal(handoff.state, 'not_requested')
    assert.equal(handoff.liveSipExecuted, false)
})
