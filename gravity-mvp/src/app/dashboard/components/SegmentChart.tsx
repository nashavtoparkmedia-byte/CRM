"use client"

import {
    ResponsiveContainer,
    PieChart,
    Pie,
    Cell,
    Tooltip,
    Legend,
} from "recharts"
import type { SegmentData } from "../actions"

export function SegmentChart({ data }: { data: SegmentData[] }) {
    const total = data.reduce((s, d) => s + d.value, 0)

    return (
        <div className="rounded-2xl border bg-card p-6 shadow-sm">
            <div className="mb-4">
                <h3 className="text-lg font-bold text-foreground">Сегменты водителей</h3>
                <p className="text-xs text-muted-foreground mt-0.5">Распределение по активности</p>
            </div>
            <div className="h-[280px] flex items-center">
                <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                        <Pie
                            data={data}
                            cx="50%"
                            cy="50%"
                            innerRadius={70}
                            outerRadius={110}
                            paddingAngle={3}
                            dataKey="value"
                            nameKey="name"
                            strokeWidth={0}
                        >
                            {data.map((entry, i) => (
                                <Cell key={i} fill={entry.color} />
                            ))}
                        </Pie>
                        <Tooltip
                            contentStyle={{
                                borderRadius: '12px',
                                border: '1px solid hsl(var(--border))',
                                background: 'hsl(var(--card))',
                                fontSize: '12px',
                                boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                            }}
                            formatter={(value: any, name: any) => [
                                `${value} (${total > 0 ? Math.round((value / total) * 100) : 0}%)`,
                                name,
                            ]}
                        />
                        <Legend
                            verticalAlign="bottom"
                            iconType="circle"
                            iconSize={8}
                            formatter={(value, entry) => (
                                <span style={{ color: 'hsl(var(--foreground))', fontSize: '12px', fontWeight: 500 }}>
                                    {value}
                                </span>
                            )}
                        />
                    </PieChart>
                </ResponsiveContainer>
            </div>
            {/* Summary below chart */}
            <div className="grid grid-cols-4 gap-2 mt-2">
                {data.map((d) => (
                    <div key={d.name} className="text-center">
                        <div className="text-lg font-bold" style={{ color: d.color }}>{d.value}</div>
                        <div className="text-[10px] text-muted-foreground uppercase">{d.name}</div>
                    </div>
                ))}
            </div>
        </div>
    )
}
