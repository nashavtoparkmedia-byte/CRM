// ═══════════════════════════════════════════════════════════════════
// Scenario Configuration — Phase 1
// TypeScript-конфиг сценариев, этапов, SLA, рекомендуемых переходов.
// Task хранит только строковые ссылки (scenario, stage).
// При необходимости мигрировать в БД — модель Task не меняется.
// ═══════════════════════════════════════════════════════════════════

export interface StageConfig {
    id: string
    label: string
    slaHours: number | null       // null = no SLA for this stage
    recommendedNext: string | null // id of recommended next stage
}

export interface ScenarioConfig {
    id: string
    label: string
    stages: StageConfig[]
    initialStage: string
    closedReasons: { value: string; label: string }[]
    isMainScenario: boolean       // true for onboarding/churn/care — one at a time per driver
}

// ─── Scenario Definitions ─────────────────────────────────────────

export const SCENARIOS: Record<string, ScenarioConfig> = {
    churn: {
        id: 'churn',
        label: 'Отток',
        isMainScenario: true,
        initialStage: 'detected',
        stages: [
            { id: 'detected', label: 'Обнаружен', slaHours: 24, recommendedNext: 'contacting' },
            { id: 'contacting', label: 'Связываемся', slaHours: 48, recommendedNext: 'reason_collected' },
            { id: 'reason_collected', label: 'Причина собрана', slaHours: null, recommendedNext: 'offer_made' },
            { id: 'offer_made', label: 'Предложение сделано', slaHours: 72, recommendedNext: 'waiting_return' },
            { id: 'waiting_return', label: 'Ждём возврата', slaHours: 168, recommendedNext: null },
        ],
        closedReasons: [
            { value: 'returned', label: 'Вернулся' },
            { value: 'lost', label: 'Потерян' },
            { value: 'other_park', label: 'Ушёл в другой парк' },
        ],
    },

    onboarding: {
        id: 'onboarding',
        label: 'Подключение',
        isMainScenario: true,
        initialStage: 'registered',
        stages: [
            { id: 'registered', label: 'Зарегистрирован', slaHours: 24, recommendedNext: 'first_contact' },
            { id: 'first_contact', label: 'Первый контакт', slaHours: 48, recommendedNext: 'waiting_launch' },
            { id: 'waiting_launch', label: 'Ждём выход', slaHours: 72, recommendedNext: 'control' },
            { id: 'control', label: 'Контроль', slaHours: 168, recommendedNext: null },
        ],
        closedReasons: [
            { value: 'launched', label: 'Вышел на линию' },
            { value: 'refused', label: 'Отказался' },
            { value: 'lost', label: 'Потерян' },
        ],
    },

    care: {
        id: 'care',
        label: 'Забота',
        isMainScenario: true,
        initialStage: 'planned',
        stages: [
            { id: 'planned', label: 'Запланировано', slaHours: 72, recommendedNext: 'contacted' },
            { id: 'contacted', label: 'Связались', slaHours: 48, recommendedNext: 'result_recorded' },
            { id: 'result_recorded', label: 'Результат записан', slaHours: null, recommendedNext: null },
        ],
        closedReasons: [
            { value: 'completed', label: 'Выполнено' },
        ],
    },

    promo_control: {
        id: 'promo_control',
        label: 'Акция-контроль',
        isMainScenario: false,
        initialStage: 'active',
        stages: [
            { id: 'active', label: 'Акция активна', slaHours: null, recommendedNext: 'ending' },
            { id: 'ending', label: 'Завершение', slaHours: 48, recommendedNext: null },
        ],
        closedReasons: [
            { value: 'completed', label: 'Акция выключена' },
        ],
    },
}

// ─── Helpers ──────────────────────────────────────────────────────

export function getScenario(id: string): ScenarioConfig | undefined {
    return SCENARIOS[id]
}

export function getStage(scenarioId: string, stageId: string): StageConfig | undefined {
    return SCENARIOS[scenarioId]?.stages.find(s => s.id === stageId)
}

export function getRecommendedNext(scenarioId: string, currentStage: string): StageConfig | null {
    const stage = getStage(scenarioId, currentStage)
    if (!stage?.recommendedNext) return null
    return getStage(scenarioId, stage.recommendedNext) ?? null
}

export function calculateSlaDeadline(scenarioId: string, stageId: string, from: Date): Date | null {
    const stage = getStage(scenarioId, stageId)
    if (!stage?.slaHours) return null
    return new Date(from.getTime() + stage.slaHours * 60 * 60 * 1000)
}

export function getClosedReasons(scenarioId: string): { value: string; label: string }[] {
    return SCENARIOS[scenarioId]?.closedReasons ?? []
}

export function getMainScenarioIds(): string[] {
    return Object.values(SCENARIOS).filter(s => s.isMainScenario).map(s => s.id)
}

export function getAllScenarioOptions(): { value: string; label: string }[] {
    return Object.values(SCENARIOS).map(s => ({ value: s.id, label: s.label }))
}

export function getStageIndex(scenarioId: string, stageId: string): number {
    return SCENARIOS[scenarioId]?.stages.findIndex(s => s.id === stageId) ?? -1
}

export function getStageCount(scenarioId: string): number {
    return SCENARIOS[scenarioId]?.stages.length ?? 0
}
