/**
 * Mock payload generator for AI-call testing without Yandex STT/TTS.
 *
 * Returns a plausibly-shaped completed AI call: transcript chunks, summary,
 * qualification JSON (matches the schema agreed for MVP). Variations by
 * mock variant let the test cover both qualified and not_qualified paths.
 *
 * Switched on by AI_CALL_MOCK_MODE=true; no API keys involved.
 */

export type MockVariant = 'qualified' | 'not_qualified' | 'unclear'

export interface MockAiCallResult {
    transcript: string
    aiSummary: string
    aiSessionStatus: 'ended' | 'failed'
    durationSec: number
    qualificationResult: {
        qualification_status: 'qualified' | 'not_qualified' | 'unclear'
        reason: string
        lead_summary: string
        answers: {
            has_license: boolean | null
            license_categories: string[]
            experience_years: number | null
            city: string | null
            desired_schedule: 'day' | 'night' | 'shifts' | 'any' | 'unknown'
            ready_to_start_within_days: number | null
            objections: string[]
        }
        manager_task: {
            should_create: boolean
            priority: 'high' | 'normal' | 'low'
            summary: string
        }
    }
    estimatedCostRub: number
}

const VARIANTS: Record<MockVariant, MockAiCallResult> = {
    qualified: {
        transcript: [
            '[AI] Здравствуйте, это автоматический звонок от компании НашАвтоПарк по вашей заявке. Разговор записывается. Удобно сейчас минуту обсудить?',
            '[Лид] Да, давайте.',
            '[AI] Отлично. Есть ли у вас водительские права категории B и какой стаж?',
            '[Лид] Права B, стаж семь лет.',
            '[AI] Хорошо. Планируете работать на своей машине или интересует аренда?',
            '[Лид] Аренда.',
            '[AI] Понял. Какой график удобен — день, ночь или сменно?',
            '[Лид] Лучше дневные смены.',
            '[AI] В каком городе планируете работать?',
            '[Лид] Москва, северный округ.',
            '[AI] Когда могли бы пройти оформление — на этой неделе или на следующей?',
            '[Лид] На этой, в пятницу свободен.',
            '[AI] Отлично, всё записал. Сейчас передам менеджеру — он перезвонит и расскажет про конкретные условия и оформление. Спасибо за время.',
        ].join('\n'),
        aiSummary:
            'Лид Иван, 7 лет стажа, категория B, интересуется арендой авто, готов на дневные смены в Москве (северный округ), готов оформиться в пятницу.',
        aiSessionStatus: 'ended',
        durationSec: 118,
        qualificationResult: {
            qualification_status: 'qualified',
            reason: 'Все 5 квалификационных вопросов закрыты, лид готов оформиться в течение недели.',
            lead_summary:
                '7 лет стажа кат. B · аренда · дневные смены · Москва С · готов в пятницу',
            answers: {
                has_license: true,
                license_categories: ['B'],
                experience_years: 7,
                city: 'Москва',
                desired_schedule: 'day',
                ready_to_start_within_days: 3,
                objections: [],
            },
            manager_task: {
                should_create: true,
                priority: 'high',
                summary:
                    'Перезвонить лиду до конца дня: согласовать условия аренды и время приёма в пятницу.',
            },
        },
        estimatedCostRub: 6.4,
    },

    not_qualified: {
        transcript: [
            '[AI] Здравствуйте, это автоматический звонок от компании НашАвтоПарк по вашей заявке. Разговор записывается. Удобно сейчас минуту обсудить?',
            '[Лид] Я уже устроился в другой парк, спасибо.',
            '[AI] Понял, спасибо что уделили время.',
        ].join('\n'),
        aiSummary: 'Лид уже работает в другом парке, отказался продолжать разговор.',
        aiSessionStatus: 'ended',
        durationSec: 18,
        qualificationResult: {
            qualification_status: 'not_qualified',
            reason: 'Лид сообщил, что уже работает в другом таксопарке.',
            lead_summary: 'Уже работает в конкурентном парке',
            answers: {
                has_license: null,
                license_categories: [],
                experience_years: null,
                city: null,
                desired_schedule: 'unknown',
                ready_to_start_within_days: null,
                objections: ['already_working_elsewhere'],
            },
            manager_task: {
                should_create: false,
                priority: 'low',
                summary: '',
            },
        },
        estimatedCostRub: 1.2,
    },

    unclear: {
        transcript: [
            '[AI] Здравствуйте, это автоматический звонок от компании НашАвтоПарк по вашей заявке. Разговор записывается. Удобно сейчас минуту обсудить?',
            '[Лид] Алло, плохо слышно, что? шум на фоне',
            '[AI] Извините, не слышу вас. Передаю менеджеру, он перезвонит.',
        ].join('\n'),
        aiSummary: 'Связь была плохая, лида не услышали. Передано менеджеру для ручного перезвона.',
        aiSessionStatus: 'ended',
        durationSec: 14,
        qualificationResult: {
            qualification_status: 'unclear',
            reason: 'Шумная линия / низкое качество распознавания.',
            lead_summary: 'Связь не позволила провести квалификацию',
            answers: {
                has_license: null,
                license_categories: [],
                experience_years: null,
                city: null,
                desired_schedule: 'unknown',
                ready_to_start_within_days: null,
                objections: ['poor_audio_quality'],
            },
            manager_task: {
                should_create: true,
                priority: 'normal',
                summary: 'Перезвонить лиду вручную — AI-звонок не смог распознать ответы.',
            },
        },
        estimatedCostRub: 0.9,
    },
}

export function getMockPayload(variant: MockVariant = 'qualified'): MockAiCallResult {
    return VARIANTS[variant]
}

export function pickRandomVariant(): MockVariant {
    const r = Math.random()
    if (r < 0.6) return 'qualified'
    if (r < 0.9) return 'not_qualified'
    return 'unclear'
}
