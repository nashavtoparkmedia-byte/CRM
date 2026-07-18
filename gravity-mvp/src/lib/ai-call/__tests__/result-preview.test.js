/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const { createPreviewScenario } = require('../scenario-preview.ts')
const { runPreviewMock } = require('../mock-preview.ts')
const { managerActionForResult, resultTone } = require('../result-preview.ts')

test('result action differs for qualification, churn and survey', () => {
    const actions = ['qualification', 'churn', 'survey'].map((type) => {
        const result = runPreviewMock({
            scenario: createPreviewScenario(type),
            phone: '+79990000003',
            contactName: 'Тест',
            answers: [type === 'survey' ? 'Оценка 10' : 'Нет, спасибо'],
        })
        return managerActionForResult(type, result)
    })
    assert.equal(new Set(actions).size, 3)
})

test('failure and transfer have distinct result tones', () => {
    const scenario = createPreviewScenario('qualification')
    const failed = runPreviewMock({
        scenario,
        phone: '+79990000003',
        contactName: 'Тест',
        answers: ['Ответ'],
        mode: 'invalid-output',
    })
    const transfer = runPreviewMock({
        scenario,
        phone: '+79990000001',
        contactName: 'Анна',
        answers: ['Готов'],
        mode: 'transfer',
    })
    assert.equal(resultTone(failed), 'failed')
    assert.equal(resultTone(transfer), 'attention')
})
