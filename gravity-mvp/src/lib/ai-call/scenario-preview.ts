import type { AiCallProjectType } from './product-preview'

export type PreviewStepType =
    | 'message'
    | 'question'
    | 'extract'
    | 'condition'
    | 'transition'
    | 'stop'
    | 'transfer'

export interface PreviewScenarioBranch {
    label: string
    targetStepId: string
}

export interface PreviewScenarioStep {
    id: string
    type: PreviewStepType
    title: string
    content: string
    field?: string
    nextStepId?: string
    branches?: PreviewScenarioBranch[]
}

export interface PreviewScenario {
    id: string
    projectType: AiCallProjectType
    name: string
    goal: string
    introduction: string
    requiredFields: string[]
    stopConditions: string
    transferConditions: string
    retryLimit: number
    resultLabel: string
    qualificationScore: number
    version: number
    isActive: boolean
    steps: PreviewScenarioStep[]
}

export interface PreviewScenarioValidation {
    ok: boolean
    errors: string[]
    warnings: string[]
    reachableStepIds: string[]
}

export const STEP_TYPE_LABELS: Record<PreviewStepType, string> = {
    message: 'Сообщение AI',
    question: 'Вопрос',
    extract: 'Извлечение значения',
    condition: 'Условие',
    transition: 'Переход',
    stop: 'Завершение',
    transfer: 'Передача менеджеру',
}

const COPY: Record<AiCallProjectType, {
    name: string
    goal: string
    introduction: string
    question: string
    field: string
    condition: string
    positive: string
    negative: string
    result: string
    score: number
}> = {
    qualification: {
        name: 'Первичная квалификация',
        goal: 'Понять готовность кандидата и передать подходящего лида менеджеру.',
        introduction: 'Здравствуйте! Я виртуальный помощник Yoko. Задам несколько коротких вопросов.',
        question: 'У вас есть права категории B и когда вы готовы выйти на линию?',
        field: 'готовность_к_выходу',
        condition: 'Кандидат соответствует базовым требованиям?',
        positive: 'Да, готов',
        negative: 'Нет или отказ',
        result: 'Квалификация завершена',
        score: 82,
    },
    churn: {
        name: 'Причина ухода',
        goal: 'Выяснить причину неактивности и определить возможность возврата.',
        introduction: 'Здравствуйте! Хотим понять, что помешало продолжить работу с парком.',
        question: 'Что стало основной причиной, по которой вы перестали выходить на линию?',
        field: 'причина_оттока',
        condition: 'Есть подходящее предложение для возврата?',
        positive: 'Да, обсудить условия',
        negative: 'Нет интереса',
        result: 'Причина оттока определена',
        score: 68,
    },
    survey: {
        name: 'Оценка последнего обращения',
        goal: 'Получить оценку сервиса и конкретное предложение по улучшению.',
        introduction: 'Здравствуйте! Это короткий опрос качества Yoko, он займёт меньше минуты.',
        question: 'Оцените последнее обращение по шкале от 1 до 10. Что можно улучшить?',
        field: 'оценка_качества',
        condition: 'Оценка требует внимания менеджера?',
        positive: 'Оценка 1–6',
        negative: 'Оценка 7–10',
        result: 'Опрос качества завершён',
        score: 74,
    },
}

