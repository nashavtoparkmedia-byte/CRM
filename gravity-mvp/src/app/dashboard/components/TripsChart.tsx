"use client"

import {
    ResponsiveContainer,
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Area,
    AreaChart,
} from "recharts"
import type { TripDataPoint } from "../actions"

export function TripsChart({ data }: { data: TripDataPoint[] }) {
    return (
        <div className="rounded-2xl border bg-card p-6 shadow-sm">
            <div className="mb-4">
                <h3 className="text-lg font-bold text-foreground">Поездки за 30 дней</h3>
                <p className="text-xs text-muted-foreground mt-0.5">Динамика активности парка</p>
            </div>
            <div className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                        <defs>
                            <linearGradient id="tripGradient" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
                                <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.02} />
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
                        <XAxis
                            dataKey="date"
                            tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                            tickFormatter={(v) => {
                                const d = new Date(v)
                                return `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`
                            }}
                            interval={4}
                        />
                        <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
                        <Tooltip
                            contentStyle={{
                                borderRadius: '12px',
                                border: '1px solid hsl(var(--border))',
                                background: 'hsl(var(--card))',
                                fontSize: '12px',
                                boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                            }}
                            labelFormatter={(v) => new Date(v).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}
                            formatter={(value: any) => [`${value} поездок`, 'Поездки']}
                        />
                        <Area type="monotone" dataKey="trips" stroke="#3b82f6" fill="url(#tripGradient)" strokeWidth={2.5} dot={false} activeDot={{ r: 5, fill: '#3b82f6' }} />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        </div>
    )
}
