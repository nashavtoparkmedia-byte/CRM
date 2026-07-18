'use strict'

const KINDS = new Set(['reply', 'complete', 'transfer', 'stop', 'error'])
const NEXT_ACTIONS = new Set(['continue', 'end_call', 'transfer_to_manager', 'retry', 'none'])
const QUALIFICATIONS = new Set(['qualified', 'not_qualified', 'unclear'])

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function controlledFailure(code, detail) {
    return {
        ok: false,
        error: {
            code,
            detail,
            decision: {
                kind: 'error',
                nextAction: 'none',
                replyText: '',
                qualification: null,
                extractedData: {},
                transferRequested: false,
                stopReason: code,
                errors: detail ? [detail] : [code],
            },
        },
    }
}

function validateAiCallDecision(input) {
    if (!isPlainObject(input)) return controlledFailure('invalid_decision', 'decision_must_be_an_object')

    const required = [
        'kind',
        'nextAction',
        'replyText',
        'qualification',
        'extractedData',
        'transferRequested',
        'stopReason',
        'errors',
    ]
    const missing = required.filter((field) => !Object.prototype.hasOwnProperty.call(input, field))
    if (missing.length) return controlledFailure('invalid_decision', `missing_fields:${missing.join(',')}`)

    if (!KINDS.has(input.kind)) return controlledFailure('invalid_decision', 'unsupported_kind')
    if (!NEXT_ACTIONS.has(input.nextAction)) return controlledFailure('invalid_decision', 'unsupported_next_action')
    if (typeof input.replyText !== 'string') return controlledFailure('invalid_decision', 'reply_text_must_be_string')
    if (input.qualification !== null && !QUALIFICATIONS.has(input.qualification)) {
        return controlledFailure('invalid_decision', 'unsupported_qualification')
    }
    if (!isPlainObject(input.extractedData)) {
        return controlledFailure('invalid_decision', 'extracted_data_must_be_object')
    }
    const invalidExtractedValue = Object.values(input.extractedData).some(
        (value) => value !== null && !['string', 'number', 'boolean'].includes(typeof value),
    )
    if (invalidExtractedValue) {
        return controlledFailure('invalid_decision', 'invalid_extracted_data_value')
    }
    if (typeof input.transferRequested !== 'boolean') {
        return controlledFailure('invalid_decision', 'transfer_requested_must_be_boolean')
    }
    if (input.stopReason !== null && typeof input.stopReason !== 'string') {
        return controlledFailure('invalid_decision', 'stop_reason_must_be_string_or_null')
    }
    if (!Array.isArray(input.errors) || input.errors.some((error) => typeof error !== 'string')) {
        return controlledFailure('invalid_decision', 'errors_must_be_string_array')
    }
    if (input.transferRequested !== (input.nextAction === 'transfer_to_manager')) {
        return controlledFailure('invalid_decision', 'transfer_action_mismatch')
    }

    return { ok: true, decision: input }
}

function parseAiCallDecision(raw) {
    if (typeof raw !== 'string') return validateAiCallDecision(raw)
    try {
        return validateAiCallDecision(JSON.parse(raw))
    } catch {
        return controlledFailure('invalid_json', 'provider_response_is_not_valid_json')
    }
}

function decisionFromQualification(result) {
    const qualification = QUALIFICATIONS.has(result?.qualification_status)
        ? result.qualification_status
        : 'unclear'
    const transferRequested = Boolean(result?.transfer_reason)
    return {
        kind: transferRequested ? 'transfer' : 'complete',
        nextAction: transferRequested ? 'transfer_to_manager' : 'end_call',
        replyText: transferRequested
            ? 'Соединяю вас с менеджером, оставайтесь на линии.'
            : 'Спасибо за разговор, всего доброго.',
        qualification,
        extractedData: isPlainObject(result?.lead_data) ? result.lead_data : {},
        transferRequested,
        stopReason: typeof result?.reason === 'string' && result.reason ? result.reason : null,
        errors: [],
    }
}

module.exports = {
    controlledFailure,
    decisionFromQualification,
    parseAiCallDecision,
    validateAiCallDecision,
}
