// Prompt Fragment Layer v1 (PR #63).
//
// Why this exists
// ───────────────
// Up to and including PR #62, the scenario's system prompt is one
// monolithic string (`AiCallScenario.systemPrompt`). When the team
// wants to A/B "what wording works best for the transfer framing?"
// or "which recovery instructions reduce derailing?", they have to
// fork the entire prompt — every iteration touches the whole blob.
// No way to attribute downstream outcomes to specific text spans.
//
// This module turns the prompt into a composition of small named
// fragments. Each fragment has `id`, `version`, optional `hypothesis`,
// and `text`. The assembled prompt is a deterministic concatenation
// with scenario-specific scaffolding (questions, speech rules)
// between/around the fragments.
//
// What this is NOT
// ────────────────
//   ❌ agent framework
//   ❌ prompt graph engine / DAG
//   ❌ LangChain or equivalent
//   ❌ autonomous planner
//   ❌ memory system
//   ❌ multi-agent runtime
//   ❌ dynamic reasoning chains
//   ❌ LLM routing layer
//
// 50 lines of branch-and-concatenate. The "intelligence" is the
// scenario author authoring meaningful fragment text; the runtime
// just glues them together.
//
// Architecture
// ────────────
// Pure function. No state, no I/O, no async. Dependency-injected
// `legacyBuilder` so the module stays decoupled from `llm-client.js`
// (which calls back into this module — `legacyBuilder` is the
// fallback path for scenarios that did not opt in).
//
// Backward compatibility
// ──────────────────────
// Scenarios WITHOUT a valid `fragments` field fall through to
// `legacyBuilder(scenario)` — the existing monolithic
// `llm.buildSystemMessage(scenario)` behaviour, byte-identical.
// Existing prod scenarios keep working unchanged.

'use strict'

/**
 * Fragment "slots" recognised in v1. Required slots MUST be present
 * and valid for the fragments path to engage; otherwise the composer
 * falls back to the legacy monolithic prompt.
 *
 * Adding a slot in a future PR: extend REQUIRED_SLOTS / OPTIONAL_SLOTS,
 * update composition order in `buildConversationPrompt`, document the
 * payload shape in the architect-approved design doc.
 */
const REQUIRED_SLOTS = Object.freeze([
    'greeting',
    'qualification_intro',
    'recovery',
    'transfer_framing',
])

const OPTIONAL_SLOTS = Object.freeze([
    'objection_soft',
    'closing',
])

const ALL_SLOTS = Object.freeze([...REQUIRED_SLOTS, ...OPTIONAL_SLOTS])

/**
 * Validate one fragment object.
 *
 *   { id: string, version: number|string, text: string, hypothesis?: string }
 *
 * Returns true iff the row is structurally usable. `version` is
 * accepted as number OR string (e.g. "1" or "v1") — the field is
 * for measurement, not parsing.
 */
function isValidFragment(f) {
    if (!f || typeof f !== 'object') return false
    if (typeof f.id !== 'string' || f.id.length === 0) return false
    if (typeof f.text !== 'string' || f.text.trim().length === 0) return false
    if (f.version === undefined || f.version === null) return false
    if (typeof f.version !== 'number' && typeof f.version !== 'string') return false
    return true
}

/**
 * Return true iff `scenario.fragments` is a usable record AND every
 * REQUIRED slot is a valid fragment. Missing required → false (caller
 * falls back to legacy). Extra optional slots are fine; unknown extra
 * keys are silently ignored.
 */
function hasValidFragments(scenario) {
    const f = scenario?.fragments
    if (!f || typeof f !== 'object' || Array.isArray(f)) return false
    return REQUIRED_SLOTS.every(slot => isValidFragment(f[slot]))
}

/**
 * Extract a flat `{ slot: <id>@<version> }` map of the fragments
 * actually used in the assembled prompt. Used by the bridge to attach
 * fragment provenance to the `greeting_started` event payload so
 * offline analysis can attribute outcomes to specific fragment
 * id+version combinations.
 *
 * Returns null when the scenario did not opt in (legacy path).
 */
function getFragmentVersions(scenario) {
    if (!hasValidFragments(scenario)) return null
    const f = scenario.fragments
    const out = {}
    for (const slot of ALL_SLOTS) {
        const frag = f[slot]
        if (isValidFragment(frag)) {
            out[slot] = `${frag.id}@${frag.version}`
        }
    }
    return out
}

/**
 * Render the scenario questions as a numbered block. Same shape the
 * legacy `buildSystemMessage` produces, so the composed prompt
 * preserves the format the LLM is already trained on by the scenario.
 */
function renderQuestionsBlock(scenario) {
    const questions = (scenario?.questions ?? [])
        .map((q, i) => `${i + 1}. ${q?.text ?? ''}`)
        .join('\n')
    return [
        'Вопросы по порядку (закрывай по одному, не задавай все сразу):',
        questions || '— (вопросов нет, действуй по системному промту)',
    ].join('\n')
}

