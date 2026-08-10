import Link from 'next/link'
import { Bot, BookOpen } from 'lucide-react'
import { PageContainer } from '@/components/ui/PageContainer'
import { getCurrentUser } from '@/lib/users/user-service'
import { requireIntegrationAdminPageAccess } from '@/modules/identity-access/public/v1'
import AiControlCenterClient from './AiControlCenterClient'
import {
    getAiConfig,
    getKnowledgeBase,
    getAllImportJobs,
    getDecisionLogs,
    getAiRuntimeStats,
    listAiProfiles,
    getActiveProfileId,
    listKnowledgeSections,
    getKnowledgeStats,
    listExtractionJobs,
    getExtractionQualityTier,
    getKnowledgeReadinessForUi,
} from './actions'

export const dynamic   = 'force-dynamic'
export const revalidate = 0

export default async function AiControlCenterPage() {
    await requireIntegrationAdminPageAccess('/settings/ai')
    const user = await getCurrentUser()
    const canEdit = user?.role === 'Администратор' || user?.role === 'Руководитель'

    const [
        config, kb, importJobs, logs, stats, profiles, activeProfileId,
        knowledgeSections, knowledgeStats, extractionJobs, extractionTier,
        knowledgeReadiness,
    ] = await Promise.all([
        getAiConfig(),
        getKnowledgeBase(),
        getAllImportJobs(10),
        getDecisionLogs({ limit: 30 }),
        getAiRuntimeStats(),
        listAiProfiles(),
        getActiveProfileId(),
        listKnowledgeSections(),
        getKnowledgeStats(),
        listExtractionJobs(10),
        getExtractionQualityTier(),
        getKnowledgeReadinessForUi(),
    ])

    return (
        <PageContainer>
            <div className="flex h-full flex-col p-[8px] mt-[4px]">
                <div className="mb-6">
                    <div className="flex items-center gap-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-100/60 text-violet-600 border shadow-sm">
                            <Bot size={24} />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h1 className="text-3xl font-bold tracking-tight text-foreground">
                                AI в чатах
                            </h1>
                            <p className="text-sm text-muted-foreground mt-1">
                                {canEdit
                                    ? 'AI читает чаты MAX, Telegram и WhatsApp, отвечает на типовые вопросы, сложное передаёт менеджеру.'
                                    : 'Решения AI в чатах. Поставьте 👍 или 👎 — это помогает админу понять, где AI работает хорошо.'}
                            </p>
                        </div>
                        <Link
                            href="/settings/integrations/ai-call-help/ai-control-center"
                            className="inline-flex h-9 flex-shrink-0 items-center gap-1.5 rounded-md border border-[#E0E0E0] bg-white px-3 text-[13px] font-medium text-[#111] transition-colors hover:bg-[#F8F9FA]"
                        >
                            <BookOpen className="h-3.5 w-3.5" />
                            Инструкция
                        </Link>
                    </div>
                </div>

                <AiControlCenterClient
                    initialConfig={config}
                    initialKb={kb}
                    initialImportJobs={importJobs}
                    initialLogs={logs}
                    initialStats={stats}
                    initialProfiles={profiles}
                    initialActiveProfileId={activeProfileId}
                    initialSections={knowledgeSections}
                    initialKnowledgeStats={knowledgeStats}
                    initialExtractionJobs={extractionJobs}
                    initialExtractionTier={extractionTier}
                    initialReadiness={knowledgeReadiness}
                    canEdit={canEdit}
                />
            </div>
        </PageContainer>
    )
}
