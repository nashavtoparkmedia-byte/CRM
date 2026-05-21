// Unit regression for the AI-call scenario lead_data validator.
//
// Run: `node --test src/lib/ai-call/__tests__/scenario-schema.test.js`

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { validateLeadData, coerceField, ISSUE_CODES } = require('../scenario-schema')

// ════════════════════════════════════════════════════════════════════
// Schema-less / empty schema → passthrough
// ════════════════════════════════════════════════════════════════════

test('no schema → passthrough', () => {
    const raw = { license: 'B', experience: '5 лет' }
    const { data, issues } = validateLeadData(raw, null)
    assert.deepEqual(data, raw)
    assert.deepEqual(issues, [])
})

test('schema with no fields → passthrough', () => {
    const raw = { city: 'Москва' }
    const { data, issues } = validateLeadData(raw, { fields: [] })
    assert.deepEqual(data, raw)
    assert.deepEqual(issues, [])
})

test('passthrough filters out non-primitive values defensively', () => {
    const raw = {
        good: 'string',
        num: 42,
        bool: true,
        // Defensive: LLM hallucinations sometimes contain nested
        // objects. Don't carry them into structured output.
        bad: { nested: 'object' },
        also_bad: ['array', 'values'],
    }
    const { data } = validateLeadData(raw, null)
    assert.deepEqual(data, { good: 'string', num: 42, bool: true })
})

test('null / undefined raw → empty data, no issues', () => {
    assert.deepEqual(validateLeadData(null, null), { data: {}, issues: [] })
    assert.deepEqual(validateLeadData(undefined, null), { data: {}, issues: [] })
})

// ════════════════════════════════════════════════════════════════════
// Required / optional handling
// ════════════════════════════════════════════════════════════════════

test('required field missing → missing_required issue', () => {
    const schema = { fields: [
        { key: 'hasLicenseB', type: 'boolean', required: true },
    ] }
    const { data, issues } = validateLeadData({}, schema)
    assert.deepEqual(data, {})
    assert.equal(issues.length, 1)
    assert.deepEqual(issues[0], { key: 'hasLicenseB', code: ISSUE_CODES.MISSING_REQUIRED })
})

test('optional field missing → no issue', () => {
    const schema = { fields: [
        { key: 'city', type: 'string', required: false },
    ] }
    const { data, issues } = validateLeadData({}, schema)
    assert.deepEqual(data, {})
    assert.deepEqual(issues, [])
})

test('empty-string value for required → counts as missing', () => {
    const schema = { fields: [
        { key: 'city', type: 'string', required: true },
    ] }
    const { data, issues } = validateLeadData({ city: '   ' }, schema)
    assert.deepEqual(data, {})
    assert.equal(issues[0].code, ISSUE_CODES.MISSING_REQUIRED)
})

// ════════════════════════════════════════════════════════════════════
// integer type
// ════════════════════════════════════════════════════════════════════

test('integer: parses pure numeric string', () => {
    const r = coerceField('5', { key: 'x', type: 'integer' })
    assert.deepEqual(r, { ok: true, value: 5 })
})

test('integer: extracts leading int from mixed string ("5 лет" → 5)', () => {
    const r = coerceField('5 лет', { key: 'x', type: 'integer' })
    assert.deepEqual(r, { ok: true, value: 5 })
})

test('integer: rejects "пять"', () => {
    const r = coerceField('пять', { key: 'x', type: 'integer' })
    assert.equal(r.ok, false)
    assert.equal(r.code, ISSUE_CODES.INVALID_VALUE)
})

test('integer: accepts native number', () => {
    const r = coerceField(7, { key: 'x', type: 'integer' })
    assert.deepEqual(r, { ok: true, value: 7 })
})

test('integer: out-of-range min', () => {
    const r = coerceField('-3', { key: 'x', type: 'integer', min: 0 })
    assert.equal(r.ok, false)
    assert.equal(r.code, ISSUE_CODES.OUT_OF_RANGE)
})

test('integer: out-of-range max', () => {
    const r = coerceField('500', { key: 'x', type: 'integer', max: 100 })
    assert.equal(r.ok, false)
    assert.equal(r.code, ISSUE_CODES.OUT_OF_RANGE)
})

// ════════════════════════════════════════════════════════════════════
// boolean type
// ════════════════════════════════════════════════════════════════════

test('boolean: accepts native true / false', () => {
    assert.deepEqual(coerceField(true,  { key: 'x', type: 'boolean' }), { ok: true, value: true })
    assert.deepEqual(coerceField(false, { key: 'x', type: 'boolean' }), { ok: true, value: false })
})

test('boolean: parses Russian да / нет / есть / нету', () => {
    for (const s of ['да', 'Да', 'ДА', 'есть']) {
        assert.equal(coerceField(s, { key: 'x', type: 'boolean' }).value, true, s)
    }
    for (const s of ['нет', 'Нет', 'нету']) {
        assert.equal(coerceField(s, { key: 'x', type: 'boolean' }).value, false, s)
    }
})

