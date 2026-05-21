// Deterministic validator: raw LLM lead_data → canonical structured fields.
//
// Why this exists
// ───────────────
// The LLM's `save_lead_data(field, value)` tool used to accept any
// `field` string. Models would invent keys per-call: `license` /
// `licenses` / `права` / `опыт` / `years`. PM trying to compute
// "drivers with experienceYears > 3" had to parse free-text JSON.
//
// This module enforces a scenario-defined schema: each scenario row
// owns an `outcomeSchema` JSON listing the canonical field keys, their
// types (integer / boolean / string / enum), and a `required` flag.
// At finalize time, raw lead_data is coerced into canonical keys with
// typed values; mismatches surface as structured `issues` (logged,
// not thrown) so a bad LLM response doesn't crash finalize.
//
// Coercion (not best-effort fuzzy matching)
// ─────────────────────────────────────────
// The model returns string values via `save_lead_data` (OpenAI's
// tool args force string for free-text fields). So the validator
// must coerce strings into the canonical type. The rules are
// EXACT, deterministic, and small — no regex magic, no fuzzy
// Russian-to-English mapping:
//
//   integer   — parseInt-style; "5 лет" → 5, "пять" → invalid_value
//   boolean   — small allowlist of phrases:
//                 true  ← {true, "true", "yes", "да", "есть", "1"}
//                 false ← {false, "false", "no", "нет", "нету", "0"}
//                 anything else → boolean_unparseable
//   string    — non-empty string after trim
//   enum      — exact match against `values` list (case-insensitive)
//
// The "fuzzy mapping from Russian → English keys" problem is solved
// at a different layer: the bridge's `save_lead_data` tool gets its
// `field` arg constrained by `enum: scenario.outcomeSchema.fields`,
// so the model is forced to use canonical keys at the point of call.
// This module is the safety net for cases the bridge constraint
// can't enforce (older models, schema-less scenarios, bugs).
//
// Out of scope
// ────────────
// - Outcome enum mapping (see outcome-mapper.js)
// - Multi-language enum value localization (admin authors values in
//   their preferred language; LLM is told the values via the tool
//   schema)
// - Custom validators per field (no callbacks, no regexes — keep the
//   surface tiny)

'use strict'

const BOOLEAN_TRUE = new Set(['true', 'yes', 'да', 'есть', '1', 'yep', 'sure'])
const BOOLEAN_FALSE = new Set(['false', 'no', 'нет', 'нету', '0', 'nope'])

const ISSUE_CODES = Object.freeze({
    MISSING_REQUIRED:    'missing_required',
    INVALID_VALUE:       'invalid_value',
    OUT_OF_RANGE:        'out_of_range',
    NOT_IN_ENUM:         'not_in_enum',
    BOOLEAN_UNPARSEABLE: 'boolean_unparseable',
    UNKNOWN_TYPE:        'unknown_type',
})

/**
 * Coerce one raw value into the given field's type. Returns either
 * `{ ok: true, value }` (coerced typed value) or
 * `{ ok: false, code, got }` (structured issue).
 */
