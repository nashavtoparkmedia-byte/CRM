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

// ─── Scenario Fields (Wave 1) ────────────────────────────────────

export interface ScenarioFieldDef {
    id: string
    label: string
    type: 'boolean' | 'number' | 'string' | 'enum' | 'date'
    source: 'auto' | 'manual' | 'derived'
    showInList: boolean
    showInCard: boolean
    filterable: boolean
    sortable?: boolean            // задел под сортировку по scenario fields
    groupable?: boolean           // задел под группировку списка
    priorityWeight: number        // задел для Wave 2, в Wave 1 не используется
    enumOptions?: { value: string; label: string }[]
    // Короткий формат для строки списка (например, "СМЗ: Да" vs полный "Статус СМЗ: Да")
    shortLabel?: string
}

export interface ScenarioFieldValue {
    value: unknown
    source: 'auto' | 'manual' | 'derived'
    updatedAt: string             // ISO string
}

export type ScenarioData = Record<string, ScenarioFieldValue>

// ─── Preset config for "Горячие" filter ──────────────────────────

export interface ScenarioPresetConfig {
    hotInactiveDaysThreshold?: number  // порог inactiveDays для пресета "Горячие"
}

// ─── Scenario Config ─────────────────────────────────────────────

export interface ScenarioConfig {
    id: string
    label: string
    stages: StageConfig[]
    initialStage: string
    closedReasons: { value: string; label: string }[]
    isMainScenario: boolean       // true for onboarding/churn/care — one at a time per driver
    fields: ScenarioFieldDef[]    // Wave 1: scenario-specific operational fields
    presets?: ScenarioPresetConfig // Wave 1: preset filter thresholds
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
        fields: [
            // ── Excel columns A–M: Preview в строке списка ──
            {
                id: 'isInOtherFleet', label: 'Другой парк', shortLabel: 'Парк',
                type: 'enum', source: 'derived',
                enumOptions: [
                    { value: 'yes', label: 'Да' },
                    { value: 'no', label: 'Нет' },
                    { value: 'unknown', label: 'Неизвестно' },
                ],
                showInList: true, showInCard: true, filterable: true, sortable: true, groupable: true, priorityWeight: 2,
            },
            {
                id: 'yandexActive', label: 'Катает в Яндекс', shortLabel: 'Яндекс',
                type: 'enum', source: 'derived',
                enumOptions: [
                    { value: 'yes', label: 'Да' },
                    { value: 'no', label: 'Нет' },
                    { value: 'unknown', label: 'Неизвестно' },
                ],
                showInList: true, showInCard: true, filterable: true, sortable: true, groupable: true, priorityWeight: 2,
            },
            {
                id: 'yandexTripsCount', label: 'Поездок по Яндексу', shortLabel: 'Поездки',
                type: 'number', source: 'derived',
                showInList: true, showInCard: true, filterable: true, sortable: true, priorityWeight: 1,
            },
            {
                id: 'isSelfEmployed', label: 'Статус СМЗ', shortLabel: 'СМЗ',
                type: 'enum', source: 'manual',
                enumOptions: [
                    { value: 'yes', label: 'Да' },
                    { value: 'no', label: 'Нет' },
                    { value: 'unknown', label: 'Неизвестно' },
                ],
                showInList: true, showInCard: true, filterable: true, sortable: true, groupable: true, priorityWeight: 2,
            },
            {
                id: 'monthOfChurn', label: 'Месяц оттока', shortLabel: 'Месяц',
                type: 'enum', source: 'derived',
                enumOptions: [
                    { value: '1', label: 'Январь' },
                    { value: '2', label: 'Февраль' },
                    { value: '3', label: 'Март' },
                    { value: '4', label: 'Апрель' },
                    { value: '5', label: 'Май' },
                    { value: '6', label: 'Июнь' },
                    { value: '7', label: 'Июль' },
                    { value: '8', label: 'Август' },
                    { value: '9', label: 'Сентябрь' },
                    { value: '10', label: 'Октябрь' },
                    { value: '11', label: 'Ноябрь' },
                    { value: '12', label: 'Декабрь' },
                ],
                showInList: true, showInCard: true, filterable: true, sortable: true, groupable: true, priorityWeight: 1,
            },
            {
                id: 'inactiveDays', label: 'Дней без поездок', shortLabel: 'Дней',
                type: 'number', source: 'derived',
                showInList: true, showInCard: true, filterable: true, sortable: true, priorityWeight: 3,
            },

            // ── Excel columns в карточке (но не в preview-строке) ──
            {
                id: 'licenseNumber', label: 'Номер ВУ',
                type: 'string', source: 'auto',
                showInList: false, showInCard: true, filterable: false, priorityWeight: 0,
            },
            {
                id: 'completedOrders', label: 'Завершено заказов',
                type: 'number', source: 'derived',
                showInList: false, showInCard: true, filterable: true, sortable: true, priorityWeight: 0,
            },
            {
                id: 'parkCommission', label: 'Комиссия парка',
                type: 'string', source: 'manual',
                showInList: false, showInCard: true, filterable: false, priorityWeight: 0,
            },
            {
                id: 'hoursOnline', label: 'Часы на линии',
                type: 'number', source: 'manual',
                showInList: false, showInCard: true, filterable: true, sortable: true, priorityWeight: 0,
            },

            // ── Месячные агрегаты: декабрь/январь/февраль/март ──
            // Source = derived. На бэке вычисляются динамически из DriverDaySummary.
            // ID захардкожены как месяцы, но логика сбора — last N months aggregate.
            {
                id: 'tripsDecember', label: 'Декабрь',
                type: 'number', source: 'derived',
                showInList: false, showInCard: true, filterable: false, priorityWeight: 0,
            },
            {
                id: 'tripsJanuary', label: 'Январь',
                type: 'number', source: 'derived',
                showInList: false, showInCard: true, filterable: false, priorityWeight: 0,
            },
            {
                id: 'tripsFebruary', label: 'Февраль',
                type: 'number', source: 'derived',
                showInList: false, showInCard: true, filterable: false, priorityWeight: 0,
            },
            {
                id: 'tripsMarch', label: 'Март',
                type: 'number', source: 'derived',
                showInList: false, showInCard: true, filterable: false, priorityWeight: 0,
            },

            // ── Какой парк — auto с manual fallback ──
            {
                id: 'externalParkName', label: 'Какой парк',
                type: 'string', source: 'auto',
                showInList: false, showInCard: true, filterable: true, sortable: true, priorityWeight: 0,
            },

            // ── Дополнительные поля ──
            {
                id: 'driverSegment', label: 'Сегмент',
                type: 'string', source: 'auto',
                showInList: false, showInCard: true, filterable: true, sortable: true, priorityWeight: 1,
            },
            {
                id: 'recentTripsCount', label: 'Поездки за 7 дней',
                type: 'number', source: 'derived',
                showInList: false, showInCard: true, filterable: true, sortable: true, priorityWeight: 1,
            },
            {
                id: 'churnReason', label: 'Причина оттока',
                type: 'enum', source: 'manual',
                showInList: false, showInCard: true, filterable: true, sortable: false, priorityWeight: 0,
                enumOptions: [
                    { value: 'low_earnings', label: 'Низкий заработок' },
                    { value: 'bad_conditions', label: 'Плохие условия' },
                    { value: 'personal', label: 'Личные причины' },
                    { value: 'other_park', label: 'Другой парк' },
                    { value: 'other', label: 'Другое' },
                ],
            },
        ],
        presets: {
            hotInactiveDaysThreshold: 7,
        },
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
        fields: [
            { id: 'docsReady', label: 'Документы готовы', type: 'boolean', source: 'manual', showInList: true, showInCard: true, filterable: true, priorityWeight: 2 },
            { id: 'carAssigned', label: 'Авто назначено', type: 'boolean', source: 'manual', showInList: true, showInCard: true, filterable: true, priorityWeight: 1 },
            { id: 'daysSinceRegister', label: 'Дней с регистрации', type: 'number', source: 'derived', showInList: true, showInCard: true, filterable: true, priorityWeight: 2 },
            { id: 'blocker', label: 'Блокер', type: 'enum', source: 'manual', showInList: true, showInCard: true, filterable: true, priorityWeight: 3, enumOptions: [
                { value: 'no_docs', label: 'Нет документов' },
                { value: 'no_car', label: 'Нет авто' },
                { value: 'waiting_approval', label: 'Ждёт одобрения' },
                { value: 'other', label: 'Другое' },
            ] },
            { id: 'driverSegment', label: 'Сегмент', type: 'string', source: 'auto', showInList: false, showInCard: true, filterable: false, priorityWeight: 0 },
        ],
        presets: {},
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
        fields: [
            { id: 'careType', label: 'Тип заботы', type: 'enum', source: 'manual', showInList: true, showInCard: true, filterable: true, priorityWeight: 0, enumOptions: [
                { value: 'regular', label: 'Плановая' },
                { value: 'issue', label: 'По проблеме' },
                { value: 'retention', label: 'Удержание' },
            ] },
            { id: 'driverSegment', label: 'Сегмент', type: 'string', source: 'auto', showInList: true, showInCard: true, filterable: true, priorityWeight: 2 },
            { id: 'recentTripsCount', label: 'Поездки за 7 дней', type: 'number', source: 'derived', showInList: true, showInCard: true, filterable: true, priorityWeight: 1 },
            { id: 'satisfaction', label: 'Результат', type: 'enum', source: 'manual', showInList: false, showInCard: true, filterable: true, priorityWeight: 0, enumOptions: [
                { value: 'positive', label: 'Положительный' },
                { value: 'neutral', label: 'Нейтральный' },
                { value: 'negative', label: 'Отрицательный' },
            ] },
        ],
        presets: {},
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
        fields: [
            { id: 'promoName', label: 'Название акции', type: 'string', source: 'manual', showInList: true, showInCard: true, filterable: true, priorityWeight: 0 },
            { id: 'promoEndDate', label: 'Дата окончания', type: 'date', source: 'manual', showInList: true, showInCard: true, filterable: true, priorityWeight: 2 },
            { id: 'tripsDuringPromo', label: 'Поездок за акцию', type: 'number', source: 'derived', showInList: true, showInCard: true, filterable: true, priorityWeight: 1 },
        ],
        presets: {},
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

export function getScenarioFields(scenarioId: string): ScenarioFieldDef[] {
    return SCENARIOS[scenarioId]?.fields ?? []
}

export function getScenarioListFields(scenarioId: string): ScenarioFieldDef[] {
    return getScenarioFields(scenarioId).filter(f => f.showInList)
}

export function getScenarioCardFields(scenarioId: string): ScenarioFieldDef[] {
    return getScenarioFields(scenarioId).filter(f => f.showInCard)
}

export function getScenarioFilterableFields(scenarioId: string): ScenarioFieldDef[] {
    return getScenarioFields(scenarioId).filter(f => f.filterable)
}

export function getScenarioPresets(scenarioId: string): ScenarioPresetConfig {
    return SCENARIOS[scenarioId]?.presets ?? {}
}