test('boolean: parses English yes / no / true / false', () => {
    assert.equal(coerceField('yes',   { key: 'x', type: 'boolean' }).value, true)
    assert.equal(coerceField('YES',   { key: 'x', type: 'boolean' }).value, true)
    assert.equal(coerceField('true',  { key: 'x', type: 'boolean' }).value, true)
    assert.equal(coerceField('no',    { key: 'x', type: 'boolean' }).value, false)
    assert.equal(coerceField('false', { key: 'x', type: 'boolean' }).value, false)
})

test('boolean: rejects unparseable strings', () => {
    const r = coerceField('может быть', { key: 'x', type: 'boolean' })
    assert.equal(r.ok, false)
    assert.equal(r.code, ISSUE_CODES.BOOLEAN_UNPARSEABLE)
})

// ════════════════════════════════════════════════════════════════════
// string type
// ════════════════════════════════════════════════════════════════════

test('string: non-empty passes', () => {
    const r = coerceField('Москва', { key: 'x', type: 'string' })
    assert.deepEqual(r, { ok: true, value: 'Москва' })
})

test('string: trims whitespace', () => {
    const r = coerceField('  Москва  ', { key: 'x', type: 'string' })
    assert.equal(r.value, 'Москва')
})

test('string: maxLength truncates without issue', () => {
    const r = coerceField('абвгдежз', { key: 'x', type: 'string', maxLength: 4 })
    assert.equal(r.ok, true)
    assert.equal(r.value, 'абвг')
})

test('string: rejects non-string', () => {
    const r = coerceField(42, { key: 'x', type: 'string' })
    assert.equal(r.ok, false)
})

// ════════════════════════════════════════════════════════════════════
// enum type
// ════════════════════════════════════════════════════════════════════

test('enum: case-insensitive match returns canonical casing', () => {
    const field = { key: 'x', type: 'enum', values: ['day', 'night', 'any'] }
    assert.equal(coerceField('DAY', field).value, 'day')
    assert.equal(coerceField('Night', field).value, 'night')
    assert.equal(coerceField('any', field).value, 'any')
})

test('enum: value not in list → not_in_enum', () => {
    const field = { key: 'x', type: 'enum', values: ['day', 'night', 'any'] }
    const r = coerceField('morning', field)
    assert.equal(r.ok, false)
    assert.equal(r.code, ISSUE_CODES.NOT_IN_ENUM)
})

// ════════════════════════════════════════════════════════════════════
// Defensive: malformed schema rows
// ════════════════════════════════════════════════════════════════════

test('unknown type → unknown_type issue, value skipped', () => {
    const schema = { fields: [
        { key: 'x', type: 'fancy', required: true },
    ] }
    const { data, issues } = validateLeadData({ x: 'value' }, schema)
    assert.deepEqual(data, {})
    assert.equal(issues[0].code, ISSUE_CODES.UNKNOWN_TYPE)
})

test('malformed schema row (no key) → defensive issue, no crash', () => {
    const schema = { fields: [
        { type: 'string', required: true },  // missing key
    ] }
    const r = validateLeadData({ city: 'Москва' }, schema)
    assert.equal(r.issues.length, 1)
    assert.equal(r.issues[0].code, ISSUE_CODES.UNKNOWN_TYPE)
})

// ════════════════════════════════════════════════════════════════════
// Extra keys not in schema are silently dropped
// ════════════════════════════════════════════════════════════════════

test('extra keys not in schema are dropped (no issue)', () => {
    const schema = { fields: [
        { key: 'city', type: 'string', required: true },
    ] }
    const { data, issues } = validateLeadData(
        { city: 'Москва', randomKey: 'noise' },
        schema,
    )
    assert.deepEqual(data, { city: 'Москва' })
    assert.deepEqual(issues, [])
})

// ════════════════════════════════════════════════════════════════════
// End-to-end: realistic scenario schema
// ════════════════════════════════════════════════════════════════════

test('end-to-end: 4-field schema with mixed valid + invalid input', () => {
    const schema = {
        fields: [
            { key: 'hasLicenseB',     type: 'boolean', required: true },
            { key: 'experienceYears', type: 'integer', required: false, min: 0, max: 50 },
            { key: 'city',            type: 'string',  required: false },
            { key: 'shiftPreference', type: 'enum',    required: true,
              values: ['day', 'night', 'rotating', 'any'] },
        ],
    }
    const raw = {
        hasLicenseB: 'да',
        experienceYears: '7 лет',
        city: 'Санкт-Петербург',
        shiftPreference: 'morning',   // not in enum
        unknownField: 'будет проигнорировано',
    }
    const { data, issues } = validateLeadData(raw, schema)
    assert.deepEqual(data, {
        hasLicenseB: true,
        experienceYears: 7,
        city: 'Санкт-Петербург',
    })
    assert.equal(issues.length, 1)
    assert.deepEqual(issues[0], { key: 'shiftPreference', code: ISSUE_CODES.NOT_IN_ENUM, got: 'morning' })
})
