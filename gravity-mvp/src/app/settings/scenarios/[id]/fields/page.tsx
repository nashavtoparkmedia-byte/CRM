import { notFound } from 'next/navigation'
import { getScenario } from '@/lib/tasks/scenario-config'
import { getScenarioFieldsConfig } from '../../actions'
import ScenarioFieldsSettingsClient from './ScenarioFieldsSettingsClient'

export default async function ScenarioFieldsSettingsPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    const scenario = getScenario(id)
    if (!scenario) notFound()

    const fields = await getScenarioFieldsConfig(id)

    return (
        <div className="flex flex-col p-6 max-w-[1100px]">
            <div className="mb-5">
                <div className="text-[12px] text-[#9ca3af] mb-1">
                    Настройки → Сценарий → {scenario.label}
                </div>
                <h1 className="text-[22px] font-bold text-[#1f2937] tracking-tight">
                    Поля списка — {scenario.label}
                </h1>
                <p className="text-[13px] text-[#9ca3af] mt-0.5">
                    Управление тем, какие поля отображаются в строке списка задач сценария, их порядком и использованием в фильтрах/сортировке/группировке.
                </p>
            </div>

            <ScenarioFieldsSettingsClient scenarioId={id} initialFields={fields} />
        </div>
    )
}
