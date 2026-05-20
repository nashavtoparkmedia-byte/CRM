/**
 * AI Knowledge Core — feature flags (PR3.4).
 *
 * Source-of-truth — env-переменные (контролируются деплоем).
 * AiRetrievalPolicy хранит mirror-значения для UI visibility, но НЕ
 * влияет на runtime поведение (защита от случайного flip через UI
 * без deployment).
 *
 * Env:
 *   AI_KNOWLEDGE_SHADOW_MODE      — 'true' | 'false' (default 'true')
 *   AI_KNOWLEDGE_RUNTIME_ENABLED  — 'true' | 'false' (default 'false')
 *
 * SHADOW=on RUNTIME=off:
 *   retrieval работает, traces пишутся, клиенту отвечает legacy KB
 * SHADOW=on RUNTIME=on:
 *   retrieval работает, generator получает retrieved facts
 * SHADOW=off RUNTIME=off:
 *   pipeline идентичен PR2.5 (нулевое влияние)
 */

function envBool(name: string, fallback: boolean): boolean {
    const v = process.env[name]
    if (v == null) return fallback
    const lower = v.toLowerCase().trim()
    if (lower === '1' || lower === 'true' || lower === 'yes' || lower === 'on') return true
    if (lower === '0' || lower === 'false' || lower === 'no' || lower === 'off') return false
    return fallback
}

export function isShadowModeEnabled(): boolean {
    return envBool('AI_KNOWLEDGE_SHADOW_MODE', true)
}

export function isRuntimeEnabled(): boolean {
    return envBool('AI_KNOWLEDGE_RUNTIME_ENABLED', false)
}

/**
 * Текущий режим pipeline для logging/UI. Используется PipelineWorker'ом
 * для AiDecisionLog.retrievalMode: 'legacy' / 'shadow' / 'runtime'.
 */
export function getKnowledgeRuntimeMode(): 'legacy' | 'shadow' | 'runtime' {
    if (isRuntimeEnabled()) return 'runtime'
    if (isShadowModeEnabled()) return 'shadow'
    return 'legacy'
}
