// Greeting Optimization Layer v1 (PR #62).
//
// Why this exists
// ───────────────
// PR #58's assessment showed a 29% pre-greeting drop cliff: nearly a
// third of AI-calls hang up before any real engagement. The biggest
// measurable conversion leak in the system. Two opinions on "which
// greeting works best" can debate forever; this module replaces the
// opinion with a measurement.
//
// What this is
// ─────────────
// A tiny deterministic A/B router. Each scenario CAN declare 2-3
// greeting text variants (`scenario.greetingVariants`). On call start,
// the bridge picks one variant via `hash(callUuid) % N` and speaks it
// directly via TTS — no LLM round-trip, no creative variation per call.
// The picked variant ID lands in the `greeting_started` event payload,
// so funnel queries can attribute downstream outcomes (drop rate,
// time-to-first-speech, qualification) to specific variants.
//
// What this is NOT
// ────────────────
//   ❌ adaptive AI greeting generation
//   ❌ reinforcement learning / bandit
//   ❌ auto-optimization
//   ❌ dynamic prompts
//   ❌ voice cloning / per-lead personalization
//   ❌ multi-armed allocator with feedback
//
// 50 lines of hash + lookup. The "optimization" is offline analysis
// of the resulting funnel data; the runtime is fixed-assignment.
//
// Fallback
// ────────
// Scenarios without `greetingVariants` (or with an empty array) keep
// the legacy LLM-generated greeting flow. This PR is purely additive:
// scenarios opt in by declaring variants.

'use strict'

/**
 * Deterministic 32-bit-style hash of a string into a non-negative int.
 * Used to map callUuid → variant index. Same UUID always yields the
 * same variant (idempotent retries / replays land identically).
 *
 * Not a cryptographic hash — just well-distributed enough for ~3
 * buckets. The classical multiply-by-31 polynomial hash is fine here.
 */
function hashStringToInt(s) {
    if (typeof s !== 'string' || s.length === 0) return 0
    let h = 0
    for (let i = 0; i < s.length; i++) {
        h = ((h * 31) + s.charCodeAt(i)) | 0
    }
    // Coerce signed-int two's-complement result into non-negative.
    return Math.abs(h)
}

/**
 * Pick a greeting variant for one call.
 *
 *   pickGreetingVariant({ callUuid, scenario })
 *     → { id, text, ... } | null
 *
 *   null = legacy LLM-generated greeting path (scenario opted out).
 *
 * Inputs:
 *   callUuid  — FreeSWITCH call UUID; deterministic input to the hash.
 *               Any string-shaped identifier works (cuid, uuid, etc.).
 *   scenario  — the scenario row; we read `scenario.greetingVariants`
 *               (array of `{ id, text }`).
 *
 * Pure function. No state, no async, no side-effects.
 *
 * Hash policy
 * ───────────
 * `hashStringToInt(callUuid) % variants.length`. Uniform on UUIDs
 * (each call lands in a deterministic bucket). For tiny call volumes
 * the bucket distribution may temporarily skew; over enough calls it
 * smoothes out. That's acceptable for an A/B framework — we're not
 * optimizing for per-day balance, we're optimizing for total funnel
 * lift over the experiment window.
 */
function pickGreetingVariant({ callUuid, scenario } = {}) {
    if (!scenario || typeof scenario !== 'object') return null
    const variants = scenario.greetingVariants
    if (!Array.isArray(variants) || variants.length === 0) return null

    // Defensive: filter out malformed rows (must have non-empty id +
    // non-empty text). A scenario row authored via UI may temporarily
    // hold half-filled variants; better to skip them than crash.
    const valid = variants.filter(v =>
        v && typeof v.id === 'string' && v.id.length > 0
        && typeof v.text === 'string' && v.text.trim().length > 0
    )
    if (valid.length === 0) return null

    const idx = hashStringToInt(callUuid ?? '') % valid.length
    return valid[idx]
}

module.exports = {
    pickGreetingVariant,
    hashStringToInt,
}
