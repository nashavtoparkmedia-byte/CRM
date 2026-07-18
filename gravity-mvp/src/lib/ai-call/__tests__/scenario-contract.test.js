'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const test = require('node:test')
const assert = require('node:assert/strict')
const { validateScenarioQuestions, parseBranchesText } = require('../scenario-contract')

test('valid branching contract is normalized', () => {
    const result = validateScenarioQuestions([{
        text: '  Вы готовы выйти завтра? ',
        intentKeywords: ['да', ' да ', 'нет'],
        branches: {
            да: 'В какое время?',
            нет: 'Когда будет удобно?',
        },
    }])
    assert.equal(result.ok, true)
    assert.deepEqual(result.questions, [{
        text: 'Вы готовы выйти завтра?',
        intentKeywords: ['да', 'нет'],
        branches: {
            да: 'В какое время?',
            нет: 'Когда будет удобно?',
        },
    }])
})

test('invalid branch and missing question text are controlled validation errors', () => {
    const result = validateScenarioQuestions([
        { text: '', branches: { yes: '' } },
        { text: 'ok', branches: [] },
    ])
    assert.equal(result.ok, false)
    assert.ok(result.errors.includes('question_1_text_required'))
    assert.ok(result.errors.includes('question_1_branch_invalid'))
    assert.ok(result.errors.includes('question_2_branches_invalid'))
})

test('branch editor format is deterministic intent=follow-up per line', () => {
    const result = parseBranchesText('готов=Когда сможете выйти?\nотказ=Почему не рассматриваете?')
    assert.equal(result.ok, true)
    assert.deepEqual(result.branches, {
        готов: 'Когда сможете выйти?',
        отказ: 'Почему не рассматриваете?',
    })
    assert.equal(parseBranchesText('broken line').ok, false)
})
