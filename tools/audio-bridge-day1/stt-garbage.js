// STT Garbage Filter Layer v1 (PR #60).
//
// Why this exists
// ───────────────
// The 49-call production sample analyzed in PR #58's research note
// (docs/research/stt-garbage-patterns.md) showed Yandex STT producing
// structured hallucinations during silence / low-quality audio:
//
//   • "Редактор субтитров А.Синецкая Корректор А.Егорова"
//     — recurring subtitle-credits template (Russian-subtitled video
//     training residue).
//   • Emoji-only / pure-non-Cyrillic STT finals.
//
// The bridge's `_onSttFinal` previously accepted these verbatim, fed
// them to the LLM, and the LLM responded as if the lead had spoken.
// Result: conversation corruption loops, derailed dialog, false
// `unclear` outcomes.
//
// This module is a tiny pure-function classifier. Two patterns ship
// in v1, both with near-zero false-positive risk per the research:
//
//   subtitle_credits      action='drop'   FP risk near-zero
//   non_russian_garbage   action='drop'   FP risk low
//
// What this is NOT
// ────────────────
//   ❌ ML classifier
//   ❌ semantic moderation
//   ❌ embeddings / vectors
//   ❌ confidence engine / probabilistic scoring
//   ❌ NLP pipeline
//
// It's two regexes plus one length-vs-Cyrillic check. ~50 lines of
// production code. Adding more patterns is two lines plus a research
// note documenting the FP risk + recommended action.
//
// Action vocabulary (forward-compatible)
// ──────────────────────────────────────
//   'drop' — DO NOT emit to LLM; DO NOT increment realUserUtterances;
//            DO emit `stt_suspicious_pattern` event.
//   'flag' — emit event ONLY; pass through to LLM. Reserved for
//            moderate-FP patterns (bot_greeting_echo, phonetic_
//            mishearing) once production data confirms safe to drop.
//            v1 ships zero 'flag' patterns.

'use strict'

// ── Pattern 1: subtitle_credits ───────────────────────────────────────
// Anchored at start of utterance. "Редактор субтитров" + "Корректор"
// within ≤80 chars of each other. The trailing "А.Egor[ova]" / "А.Sin[etskaya]"
// surname varies; we match the structural template, not the surname.
//
// FP risk near-zero — real driver-qualification dialog has zero overlap
// with this subtitle-credit template.
const SUBTITLE_CREDITS_RE = /^\s*[Рр]едактор\s+субтитров.{0,80}?[Кк]орректор\s/u

// ── Pattern 2: non_russian_garbage ────────────────────────────────────
// (a) Any emoji / pictographic symbol — no human pronunciation produces
//     these. Unambiguous garbage.
// (b) Pure-non-Cyrillic string longer than 3 chars. Russian conversation
//     can legitimately include short loan words ("ОК" 2-char Cyrillic;
//     "iPhone" mixed-script) — those pass the gate. Only if the entire
//     string lacks Cyrillic AND is > 3 chars do we treat as garbage.
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2700}-\u{27BF}]/u
const CYRILLIC_RE = /[А-Яа-яЁё]/u

/**
 * Classify a single STT final utterance.
 *
 *   classifySttGarbage(text)
 *     → { suspicious: false, action: null, pattern_name: null }
 *     → { suspicious: true,  action: 'drop', pattern_name: 'subtitle_credits' }
 *     → { suspicious: true,  action: 'drop', pattern_name: 'non_russian_garbage' }
 *
 * Pure function. No state, no async, no side-effects, no logging.
 * Safe to call from any code path including timer callbacks.
 *
 * The caller decides what to DO with the classification (drop the
 * utterance, emit an event, log, etc.). This module just identifies
 * the pattern.
 */
function classifySttGarbage(text) {
    if (typeof text !== 'string' || text.length === 0) {
        return { suspicious: false, action: null, pattern_name: null }
    }
    const trimmed = text.trim()
    if (!trimmed) {
        return { suspicious: false, action: null, pattern_name: null }
    }

    // Pattern 1: subtitle_credits.
    if (SUBTITLE_CREDITS_RE.test(trimmed)) {
        return {
            suspicious: true,
            action: 'drop',
            pattern_name: 'subtitle_credits',
        }
    }

    // Pattern 2a: emoji-only or contains emoji.
    if (EMOJI_RE.test(trimmed)) {
        return {
            suspicious: true,
            action: 'drop',
            pattern_name: 'non_russian_garbage',
        }
    }

    // Pattern 2b: pure-non-Cyrillic > 3 chars. "ОК" (2 Cyrillic chars)
    // passes; "OK ok ok" (no Cyrillic, 8 chars) is dropped.
    if (trimmed.length > 3 && !CYRILLIC_RE.test(trimmed)) {
        return {
            suspicious: true,
            action: 'drop',
            pattern_name: 'non_russian_garbage',
        }
    }

    return { suspicious: false, action: null, pattern_name: null }
}

module.exports = {
    classifySttGarbage,
    // Exported for direct test assertions.
    SUBTITLE_CREDITS_RE,
    EMOJI_RE,
    CYRILLIC_RE,
}
