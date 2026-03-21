import { getTriggers } from './actions'
import { TriggerSettingsClient } from './TriggerSettingsClient'

export const dynamic = 'force-dynamic'

export default async function TriggerSettingsPage() {
    const triggers = await getTriggers()

    return (
        <div className="flex flex-col gap-8 max-w-3xl">
            <div>
                <h1 className="text-2xl font-bold text-foreground">Настройки триггеров</h1>
                <p className="text-sm text-muted-foreground mt-1">
                    Правила автоматических сообщений и задач для менеджеров
                </p>
            </div>
            <TriggerSettingsClient initialTriggers={triggers} />
        </div>
    )
}