/**
 * Speech / scenario rules — preserved verbatim from the legacy
 * `buildSystemMessage` to avoid drift in dialog behaviour when a
 * scenario switches to the fragments path. These are scaffolding,
 * NOT fragments: they are not part of the v1 A/B surface.
 *
 * Future PR can promote these into a `speech_rules` fragment if the
 * data shows they're worth iterating.
 */
function renderSpeechAndScenarioRules() {
    return [
        'Правила речи (КРИТИЧНО — это телефонный звонок, не чат):',
        '— Каждая твоя реплика — НЕ БОЛЬШЕ 1–2 коротких предложений. Лимит ≈ 20 слов.',
        '— Каждая реплика заканчивается ОДНИМ конкретным вопросом (либо коротким завершающим «всего доброго», если звонок окончен).',
        '— После своей реплики ЖДИ ответ лида. Не задавай следующий вопрос сразу.',
        '— Не повторяй сам себя в одной реплике. Не перефразируй то же самое дважды подряд.',
        '— Не пиши вступления вроде «отлично, а теперь следующий вопрос». Сразу по делу.',
        '— Если лид молчит/STT прислал мусор/неразборчиво — переспроси один раз коротко: «Не расслышал, повторите?». Дважды не переспрашивай — лучше задай следующий вопрос.',
        '',
        'Правила сценария:',
        '— Говори по-русски, как живой менеджер парка, без формальностей.',
        '— После каждого внятного ответа лида вызывай save_lead_data.',
        '— Когда все вопросы закрыты — вызывай end_call с итогом.',
        '— Если лид агрессивен, требует человека или вопрос вне сценария — вызывай transfer_to_manager.',
        '— Не сочиняй факты. Не отвечай на off-topic — мягко возвращай к вопросу.',
    ].join('\n')
}

/**
 * Optional PR #57 cheat sheet: when the scenario declares an
 * outcomeSchema, append the canonical-key list to the prompt so the
 * model uses the right `field` names in save_lead_data. Same shape
 * as legacy `buildSystemMessage`.
 */
function renderCanonicalKeysHint(scenario) {
    const fields = scenario?.outcomeSchema?.fields
    if (!Array.isArray(fields) || fields.length === 0) return null
    const lines = fields.map(f => {
        const req = f.required ? ' (обязательно)' : ''
        const type = f.type === 'enum'
            ? `enum [${(f.values ?? []).join(', ')}]`
            : f.type
        const label = f.label ? ` — ${f.label}` : ''
        return `  • ${f.key}: ${type}${req}${label}`
    }).join('\n')
    return [
        'Канонические поля для save_lead_data (используй ТОЛЬКО эти имена field):',
        lines,
    ].join('\n')
}

/**
 * Compose the system prompt for one call.
 *
 *   buildConversationPrompt({ scenario, legacyBuilder })
 *     → string
 *
 * If the scenario opted into fragments (all REQUIRED slots valid),
 * assembles the prompt deterministically:
 *
 *     [greeting]
 *     [qualification_intro]
 *     [questions block]
 *     [speech + scenario rules — scaffolding]
 *     [transfer_framing]
 *     [objection_soft]               (if present)
 *     [recovery]
 *     [closing]                      (if present)
 *     [canonical-keys cheat sheet]   (if outcomeSchema set)
 *     [end_call qualification_score nudge]
 *
 * Otherwise falls through to `legacyBuilder(scenario)` — the existing
 * monolithic prompt path. NEVER throws.
 *
 * `legacyBuilder` is dependency-injected to keep this module decoupled
 * from `llm-client.js`. In production llm-client passes its own
 * `buildLegacySystemMessage`; tests pass a stub.
 */
function buildConversationPrompt({ scenario, legacyBuilder } = {}) {
    if (!hasValidFragments(scenario)) {
        return typeof legacyBuilder === 'function'
            ? legacyBuilder(scenario)
            : ''  // defensive — caller should always pass a legacyBuilder
    }

    const f = scenario.fragments
    const parts = []

    parts.push(f.greeting.text)
    parts.push('')
    parts.push(f.qualification_intro.text)
    parts.push('')
    parts.push(renderQuestionsBlock(scenario))
    parts.push('')
    parts.push(renderSpeechAndScenarioRules())
    parts.push('')
    parts.push(f.transfer_framing.text)
    if (isValidFragment(f.objection_soft)) {
        parts.push('')
        parts.push(f.objection_soft.text)
    }
    parts.push('')
    parts.push(f.recovery.text)
    if (isValidFragment(f.closing)) {
        parts.push('')
        parts.push(f.closing.text)
    }

    const canonicalHint = renderCanonicalKeysHint(scenario)
    if (canonicalHint) {
        parts.push('')
        parts.push(canonicalHint)
    }

    parts.push('')
    parts.push('В end_call верни qualification_score 0-100 (опционально для not_qualified).')

    return parts.join('\n')
}

module.exports = {
    buildConversationPrompt,
    hasValidFragments,
    getFragmentVersions,
    isValidFragment,
    REQUIRED_SLOTS,
    OPTIONAL_SLOTS,
    ALL_SLOTS,
}
