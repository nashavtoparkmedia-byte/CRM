import { getMaxConnections } from "../../../max-actions"
import MaxLoginClient from "./MaxLoginClient"
import { MessageSquare } from "lucide-react"
import { SectionDescription } from '@/components/ui/SectionDescription'
import { PageContainer } from '@/components/ui/PageContainer'

export const dynamic = "force-dynamic"
export const revalidate = 0

export default async function MaxSettingsPage() {
    const connections = await getMaxConnections()

    return (
        <PageContainer>
            <div className="flex flex-col gap-8 animate-in fade-in duration-500 pb-12">
                <div className="flex items-start gap-3 border-b pb-6">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-600 mt-0.5">
                        <MessageSquare size={18} />
                    </div>
                    <div>
                        <h1 className="text-2xl font-bold text-foreground">MAX</h1>
                        <p className="text-sm text-muted-foreground mt-1">
                            Подключение и управление ботами мессенджера MAX
                        </p>
                        <SectionDescription sectionKey="settings_max" />
                    </div>
                </div>

                <MaxLoginClient initialConnections={connections} />
            </div>
        </PageContainer>
    )
}
