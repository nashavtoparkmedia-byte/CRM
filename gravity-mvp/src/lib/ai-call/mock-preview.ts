import type { PreviewScenario } from './scenario-preview'

export type PreviewMockMode = 'normal' | 'transfer' | 'invalid-output'

export interface PreviewTranscriptLine {
    role: 'ai' | 'contact' | 'system'
    text: string
    stepId: string
}

export interface PreviewMockEvent {
    key: string
    sessionId: string
    seq: number
    type: string
    detail: string
}

export interface PreviewMockDecision {
    kind: 'complete' | 'transfer' | 'failed'
    nextAction: 'end_call' | 'transfer_to_manager' | 'none'
    replyText: string
    extractedData: Record<string, string | number | boolean | null>
    qualification: 'qualified' | 'not_qualified' | 'unclear' | null
    transferRequested: boolean
    stopReason: string | null
    validationErrors: string[]
}

export interface PreviewMockRun {
    sessionId: string
    mode: PreviewMockMode
    durationSec: number
    currentStep: string
    selectedBranch: string
    transcript: PreviewTranscriptLine[]
    extractedData: Record<string, string>
    qualificationScore: number
    outcome: string
    events: PreviewMockEvent[]
    decision: PreviewMockDecision
    transfer: {
        requested: boolean
        reason: string | null
        target: string | null
        unavailableFallback: string | null
        summary: string | null
    }
}

function stableHash(value: string): number {
    let hash = 0
    for (let index = 0; index < value.length; index += 1) {
        hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
    }
    return Math.abs(hash)
}

function addEvent(
    events: PreviewMockEvent[],
    sessionId: string,
    type: string,
    detail: string,
) {
    const seq = events.length + 1
    events.push({
        key: `${sessionId}:${seq}:${type}`,
        sessionId,
        seq,
        type,
        detail,
    })
}

function shouldTransfer(scenario: PreviewScenario, answer: string, mode: PreviewMockMode): boolean {
    if (mode === 'transfer') return true
    const normalized = answer.toLowerCase()
    if (scenario.projectType === 'qualification') {
        return !/(нет|не готов|отказ|неинтерес)/.test(normalized)
    }
    if (scenario.projectType === 'churn') {
        return /(готов|верн|услов|предлож)/.test(normalized)
    }
    const score = Number(answer.match(/\d+/)?.[0] ?? 10)
    return score <= 6
}

export function runPreviewMock(input: {
    scenario: PreviewScenario
    phone: string
    contactName: string
    answers: string[]
    mode?: PreviewMockMode
}): PreviewMockRun {
    const mode = input.mode ?? 'normal'
    const answer = input.answers.map((item) => item.trim()).filter(Boolean).join(' ') || 'Ответ не указан'
    const sessionId = `mock-${stableHash(`${input.scenario.id}:${input.phone}:${answer}`)}`
    const events: PreviewMockEvent[] = []
    const transcript: PreviewTranscriptLine[] = []

    addEvent(events, sessionId, 'session_started', 'Локальная mock-сессия создана')
    transcript.push({ role: 'ai', text: input.scenario.introduction, stepId: 'welcome' })
    addEvent(events, sessionId, 'ai_message', 'Вступление показано')

    const question = input.scenario.steps.find((step) => step.type === 'question')
    if (question) {
        transcript.push({ role: 'ai', text: question.content, stepId: question.id })
        transcript.push({ role: 'contact', text: answer, stepId: question.id })
        addEvent(events, sessionId, 'answer_received', 'Тестовый ответ принят')
    }

    const field = input.scenario.requiredFields[0] ?? 'ответ'
    const extractedData = { [field]: answer }
    addEvent(events, sessionId, 'value_extracted', `Собрано поле «${field}»`)

    if (mode === 'invalid-output') {
        const decision: PreviewMockDecision = {
            kind: 'failed',
            nextAction: 'none',
            replyText: '',
            extractedData,
            qualification: null,
            transferRequested: false,
            stopReason: 'invalid_ai_output',
            validationErrors: ['Ответ модели не соответствует AI Decision Contract.'],
        }
        addEvent(events, sessionId, 'decision_validation_failed', decision.validationErrors[0])
        return {
            sessionId,
            mode,
            durationSec: 8,
            currentStep: 'failed',
            selectedBranch: 'Ошибка контракта',
            transcript: [
                ...transcript,
                { role: 'system', text: 'Симуляция безопасно остановлена: некорректный ответ AI.', stepId: 'failed' },
            ],
            extractedData,
            qualificationScore: 0,
            outcome: 'Контролируемая ошибка',
            events,
            decision,
            transfer: {
                requested: false,
                reason: null,
                target: null,
                unavailableFallback: null,
                summary: null,
            },
        }
    }

    const transferRequested = shouldTransfer(input.scenario, answer, mode)
    const decision: PreviewMockDecision = {
        kind: transferRequested ? 'transfer' : 'complete',
        nextAction: transferRequested ? 'transfer_to_manager' : 'end_call',
        replyText: transferRequested
            ? 'Спасибо. Передаю менеджеру краткое резюме разговора.'
            : 'Спасибо за ответы. На этом завершим разговор.',
        extractedData,
        qualification: input.scenario.projectType === 'qualification'
            ? (transferRequested ? 'qualified' : 'not_qualified')
            : 'unclear',
        transferRequested,
        stopReason: transferRequested ? null : 'scenario_complete',
        validationErrors: [],
    }

    transcript.push({
        role: 'ai',
        text: decision.replyText,
        stepId: transferRequested ? 'handoff' : 'finish',
    })
    addEvent(
        events,
        sessionId,
        transferRequested ? 'transfer_requested' : 'session_completed',
        transferRequested ? 'Подготовлена mock-передача менеджеру' : 'Сценарий завершён',
    )

    return {
        sessionId,
        mode,
        durationSec: Math.max(12, transcript.length * 6),
        currentStep: transferRequested ? 'handoff' : 'finish',
        selectedBranch: transferRequested ? 'Передача менеджеру' : 'Завершение',
        transcript,
        extractedData,
        qualificationScore: Math.max(0, Math.min(100, input.scenario.qualificationScore + (transferRequested ? 4 : -18))),
        outcome: transferRequested ? 'Требуется действие менеджера' : input.scenario.resultLabel,
        events,
        decision,
        transfer: {
            requested: transferRequested,
            reason: transferRequested ? input.scenario.transferConditions : null,
            target: transferRequested ? 'Дежурный менеджер проекта' : null,
            unavailableFallback: transferRequested ? 'Создать задачу на обратный звонок' : null,
            summary: transferRequested
                ? `${input.contactName || 'Тестовый контакт'}: ${field} — ${answer}`
                : null,
        },
    }
}
