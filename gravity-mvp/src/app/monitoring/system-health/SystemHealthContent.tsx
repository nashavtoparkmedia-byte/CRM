'use client'

import { useRouter } from 'next/navigation'
import type { SystemHealthData } from './actions'

interface Props {
    data: SystemHealthData
}

const STATUS_DOT: Record<string, string> = {
    normal: 'bg-green-500',
    warning: 'bg-yellow-500',
    critical: 'bg-red-500',
    stale: 'bg-orange-400',
    unknown: 'bg-gray-300',
}

const STATUS_LABEL: Record<string, string> = {
    normal: 'Норма',
    warning: 'Внимание',
    critical: 'Критично',
    stale: 'Устарело',
    unknown: 'Нет данных',
}

export default function SystemHealthContent({ data }: Props) {
    const router = useRouter()
    const { cronSummary, failureDetection, integrityReports, slowOperations, perfSummary, activeLocks, stabilityReports, configValidation, cronValidation, runtimeGuardrails, recentConfigChanges, backgroundJobs } = data

    const overallStatus = failureDetection.overallStatus

    return (
        <div className="max-w-4xl mx-auto px-4 py-6 space-y-5">
            {/* Header */}
            <div className="flex items-center justify-between">
                <h1 className="text-[20px] font-semibold text-[#0F172A]">Здоровье системы</h1>
                <button
                    onClick={() => router.refresh()}
                    className="text-[13px] text-[#2AABEE] font-medium hover:underline"
                >
                    Обновить
                </button>
            </div>

            {/* Overall status */}
            <div className="bg-white rounded-xl border border-[#e5e7eb] px-4 py-3">
                <div className="flex items-center gap-2.5">
                    <div className={`w-3 h-3 rounded-full shrink-0 ${STATUS_DOT[overallStatus]}`} />
                    <span className="text-[15px] font-medium text-[#0F172A]">
                        Общий статус: {STATUS_LABEL[overallStatus]}
                    </span>
                    <span className="text-[12px] text-[#94A3B8] ml-auto">
                        {new Date(data.fetchedAt).toLocaleTimeString('ru-RU')}
                    </span>
                </div>
            </div>

            {/* Guardrails */}
            <Section title="Защитные ограничения">
                <div className="space-y-2">
                    <div className="flex items-center gap-2.5">
                        <div className={`w-2 h-2 rounded-full shrink-0 ${configValidation.valid ? 'bg-green-500' : 'bg-red-500'}`} />
                        <span className="text-[13px] text-[#0F172A]">Конфигурация</span>
                        <span className="text-[12px] text-[#94A3B8]">
                            {configValidation.checkedRules} правил · {configValidation.valid ? 'валидна' : `${configValidation.errors.length} ошибок`}
                        </span>
                    </div>
                    {!configValidation.valid && configValidation.errors.map((err, i) => (
                        <div key={i} className="text-[12px] text-red-500 ml-4">{err}</div>
                    ))}
                    <div className="flex items-center gap-2.5">
                        <div className={`w-2 h-2 rounded-full shrink-0 ${cronValidation.valid ? 'bg-green-500' : 'bg-red-500'}`} />
                        <span className="text-[13px] text-[#0F172A]">Cron-расписания</span>
                        <span className="text-[12px] text-[#94A3B8]">
                            {cronValidation.schedules} задач · {cronValidation.valid ? 'валидны' : `${cronValidation.errors.length} ошибок`}
                        </span>
                    </div>
                    <div className="flex items-center gap-2.5">
                        <div className={`w-2 h-2 rounded-full shrink-0 ${runtimeGuardrails.status === 'ok' ? 'bg-green-500' : runtimeGuardrails.status === 'warning' ? 'bg-yellow-500' : 'bg-red-500'}`} />
                        <span className="text-[13px] text-[#0F172A]">Runtime-гарантии</span>
                        <span className="text-[12px] text-[#94A3B8]">
                            {runtimeGuardrails.violations.length === 0 ? 'без нарушений' : `${runtimeGuardrails.violations.length} нарушений`}
                        </span>
                    </div>
                    {runtimeGuardrails.violations.map((v, i) => (
                        <div key={i} className={`text-[12px] ml-4 ${v.severity === 'critical' ? 'text-red-500' : 'text-yellow-600'}`}>
                            {v.description}
                        </div>
                    ))}
                </div>
            </Section>

            {/* Recent config changes */}
            {recentConfigChanges.length > 0 && (
                <Section title="Последние изменения конфигурации">
                    <div className="space-y-1">
                        {recentConfigChanges.map(c => (
                            <div key={c.id} className="flex items-center gap-2.5 py-1.5 text-[12px]">
                                <span className="text-[#0F172A] font-medium">{c.parameterName}</span>
                                {c.previousValue && <span className="text-[#94A3B8] line-through">{c.previousValue}</span>}
                                <span className="text-green-600">{c.newValue}</span>
                                <span className="text-[#94A3B8] ml-auto">{new Date(c.changedAt).toLocaleString('ru-RU')}</span>
                            </div>
                        ))}
                    </div>
                </Section>
            )}

            {/* Stability check history */}
            {stabilityReports.length > 0 && (
                <Section title="Проверки стабильности">
                    <div className="space-y-1">
                        {stabilityReports.map(r => (
                            <div key={r.id} className="flex items-center gap-2.5 py-1.5">
                                <div className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[r.status] || 'bg-gray-300'}`} />
                                <span className="text-[13px] text-[#0F172A]">
                                    {new Date(r.checkedAt).toLocaleString('ru-RU')}
                                </span>
                                <span className="text-[12px] text-[#94A3B8]">
                                    {r.scope} · {r.anomalyCount === 0 ? 'без аномалий' : `${r.anomalyCount} аномалий`}
                                </span>
                                <span className={`text-[12px] font-medium ml-auto ${r.status === 'stable' ? 'text-green-600' : r.status === 'warning' ? 'text-yellow-600' : r.status === 'critical' ? 'text-red-600' : 'text-gray-400'}`}>
                                    {STATUS_LABEL[r.status] || r.status}
                                </span>
                            </div>
                        ))}
                    </div>
                </Section>
            )}

            {/* Failure detection per operation */}
            {failureDetection.operations.length > 0 && (
                <Section title="Статус операций">
                    <div className="space-y-1">
                        {failureDetection.operations.map(op => (
                            <div key={op.operationName} className="flex items-center gap-2.5 py-1.5">
                                <div className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[op.status]}`} />
                                <span className="text-[14px] text-[#0F172A] font-medium min-w-[180px]">{op.operationName}</span>
                                <span className="text-[12px] text-[#94A3B8]">
                                    {op.totalRuns} запусков · {op.errorRuns} ошибок
                                    {op.consecutiveErrors > 0 && ` · ${op.consecutiveErrors} подряд`}
                                </span>
                                {op.reasons.length > 0 && (
                                    <span className="text-[12px] text-red-500 ml-auto">{op.reasons.join(', ')}</span>
                                )}
                            </div>
                        ))}
                    </div>
                </Section>
            )}

            {/* Cron execution summary */}
            {cronSummary.length > 0 && (
                <Section title="Cron-задачи (24ч)">
                    <div className="overflow-x-auto">
                        <table className="w-full text-[13px]">
                            <thead>
                                <tr className="text-left text-[#94A3B8] border-b border-[#e5e7eb]">
                                    <th className="py-1.5 pr-3 font-medium">Задача</th>
                                    <th className="py-1.5 pr-3 font-medium text-right">Запуски</th>
                                    <th className="py-1.5 pr-3 font-medium text-right">OK</th>
                                    <th className="py-1.5 pr-3 font-medium text-right">Ошибки</th>
                                    <th className="py-1.5 pr-3 font-medium text-right">Средн. мс</th>
                                    <th className="py-1.5 font-medium">Последний запуск</th>
                                </tr>
                            </thead>
                            <tbody>
                                {cronSummary.map(c => (
                                    <tr key={c.cronName} className="border-b border-[#f1f5f9]">
                                        <td className="py-1.5 pr-3 text-[#0F172A] font-medium">{c.cronName}</td>
                                        <td className="py-1.5 pr-3 text-right">{c.totalRuns}</td>
                                        <td className="py-1.5 pr-3 text-right text-green-600">{c.okRuns}</td>
                                        <td className="py-1.5 pr-3 text-right text-red-500">{c.errorRuns}</td>
                                        <td className="py-1.5 pr-3 text-right">{c.avgDurationMs}</td>
                                        <td className="py-1.5 text-[#94A3B8]">
                                            {c.lastExecutedAt ? new Date(c.lastExecutedAt).toLocaleTimeString('ru-RU') : '—'}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </Section>
            )}

            {/* Background jobs */}
            {Object.keys(backgroundJobs).length > 0 && (
                <Section title="Фоновые задачи (in-memory)">
                    <div className="space-y-1">
                        {Object.entries(backgroundJobs).map(([name, state]) => (
                            <div key={name} className="flex items-center gap-2.5 py-1.5">
                                <div className={`w-2 h-2 rounded-full shrink-0 ${state.isRunning ? 'bg-blue-500 animate-pulse' : state.lastError ? 'bg-red-500' : 'bg-green-500'}`} />
                                <span className="text-[14px] text-[#0F172A] font-medium min-w-[160px]">{name}</span>
                                <span className="text-[12px] text-[#94A3B8]">
                                    {state.isRunning && 'Выполняется'}
                                    {!state.isRunning && state.lastCompletedAt && `Последний: ${new Date(state.lastCompletedAt).toLocaleTimeString('ru-RU')}`}
                                    {!state.isRunning && !state.lastCompletedAt && 'Не запускался'}
                                </span>
                                {state.lastError && (
                                    <span className="text-[12px] text-red-500 ml-auto truncate max-w-[200px]" title={state.lastError}>
                                        {state.lastError}
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                </Section>
            )}

            {/* Integrity checks */}
            <Section title="Проверки целостности">
                {integrityReports.length === 0 ? (
                    <p className="text-[13px] text-[#94A3B8]">Нет данных о проверках</p>
                ) : (
                    <div className="space-y-1">
                        {integrityReports.map(r => (
                            <div key={r.id} className="flex items-center gap-2.5 py-1.5">
                                <div className={`w-2 h-2 rounded-full shrink-0 ${r.criticalIssues > 0 ? 'bg-red-500' : r.warningIssues > 0 ? 'bg-yellow-500' : 'bg-green-500'}`} />
                                <span className="text-[13px] text-[#0F172A]">
                                    {new Date(r.checkedAt).toLocaleString('ru-RU')}
                                </span>
                                <span className="text-[12px] text-[#94A3B8]">
                                    {r.totalIssues} проблем ({r.criticalIssues} крит., {r.warningIssues} предупр.) · {r.durationMs}мс
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </Section>

            {/* Performance */}
            {perfSummary.length > 0 && (
                <Section title="Производительность (24ч)">
                    <div className="overflow-x-auto">
                        <table className="w-full text-[13px]">
                            <thead>
                                <tr className="text-left text-[#94A3B8] border-b border-[#e5e7eb]">
                                    <th className="py-1.5 pr-3 font-medium">Операция</th>
                                    <th className="py-1.5 pr-3 font-medium">Тип</th>
                                    <th className="py-1.5 pr-3 font-medium text-right">Запуски</th>
                                    <th className="py-1.5 pr-3 font-medium text-right">Медл.</th>
                                    <th className="py-1.5 pr-3 font-medium text-right">Средн.</th>
                                    <th className="py-1.5 pr-3 font-medium text-right">P95</th>
                                    <th className="py-1.5 font-medium text-right">Макс.</th>
                                </tr>
                            </thead>
                            <tbody>
                                {perfSummary.map(p => (
                                    <tr key={p.operationName} className="border-b border-[#f1f5f9]">
                                        <td className="py-1.5 pr-3 text-[#0F172A] font-medium">{p.operationName}</td>
                                        <td className="py-1.5 pr-3 text-[#94A3B8]">{p.operationType}</td>
                                        <td className="py-1.5 pr-3 text-right">{p.totalRuns}</td>
                                        <td className="py-1.5 pr-3 text-right text-red-500">{p.slowRuns}</td>
                                        <td className="py-1.5 pr-3 text-right">{p.avgDurationMs}мс</td>
                                        <td className="py-1.5 pr-3 text-right">{p.p95DurationMs}мс</td>
                                        <td className="py-1.5 text-right">{p.maxDurationMs}мс</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </Section>
            )}

            {/* Slow operations */}
            {slowOperations.length > 0 && (
                <Section title="Медленные операции (24ч)">
                    <div className="space-y-1">
                        {slowOperations.map((op, i) => (
                            <div key={i} className="flex items-center gap-2.5 py-1.5">
                                <div className="w-2 h-2 rounded-full shrink-0 bg-orange-400" />
                                <span className="text-[13px] text-[#0F172A] font-medium">{op.operationName}</span>
                                <span className="text-[12px] text-[#94A3B8]">
                                    {op.durationMs}мс · {op.operationType}
                                </span>
                                <span className="text-[12px] text-[#94A3B8] ml-auto">
                                    {new Date(op.loggedAt).toLocaleTimeString('ru-RU')}
                                </span>
                            </div>
                        ))}
                    </div>
                </Section>
            )}

            {/* Active locks */}
            {activeLocks.length > 0 && (
                <Section title="Активные блокировки">
                    <div className="space-y-1">
                        {activeLocks.map((lock, i) => (
                            <div key={i} className="flex items-center gap-2.5 py-1.5">
                                <div className="w-2 h-2 rounded-full shrink-0 bg-blue-500 animate-pulse" />
                                <span className="text-[13px] text-[#0F172A] font-medium">{lock.operationName}</span>
                                <span className="text-[12px] text-[#94A3B8]">
                                    до {new Date(lock.expiresAt).toLocaleTimeString('ru-RU')}
                                </span>
                            </div>
                        ))}
                    </div>
                </Section>
            )}
        </div>
    )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="bg-white rounded-xl border border-[#e5e7eb] px-4 py-3">
            <h2 className="text-[15px] font-semibold text-[#0F172A] mb-2">{title}</h2>
            {children}
        </div>
    )
}
