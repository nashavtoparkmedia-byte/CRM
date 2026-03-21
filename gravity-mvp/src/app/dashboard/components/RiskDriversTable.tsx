"use client"

import { useState } from "react"
import { Phone, MessageSquare } from "lucide-react"
import type { RiskDriver } from "../actions"
import { SegmentBadge } from "@/app/drivers/components/SegmentBadge"
import { logManagerCall, logManagerMessage } from "@/app/drivers/actions"
import { Button } from "@/components/ui/button"
import Link from "next/link"

export function RiskDriversTable({ drivers }: { drivers: RiskDriver[] }) {
    return (
        <div className="rounded-2xl border bg-card p-6 shadow-sm">
            <div className="mb-4">
                <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
                    ⚠️ Водители в риске
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">Топ-10 по дням неактивности</p>
            </div>

            {drivers.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground text-sm">
                    Нет водителей в зоне риска 🎉
                </div>
            ) : (
                <div className="overflow-hidden rounded-xl border">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="bg-secondary/50">
                                <th className="text-left py-2.5 px-4 font-semibold text-muted-foreground text-xs uppercase">Водитель</th>
                                <th className="text-center py-2.5 px-3 font-semibold text-muted-foreground text-xs uppercase">Score</th>
                                <th className="text-center py-2.5 px-3 font-semibold text-muted-foreground text-xs uppercase">Неактивен</th>
                                <th className="text-center py-2.5 px-3 font-semibold text-muted-foreground text-xs uppercase">Действие</th>
                            </tr>
                        </thead>
                        <tbody>
                            {drivers.map((driver) => (
                                <RiskDriverRow key={driver.id} driver={driver} />
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    )
}

function RiskDriverRow({ driver }: { driver: RiskDriver }) {
    const [actionDone, setActionDone] = useState<string | null>(null)

    const handleCall = async () => {
        await logManagerCall(driver.id)
        setActionDone("call")
    }

    const handleMessage = async () => {
        await logManagerMessage(driver.id)
        setActionDone("message")
    }

    return (
        <tr className="border-t hover:bg-secondary/30 transition-colors">
            <td className="py-2.5 px-4">
                <Link href={`/drivers/${driver.id}`} className="font-semibold text-foreground hover:text-primary transition-colors">
                    {driver.fullName}
                </Link>
                <div className="mt-0.5">
                    <SegmentBadge segment={driver.segment} />
                </div>
            </td>
            <td className="text-center py-2.5 px-3">
                <span className={`inline-flex items-center justify-center w-10 h-10 rounded-full text-sm font-bold ${
                    (driver.score ?? 0) >= 70 ? 'bg-emerald-100 text-emerald-700' :
                    (driver.score ?? 0) >= 40 ? 'bg-amber-100 text-amber-700' :
                    'bg-red-100 text-red-700'
                }`}>
                    {driver.score ? Math.round(driver.score) : '—'}
                </span>
            </td>
            <td className="text-center py-2.5 px-3">
                <span className={`inline-flex items-center gap-1 font-bold ${
                    driver.daysInactive >= 7 ? 'text-red-600' :
                    driver.daysInactive >= 5 ? 'text-amber-600' : 'text-muted-foreground'
                }`}>
                    {driver.daysInactive}д
                </span>
            </td>
            <td className="text-center py-2.5 px-3">
                {actionDone ? (
                    <span className="text-xs font-medium text-emerald-600">
                        ✓ {actionDone === 'call' ? 'Записан' : 'Записано'}
                    </span>
                ) : (
                    <div className="flex justify-center gap-1">
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-blue-600 hover:bg-blue-50"
                            onClick={handleMessage}
                            title="Написать"
                        >
                            <MessageSquare size={14} />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-green-600 hover:bg-green-50"
                            onClick={handleCall}
                            title="Позвонить"
                        >
                            <Phone size={14} />
                        </Button>
                    </div>
                )}
            </td>
        </tr>
    )
}
