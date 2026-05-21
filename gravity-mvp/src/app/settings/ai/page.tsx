import { Bot } from 'lucide-react'
import { PageContainer } from '@/components/ui/PageContainer'
import { SectionDescription } from '@/components/ui/SectionDescription'
import AiControlCenterClient from './AiControlCenterClient'
import {
    getAiConfig,
    getKnowledgeBase,
    getAllImportJobs,
    getDecisionLogs,
    getAiRuntimeStats,
} from './actions'

export const dynamic   = 'force-dynamic'
export const revalidate = 0

export default async function AiControlCenterPage() {
    const [config, kb, importJobs, logs, stats] = await Promise.all([
        getAiConfig(),
        getKnowledgeBase(),
        getAllImportJobs(10),
        getDecisionLogs({ limit: 30 }),
        getAiRuntimeStats(),
    ])

    return (
        <PageContainer>
            <div className="flex h-full flex-col p-8 mt-4">
                <div className="mb-6">
                    <div className="flex items-center gap-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-100/60 text-violet-600 border shadow-sm">
                            <Bot size={24} />
                        </div>
                        <div>
                            <h1 className="text-3xl font-bold tracking-tight text-foreground">
                                AI Control Center
                            </h1>
                            <p className="text-sm text-muted-foreground mt-1">
                                Управление агентом, база знаний, правила эскалации, синхронизация истории
                            </p>
                        </div>
                    </div>
                </div>

                <AiControlCenterClient
                    initialConfig={config}
                    initialKb={kb}
                    initialImportJobs={importJobs}
                    initialLogs={logs}
                    initialStats={stats}
                />
            </div>
        </PageContainer>
    )
}
