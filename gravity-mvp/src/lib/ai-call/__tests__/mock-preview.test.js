/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const { createPreviewScenario } = require('../scenario-preview.ts')
const { runPreviewMock } = require('../mock-preview.ts')

function run(type, mode = 'normal', answer = 'Да, готов обсудить условия') {
    return runPreviewMock({
        scenario: createPreviewScenario(type),
        phone: '+79990000001',
        contactName: 'Тестовый контакт',
        answers: [answer],
        mode,
    })
}

test('qualification completes with transcript, extracted data and deterministic events', () => {
    const first = run('qualification')
    const retry = run('qualification')
    assert.equal(first.decision.qualification, 'qualified')
    assert.ok(first.transcript.length >= 4)
    assert.ok(Object.keys(first.extractedData).length > 0)
    assert.deepEqual(first.events, retry.events)
    assert.equal(new Set(first.events.map((event) => event.key)).size, first.events.length)
})

test('churn and survey return product-specific results', () => {
    const churn = run('churn', 'normal', 'Вернусь, если обсудим новые условия')
    const survey = run('survey', 'normal', 'Оценка 9, всё хорошо')
    assert.equal(churn.transfer.requested, true)
    assert.equal(survey.transfer.requested, false)
    assert.match(survey.outcome, /Опрос/)
})

test('explicit transfer mode prepares handoff but never performs SIP transfer', () => {
    const result = run('survey', 'transfer', 'Оценка 10')
    assert.equal(result.decision.nextAction, 'transfer_to_manager')
    assert.equal(result.transfer.target, 'Дежурный менеджер проекта')
    assert.equal(result.events.some((event) => event.type === 'sip_transfer'), false)
})

test('invalid AI output enters a controlled failed state and stops', () => {
    const result = run('qualification', 'invalid-output')
    assert.equal(result.decision.kind, 'failed')
    assert.equal(result.decision.nextAction, 'none')
    assert.equal(result.decision.validationErrors.length, 1)
    assert.equal(result.currentStep, 'failed')
})
