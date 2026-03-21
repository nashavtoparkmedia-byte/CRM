import { getThresholdSettings } from './actions'
import { ScoringSettingsClient } from './ScoringSettingsClient'

export const dynamic = 'force-dynamic'

export default async function ScoringSettingsPage() {
    const thresholds = await getThresholdSettings()

    return (
        <div className="flex flex-col gap-8 max-w-2xl">
            <div>
                <h1 className="text-2xl font-bold text-foreground">Настройки скоринга</h1>
                <p className="text-sm text-muted-foreground mt-1">
                    Управление порогами для автоматического расчёта сегментов и статусов водителей
                </p>
            </div>
            <ScoringSettingsClient initialThresholds={thresholds} />
        </div>
    )
}
