/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const {
    maskPreviewSecret,
    previewProviderState,
    sanitizeProviderDiagnostic,
} = require('../provider-preview.ts')

test('secret mask never returns the full credential', () => {
    const secret = 'super-secret-api-key-1234'
    const masked = maskPreviewSecret(secret)
    assert.equal(masked.includes(secret), false)
    assert.equal(masked.endsWith('1234'), true)
})

test('provider preview supports configured, missing, invalid and temporary states', () => {
    for (const status of ['configured', 'missing', 'invalid', 'temporary_error']) {
        const state = previewProviderState('speechkit', status)
        assert.equal(state.status, status)
        if (status === 'missing') assert.equal(state.maskedValue, null)
    }
})

test('diagnostics redact secrets from log-safe output', () => {
    const secret = 'dangerous-secret-value'
    const diagnostic = sanitizeProviderDiagnostic({
        provider: 'speechkit',
        status: 'invalid',
        secret,
        error: `api_key=${secret}`,
    })
    const serialized = JSON.stringify(diagnostic)
    assert.equal(serialized.includes(secret), false)
    assert.match(serialized, /redacted/)
})