function coerceField(rawValue, field) {
    // For integers / booleans the LLM almost always returns a string
    // even when the conceptual value is numeric. So we accept both
    // shapes and coerce defensively.

    if (field.type === 'integer') {
        let n
        if (typeof rawValue === 'number') {
            n = rawValue
        } else if (typeof rawValue === 'string') {
            // Pull the first integer-looking chunk. "5 лет" → 5,
            // "стаж 12" → 12, "не помню" → NaN.
            const m = rawValue.match(/-?\d+/)
            n = m ? parseInt(m[0], 10) : NaN
        } else {
            return { ok: false, code: ISSUE_CODES.INVALID_VALUE, got: rawValue }
        }
        if (!Number.isFinite(n)) {
            return { ok: false, code: ISSUE_CODES.INVALID_VALUE, got: rawValue }
        }
        if (typeof field.min === 'number' && n < field.min) {
            return { ok: false, code: ISSUE_CODES.OUT_OF_RANGE, got: n }
        }
        if (typeof field.max === 'number' && n > field.max) {
            return { ok: false, code: ISSUE_CODES.OUT_OF_RANGE, got: n }
        }
        return { ok: true, value: n }
    }

    if (field.type === 'boolean') {
        if (typeof rawValue === 'boolean') return { ok: true, value: rawValue }
        if (typeof rawValue === 'string') {
            const lc = rawValue.trim().toLowerCase()
            if (BOOLEAN_TRUE.has(lc))  return { ok: true, value: true }
            if (BOOLEAN_FALSE.has(lc)) return { ok: true, value: false }
            return { ok: false, code: ISSUE_CODES.BOOLEAN_UNPARSEABLE, got: rawValue }
        }
        return { ok: false, code: ISSUE_CODES.INVALID_VALUE, got: rawValue }
    }

    if (field.type === 'string') {
        if (typeof rawValue !== 'string') {
            return { ok: false, code: ISSUE_CODES.INVALID_VALUE, got: rawValue }
        }
        const s = rawValue.trim()
        if (s.length === 0) {
            return { ok: false, code: ISSUE_CODES.INVALID_VALUE, got: rawValue }
        }
        if (typeof field.maxLength === 'number' && s.length > field.maxLength) {
            return { ok: true, value: s.slice(0, field.maxLength) }
        }
        return { ok: true, value: s }
    }

    if (field.type === 'enum') {
        if (typeof rawValue !== 'string') {
            return { ok: false, code: ISSUE_CODES.INVALID_VALUE, got: rawValue }
        }
        const lc = rawValue.trim().toLowerCase()
        const values = Array.isArray(field.values) ? field.values : []
        // Case-insensitive match; return the canonical-case value
        // from the schema (preserves admin's casing).
        for (const v of values) {
            if (typeof v === 'string' && v.toLowerCase() === lc) {
                return { ok: true, value: v }
            }
        }
        return { ok: false, code: ISSUE_CODES.NOT_IN_ENUM, got: rawValue }
    }

    // Schema config error: unknown type. Defensive — should never fire
    // if scenarios.ts validates outcomeSchema on write.
    return { ok: false, code: ISSUE_CODES.UNKNOWN_TYPE, got: field.type }
}

/**
 * Validate raw `lead_data` (whatever the LLM gathered via save_lead_data)
 * against the scenario's `outcomeSchema`. Returns:
 *
 *   { data: Record<string, number|boolean|string>,
 *     issues: Array<{ key, code, got? }> }
 *
 * Behaviour:
 *
 *   - Schema missing or empty → passthrough. `data` is a shallow copy
 *     of the raw input (filtered to plain primitives). `issues` is [].
 *     Existing scenarios without outcomeSchema continue to work.
 *
 *   - Schema present → only canonical keys land in `data`. Extra keys
 *     in raw input are dropped (no `unknown_key` issue — the LLM might
 *     have set them via the side-channel of an older bridge; not worth
 *     surfacing).
 *
 *   - Required fields missing → issue with code `missing_required`,
 *     and the key is absent from `data`.
 *
 *   - Type/range/enum mismatches → issue with the corresponding code,
 *     and the key is absent from `data`.
 *
 * NEVER throws. Caller logs `issues` via opsLog (warn level) and
 * persists `data` to `Call.leadDataStructured`.
 */
function validateLeadData(rawLeadData, schema) {
    const raw = (rawLeadData && typeof rawLeadData === 'object' && !Array.isArray(rawLeadData))
        ? rawLeadData
        : {}

    // Schema-less path — passthrough. Filter to primitives so we don't
    // accidentally serialize deeply nested LLM hallucinations.
    if (!schema || !Array.isArray(schema.fields) || schema.fields.length === 0) {
        const out = {}
        for (const k of Object.keys(raw)) {
            const v = raw[k]
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                out[k] = v
            }
        }
        return { data: out, issues: [] }
    }

    const out = {}
    const issues = []

    for (const field of schema.fields) {
        if (!field || typeof field.key !== 'string' || typeof field.type !== 'string') {
            // Bad schema row — skip defensively, log via issues.
            issues.push({ key: field?.key ?? '<unknown>', code: ISSUE_CODES.UNKNOWN_TYPE, got: field?.type })
            continue
        }
        const rawValue = raw[field.key]
        if (rawValue === undefined || rawValue === null
            || (typeof rawValue === 'string' && rawValue.trim() === '')) {
            if (field.required) {
                issues.push({ key: field.key, code: ISSUE_CODES.MISSING_REQUIRED })
            }
            continue
        }
        const result = coerceField(rawValue, field)
        if (result.ok) {
            out[field.key] = result.value
        } else {
            issues.push({ key: field.key, code: result.code, got: result.got })
        }
    }

    return { data: out, issues }
}

module.exports = {
    validateLeadData,
    coerceField,
    ISSUE_CODES,
}