export function createPreviewScenario(projectType: AiCallProjectType, sequence = 1): PreviewScenario {
    const copy = COPY[projectType]
    return {
        id: `scenario-${projectType}-${sequence}`,
        projectType,
        name: copy.name,
        goal: copy.goal,
        introduction: copy.introduction,
        requiredFields: [copy.field],
        stopConditions: 'Собеседник отказался продолжать или сценарий завершён.',
        transferConditions: 'Собеседник просит человека или требуется решение менеджера.',
        retryLimit: 2,
        resultLabel: copy.result,
        qualificationScore: copy.score,
        version: 1,
        isActive: true,
        steps: [
            {
                id: 'welcome',
                type: 'message',
                title: 'Вступление',
                content: copy.introduction,
                nextStepId: 'main-question',
            },
            {
                id: 'main-question',
                type: 'question',
                title: 'Основной вопрос',
                content: copy.question,
                nextStepId: 'extract-value',
            },
            {
                id: 'extract-value',
                type: 'extract',
                title: 'Сохранить ответ',
                content: `Извлечь поле «${copy.field}» из ответа.`,
                field: copy.field,
                nextStepId: 'decision',
            },
            {
                id: 'decision',
                type: 'condition',
                title: copy.condition,
                content: 'Выбрать ветку только по собранным данным.',
                branches: [
                    { label: copy.positive, targetStepId: 'handoff-path' },
                    { label: copy.negative, targetStepId: 'finish' },
                ],
            },
            {
                id: 'handoff-path',
                type: 'transition',
                title: 'Подготовить передачу',
                content: 'Кратко объяснить следующий шаг.',
                nextStepId: 'handoff',
            },
            {
                id: 'handoff',
                type: 'transfer',
                title: 'Передача менеджеру',
                content: 'Собрать резюме и показать mock-состояние передачи.',
            },
            {
                id: 'finish',
                type: 'stop',
                title: 'Завершить разговор',
                content: 'Поблагодарить собеседника и сохранить результат.',
            },
        ],
    }
}

export function validatePreviewScenario(scenario: PreviewScenario): PreviewScenarioValidation {
    const errors: string[] = []
    const warnings: string[] = []
    const steps = scenario.steps
    const ids = new Set<string>()

    if (!scenario.name.trim()) errors.push('Укажите название сценария.')
    if (!scenario.goal.trim()) errors.push('Укажите цель сценария.')
    if (!scenario.introduction.trim()) errors.push('Добавьте вступление.')
    if (scenario.retryLimit < 0 || scenario.retryLimit > 3) errors.push('Количество повторов должно быть от 0 до 3.')
    if (steps.length === 0) errors.push('Добавьте хотя бы один шаг.')

    for (const step of steps) {
        if (!step.id.trim()) errors.push('У каждого шага должен быть идентификатор.')
        if (ids.has(step.id)) errors.push(`Повторяется шаг «${step.id}».`)
        ids.add(step.id)
        if (!step.title.trim()) errors.push(`У шага «${step.id || 'без имени'}» нет названия.`)
    }

    const targets = (step: PreviewScenarioStep): string[] => {
        if (step.type === 'condition') return (step.branches ?? []).map((branch) => branch.targetStepId)
        return step.nextStepId ? [step.nextStepId] : []
    }

    for (const step of steps) {
        if (step.type === 'condition' && (!step.branches || step.branches.length < 2)) {
            errors.push(`Условие «${step.title}» должно иметь минимум две ветки.`)
        }
        if (!['condition', 'stop', 'transfer'].includes(step.type) && !step.nextStepId) {
            errors.push(`У шага «${step.title}» отсутствует переход.`)
        }
        for (const target of targets(step)) {
            if (!ids.has(target)) errors.push(`Шаг «${step.title}» ведёт в отсутствующий переход «${target}».`)
        }
    }

    const reachable = new Set<string>()
    const visiting = new Set<string>()
    let hasCycle = false
    const byId = new Map(steps.map((step) => [step.id, step]))

    function visit(id: string) {
        if (visiting.has(id)) {
            hasCycle = true
            return
        }
        if (reachable.has(id)) return
        const step = byId.get(id)
        if (!step) return
        visiting.add(id)
        reachable.add(id)
        for (const target of targets(step)) visit(target)
        visiting.delete(id)
    }

    if (steps[0]) visit(steps[0].id)
    if (hasCycle) errors.push('Обнаружен бесконечный цикл. Добавьте явное завершение вместо возврата назад.')

    for (const step of steps) {
        if (!reachable.has(step.id)) errors.push(`Шаг «${step.title}» недостижим из начала сценария.`)
    }

    if (!steps.some((step) => step.type === 'stop')) warnings.push('Нет отдельного шага завершения.')
    if (!steps.some((step) => step.type === 'transfer')) warnings.push('Нет ветки передачи менеджеру.')
    if (scenario.requiredFields.length === 0) warnings.push('Не выбраны обязательные поля результата.')

    return {
        ok: errors.length === 0,
        errors: [...new Set(errors)],
        warnings,
        reachableStepIds: [...reachable],
    }
}

export function nextScenarioVersion(scenario: PreviewScenario): PreviewScenario {
    return { ...scenario, version: scenario.version + 1 }
}
