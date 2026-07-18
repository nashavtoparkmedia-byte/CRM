export type AiCallProjectType = 'qualification' | 'churn' | 'survey'
export type AiCallProjectStatus = 'active' | 'paused' | 'archived'

export interface PreviewProject {
    id: string
    name: string
    type: AiCallProjectType
    status: AiCallProjectStatus
    activeScenarioName: string
    mockRuns: number
    updatedAt: string
}

export const PROJECT_TYPE_META: Record<AiCallProjectType, {
    label: string
    description: string
}> = {
    qualification: {
        label: 'Квалификация лида',
        description: 'Проверить интерес, условия и готовность перейти к менеджеру.',
    },
    churn: {
        label: 'Возврат водителя',
        description: 'Выяснить причину оттока и предложить подходящий следующий шаг.',
    },
    survey: {
        label: 'Опрос качества',
        description: 'Собрать оценку сервиса и конкретную обратную связь.',
    },
}

export const PREVIEW_PROJECTS: PreviewProject[] = [
    {
        id: 'preview-qualification',
        name: 'Новые водители',
        type: 'qualification',
        status: 'active',
        activeScenarioName: 'Первичная квалификация',
        mockRuns: 12,
        updatedAt: 'Сегодня, 11:40',
    },
    {
        id: 'preview-churn',
        name: 'Возврат неактивных',
        type: 'churn',
        status: 'paused',
        activeScenarioName: 'Причина ухода',
        mockRuns: 7,
        updatedAt: 'Вчера, 18:15',
    },
    {
        id: 'preview-survey',
        name: 'Качество поддержки',
        type: 'survey',
        status: 'active',
        activeScenarioName: 'Оценка последнего обращения',
        mockRuns: 4,
        updatedAt: '17 июля, 16:20',
    },
]

export function validatePreviewProjectName(name: string): string {
    const cleanName = name.trim()
    if (cleanName.length < 3) throw new Error('Название должно содержать минимум 3 символа')
    return cleanName
}

export function createPreviewProject(
    name: string,
    type: AiCallProjectType,
    sequence: number,
): PreviewProject {
    const cleanName = validatePreviewProjectName(name)
    return {
        id: `preview-${type}-${sequence}`,
        name: cleanName,
        type,
        status: 'paused',
        activeScenarioName: 'Сценарий не выбран',
        mockRuns: 0,
        updatedAt: 'Только что',
    }
}

export function updatePreviewProject(
    project: PreviewProject,
    patch: Pick<PreviewProject, 'name' | 'type'>,
): PreviewProject {
    return {
        ...project,
        name: validatePreviewProjectName(patch.name),
        type: patch.type,
        updatedAt: 'Только что',
    }
}

export function setPreviewProjectStatus(
    project: PreviewProject,
    status: AiCallProjectStatus,
): PreviewProject {
    return { ...project, status, updatedAt: 'Только что' }
}
