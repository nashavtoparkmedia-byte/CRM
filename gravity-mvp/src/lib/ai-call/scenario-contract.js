'use strict'

function validateScenarioQuestions(value) {
    const errors = []
    if (!Array.isArray(value)) {
        return { ok: false, questions: [], errors: ['questions_must_be_array'] }
    }
    if (value.length > 50) errors.push('too_many_questions')

    const questions = value.slice(0, 50).map((raw, index) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            errors.push(`question_${index + 1}_invalid`)
            return null
        }
        const text = typeof raw.text === 'string' ? raw.text.trim() : ''
        if (!text) errors.push(`question_${index + 1}_text_required`)

        const intentKeywords = Array.isArray(raw.intentKeywords)
            ? [...new Set(raw.intentKeywords
                .filter(item => typeof item === 'string')
                .map(item => item.trim())
                .filter(Boolean))]
            : []

        const branches = {}
        if (raw.branches !== undefined) {
            if (!isPlainObject(raw.branches)) {
                errors.push(`question_${index + 1}_branches_invalid`)
            } else {
                for (const [intent, followUp] of Object.entries(raw.branches)) {
                    const cleanIntent = intent.trim()
                    const cleanFollowUp = typeof followUp === 'string' ? followUp.trim() : ''
                    if (!cleanIntent || !cleanFollowUp) {
                        errors.push(`question_${index + 1}_branch_invalid`)
                        continue
                    }
                    branches[cleanIntent] = cleanFollowUp
                }
            }
        }

        return {
            text,
            ...(intentKeywords.length > 0 ? { intentKeywords } : {}),
            ...(Object.keys(branches).length > 0 ? { branches } : {}),
        }
    }).filter(Boolean)

    return { ok: errors.length === 0, questions, errors }
}

function parseBranchesText(value) {
    const branches = {}
    const errors = []
    for (const [index, line] of String(value ?? '').split(/\r?\n/).entries()) {
        const clean = line.trim()
        if (!clean) continue
        const separator = clean.indexOf('=')
        if (separator <= 0 || separator === clean.length - 1) {
            errors.push(`line_${index + 1}_must_be_intent_equals_question`)
            continue
        }
        const intent = clean.slice(0, separator).trim()
        const followUp = clean.slice(separator + 1).trim()
        if (!intent || !followUp) {
            errors.push(`line_${index + 1}_invalid`)
            continue
        }
        branches[intent] = followUp
    }
    return { ok: errors.length === 0, branches, errors }
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

module.exports = { validateScenarioQuestions, parseBranchesText }
