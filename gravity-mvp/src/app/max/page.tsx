import { getMaxConnections } from "../max-actions"
import MaxLoginClient from "./MaxLoginClient"
import { MessageSquare } from "lucide-react"

export const dynamic = "force-dynamic"
export const revalidate = 0

export default async function MaxPage() {
    const connections = await getMaxConnections()

    return (
        <div className="flex h-full flex-col bg-background p-8">
            <div className="mb-8">
                <div className="flex items-center gap-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-100/50 text-blue-600">
                        <MessageSquare size={24} />
                    </div>
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-foreground">
                            MAX Интеграция
                        </h1>
                        <p className="text-sm text-muted-foreground mt-1">
                            Подключение и управление ботами мессенджера MAX
                        </p>
                    </div>
                </div>
            </div>

            <MaxLoginClient initialConnections={connections} />
        </div>
    )
}
