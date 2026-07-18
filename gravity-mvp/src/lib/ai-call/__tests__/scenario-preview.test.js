/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const {
    createPreviewScenario,
    nextScenarioVersion,
    validatePreviewScenario,
} = require('../scenario-preview.ts')

test('all three product scenarios are valid and contain stop and transfer paths', () => {
    for (const type of ['qualification', 'churn', 'survey']) {
        const scenario = createPreviewScenario(type)
        const result = validatePreviewScenario(scenario)
        assert.equal(result.ok, true, `${type}: ${result.errors.join(', ')}`)
        assert.ok(scenario.steps.some((step) => step.type === 'stop'))
        assert.ok(scenario.steps.some((step) => step.type === 'transfer'))
    }
})

test('reports a missing branch target', () => {
    const scenario = createPreviewScenario('qualification')
    scenario.steps.find((step) => step.type === 'condition').branches[0].targetStepId = 'missing'
    const result = validatePreviewScenario(scenario)
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.includes('отсутствующий переход')))
})

test('reports unreachable steps', () => {
    const scenario = createPreviewScenario('survey')
    scenario.steps.push({
        id: 'orphan',
        type: 'stop',
        title: 'Недостижимый финал',
        content: 'Не должен выполняться.',
    })
    const result = validatePreviewScenario(scenario)
    assert.ok(result.errors.some((error) => error.includes('недостижим')))
})

test('blocks cycles even when every target exists', () => {
    const scenario = createPreviewScenario('churn')
    const transition = scenario.steps.find((step) => step.id === 'handoff-path')
    transition.nextStepId = 'main-question'
    const result = validatePreviewScenario(scenario)
    assert.ok(result.errors.some((error) => error.includes('бесконечный цикл')))
})

test('scenario versioning is immutable', () => {
    const scenario = createPreviewScenario('qualification')
    const next = nextScenarioVersion(scenario)
    assert.equal(scenario.version, 1)
    assert.equal(next.version, 2)
})
