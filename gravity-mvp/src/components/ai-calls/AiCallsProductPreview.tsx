'use client'

import { useMemo, useState } from 'react'
import {
    Archive,
    Bot,
    ChevronRight,
    CirclePause,
    CirclePlay,
    FlaskConical,
    Pencil,
    Plus,
    Settings2,
} from 'lucide-react'
import {
    createPreviewProject,
    PREVIEW_PROJECTS,
    PROJECT_TYPE_META,
    setPreviewProjectStatus,
    updatePreviewProject,
    type AiCallProjectType,
    type PreviewProject,
} from '@/lib/ai-call/product-preview'

type PreviewView = 'projects' | 'scenario' | 'run' | 'result' | 'settings'

const NAV_ITEMS: Array<{ id: PreviewView; label: string }> = [
    { id: 'projects', label: 'Проекты' },
    { id: 'scenario', label: 'Сценарий' },
    { id: 'run', label: 'Тестовый запуск' },
    { id: 'result', label: 'Результат' },
    { id: 'settings', label: 'Настройки' },
]

function statusLabel(status: PreviewProject['status']) {
    if (status === 'active') return 'Активен'
    if (status === 'paused') return 'Остановлен'
    return 'В архиве'
}

export function AiCallsProductPreview() {
    const [view, setView] = useState<PreviewView>('projects')
    const [projects, setProjects] = useState<PreviewProject[]>(PREVIEW_PROJECTS)
    const [selectedProjectId, setSelectedProjectId] = useState(PREVIEW_PROJECTS[0].id)
    const [editorProjectId, setEditorProjectId] = useState<string | null>(null)
    const [isCreating, setIsCreating] = useState(false)
    const [draftName, setDraftName] = useState('')
    const [draftType, setDraftType] = useState<AiCallProjectType>('qualification')
    const [message, setMessage] = useState<string | null>(null)

    const visibleProjects = useMemo(
        () => projects.filter((project) => project.status !== 'archived'),
        [projects],
    )
    const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0]

    function saveProject() {
        try {
            if (editorProjectId) {
                setProjects((current) => current.map((project) =>
                    project.id === editorProjectId
                        ? updatePreviewProject(project, { name: draftName, type: draftType })
                        : project,
                ))
                setMessage('Проект обновлён')
            } else {
                const project = createPreviewProject(draftName, draftType, projects.length + 1)
                setProjects((current) => [...current, project])
                setSelectedProjectId(project.id)
                setMessage('Проект создан в остановленном состоянии')
            }
            setIsCreating(false)
            setEditorProjectId(null)
            setDraftName('')
        } catch (error) {
            setMessage(error instanceof Error ? error.message : 'Не удалось сохранить проект')
        }
    }

    function startEdit(project: PreviewProject) {
        setEditorProjectId(project.id)
        setDraftName(project.name)
        setDraftType(project.type)
        setIsCreating(true)
        setMessage(null)
    }

    function toggleProject(project: PreviewProject) {
        setProjects((current) => current.map((item) =>
            item.id === project.id
                ? setPreviewProjectStatus(item, item.status === 'active' ? 'paused' : 'active')
                : item,
        ))
    }

    function archiveProject(project: PreviewProject) {
        setProjects((current) => current.map((item) =>
            item.id === project.id ? setPreviewProjectStatus(item, 'archived') : item,
        ))
        setMessage(`Проект «${project.name}» перемещён в архив`)
    }

    function openProject(project: PreviewProject, nextView: PreviewView) {
        setSelectedProjectId(project.id)
        setView(nextView)
    }

    return (
        <main className="min-h-screen bg-[#F1F5FD] px-4 py-6 text-[#0F172A] sm:px-6 lg:px-8">
            <div className="mx-auto max-w-6xl">
                <header className="mb-5 flex flex-col gap-4 rounded-xl border border-[#E4ECFC] bg-white p-5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-3">
                        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[#E8F5FD] text-[#2AABEE]">
                            <Bot className="h-5 w-5" />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <h1 className="text-xl font-semibold tracking-[-0.3px]">AI-обзвон</h1>
                                <span className="rounded-full bg-[#FFF7E6] px-2 py-0.5 text-xs font-medium text-[#A16207]">
                                    DEV Preview
                                </span>
                            </div>
                            <p className="text-sm text-[#64748B]">Без реальных звонков, SIP и production-записей</p>
                        </div>
                    </div>
                    <div className="inline-flex items-center gap-2 rounded-lg border border-[#E4ECFC] px-3 py-2 text-sm text-[#64748B]">
                        <FlaskConical className="h-4 w-4 text-[#059669]" />
                        Только безопасная симуляция
                    </div>
                </header>

                <nav className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-[#E4ECFC] bg-white p-1">
                    {NAV_ITEMS.map((item) => (
                        <button
                            key={item.id}
                            type="button"
                            onClick={() => setView(item.id)}
                            className={`min-h-11 whitespace-nowrap rounded-lg px-4 text-sm font-medium transition-colors ${
                                view === item.id
                                    ? 'bg-[#2AABEE] text-white'
                                    : 'text-[#64748B] hover:bg-[#F1F5FD] hover:text-[#0F172A]'
                            }`}
                        >
                            {item.label}
                        </button>
                    ))}
                </nav>

                {view === 'projects' ? (
                    <section className="rounded-xl border border-[#E4ECFC] bg-white">
                        <div className="flex flex-col gap-3 border-b border-[#E4ECFC] p-5 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                                <h2 className="text-[17px] font-semibold">Проекты обзвона</h2>
                                <p className="mt-1 text-sm text-[#64748B]">Создайте проект и проверьте сценарий на mock-диалоге.</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => {
                                    setIsCreating(true)
                                    setEditorProjectId(null)
                                    setDraftName('')
                                    setDraftType('qualification')
                                    setMessage(null)
                                }}
                                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#2AABEE] px-4 text-[15px] font-semibold text-white hover:bg-[#1E96D4]"
                            >
                                <Plus className="h-4 w-4" />
                                Создать проект
                            </button>
                        </div>

                        {message && (
                            <div className="mx-5 mt-4 rounded-lg bg-[#ECFDF5] px-3 py-2 text-sm text-[#047857]">{message}</div>
                        )}

                        {visibleProjects.length === 0 ? (
                            <div className="flex flex-col items-center px-5 py-16 text-center">
                                <Bot className="mb-3 h-9 w-9 text-[#2AABEE]" />
                                <h3 className="text-[17px] font-semibold">Проектов пока нет</h3>
                                <p className="mt-1 max-w-sm text-sm text-[#64748B]">Создайте первый проект и настройте безопасный тестовый сценарий.</p>
                            </div>
                        ) : (
                            <div className="divide-y divide-[#E4ECFC]">
                                {visibleProjects.map((project) => {
                                    const meta = PROJECT_TYPE_META[project.type]
                                    return (
                                        <article key={project.id} className="p-5 hover:bg-[#F8FAFE]">
                                            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                                                <div className="min-w-0">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <h3 className="font-semibold">{project.name}</h3>
                                                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                                                            project.status === 'active'
                                                                ? 'bg-[#ECFDF5] text-[#047857]'
                                                                : 'bg-[#F1F5FD] text-[#64748B]'
                                                        }`}>
                                                            {statusLabel(project.status)}
                                                        </span>
                                                    </div>
                                                    <p className="mt-1 text-sm text-[#64748B]">{meta.label} · {meta.description}</p>
                                                    <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[#64748B]">
                                                        <span>Сценарий: <b className="font-medium text-[#0F172A]">{project.activeScenarioName}</b></span>
                                                        <span>Mock-запусков: <b className="font-medium text-[#0F172A]">{project.mockRuns}</b></span>
                                                        <span>Изменён: <b className="font-medium text-[#0F172A]">{project.updatedAt}</b></span>
                                                    </div>
                                                </div>
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <button
                                                        type="button"
                                                        onClick={() => startEdit(project)}
                                                        className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-[#E4ECFC] px-3 text-sm font-medium hover:bg-[#F1F5FD]"
                                                    >
                                                        <Pencil className="h-4 w-4" />
                                                        Изменить
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => toggleProject(project)}
                                                        className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-[#E4ECFC] px-3 text-sm font-medium hover:bg-[#F1F5FD]"
                                                    >
                                                        {project.status === 'active' ? <CirclePause className="h-4 w-4" /> : <CirclePlay className="h-4 w-4" />}
                                                        {project.status === 'active' ? 'Остановить' : 'Активировать'}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => openProject(project, 'run')}
                                                        className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#2AABEE] px-3 text-sm font-semibold text-white hover:bg-[#1E96D4]"
                                                    >
                                                        Запустить проверку
                                                        <ChevronRight className="h-4 w-4" />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => archiveProject(project)}
                                                        aria-label={`Архивировать ${project.name}`}
                                                        className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-[#E4ECFC] text-[#64748B] hover:bg-[#FEF2F2] hover:text-[#DC2626]"
                                                    >
                                                        <Archive className="h-4 w-4" />
                                                    </button>
                                                </div>
                                            </div>
                                        </article>
                                    )
                                })}
                            </div>
                        )}
                    </section>
                ) : (
                    <section className="rounded-xl border border-[#E4ECFC] bg-white p-8 text-center">
                        <Settings2 className="mx-auto h-8 w-8 text-[#2AABEE]" />
                        <h2 className="mt-3 text-[17px] font-semibold">{NAV_ITEMS.find((item) => item.id === view)?.label}</h2>
                        <p className="mt-1 text-sm text-[#64748B]">
                            {selectedProject ? `Проект: ${selectedProject.name}.` : ''} Раздел будет подключён следующим изолированным commit.
                        </p>
                    </section>
                )}
            </div>

            {isCreating && (
                <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
                    <div className="w-full max-w-lg rounded-xl bg-white p-6">
                        <h2 className="text-[17px] font-semibold">{editorProjectId ? 'Изменить проект' : 'Новый проект'}</h2>
                        <label className="mt-5 block text-[13px] font-medium">Название</label>
                        <input
                            value={draftName}
                            onChange={(event) => setDraftName(event.target.value)}
                            placeholder="Например, Возврат водителей"
                            className="mt-1 h-11 w-full rounded-lg border border-[#E4ECFC] px-3 outline-none focus:border-[#2AABEE]"
                        />
                        <label className="mt-4 block text-[13px] font-medium">Тип проекта</label>
                        <div className="mt-2 grid gap-2">
                            {(Object.keys(PROJECT_TYPE_META) as AiCallProjectType[]).map((type) => (
                                <button
                                    key={type}
                                    type="button"
                                    onClick={() => setDraftType(type)}
                                    className={`rounded-lg border p-3 text-left ${
                                        draftType === type
                                            ? 'border-[#2AABEE] bg-[#F0F9FF]'
                                            : 'border-[#E4ECFC] hover:bg-[#F1F5FD]'
                                    }`}
                                >
                                    <span className="text-sm font-medium">{PROJECT_TYPE_META[type].label}</span>
                                    <span className="mt-0.5 block text-xs text-[#64748B]">{PROJECT_TYPE_META[type].description}</span>
                                </button>
                            ))}
                        </div>
                        <div className="mt-6 flex justify-end gap-2">
                            <button
                                type="button"
                                onClick={() => setIsCreating(false)}
                                className="min-h-11 rounded-lg border border-[#E4ECFC] px-4 text-sm font-semibold"
                            >
                                Отмена
                            </button>
                            <button
                                type="button"
                                onClick={saveProject}
                                className="min-h-11 rounded-lg bg-[#2AABEE] px-4 text-sm font-semibold text-white hover:bg-[#1E96D4]"
                            >
                                Сохранить
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </main>
    )
}
