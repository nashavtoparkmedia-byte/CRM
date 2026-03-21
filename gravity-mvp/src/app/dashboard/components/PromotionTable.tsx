"use client"

export interface PromotionPerfRow {
    name: string
    assigned: number
    completed: number
    conversion: number
}

// Demo data for now — will be connected to real promotion tracking later
const DEMO_PROMOTIONS: PromotionPerfRow[] = [
    { name: '+5% бонус за поездки', assigned: 120, completed: 54, conversion: 45 },
    { name: '500₽ бонус за 10 поездок', assigned: 80, completed: 11, conversion: 13 },
    { name: 'Кэшбэк за ночные', assigned: 45, completed: 28, conversion: 62 },
    { name: 'VIP статус', assigned: 30, completed: 18, conversion: 60 },
]

export function PromotionTable() {
    return (
        <div className="rounded-2xl border bg-card p-6 shadow-sm">
            <div className="mb-4">
                <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
                    🎯 Эффективность акций
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">Конверсия текущих акций</p>
            </div>

            <div className="overflow-hidden rounded-xl border">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="bg-secondary/50">
                            <th className="text-left py-2.5 px-4 font-semibold text-muted-foreground text-xs uppercase">Акция</th>
                            <th className="text-center py-2.5 px-3 font-semibold text-muted-foreground text-xs uppercase">Назначено</th>
                            <th className="text-center py-2.5 px-3 font-semibold text-muted-foreground text-xs uppercase">Поехали</th>
                            <th className="text-center py-2.5 px-3 font-semibold text-muted-foreground text-xs uppercase">Конверсия</th>
                        </tr>
                    </thead>
                    <tbody>
                        {DEMO_PROMOTIONS.map((promo) => (
                            <tr key={promo.name} className="border-t hover:bg-secondary/30 transition-colors">
                                <td className="py-2.5 px-4 font-medium text-foreground">{promo.name}</td>
                                <td className="text-center py-2.5 px-3 text-muted-foreground font-medium">{promo.assigned}</td>
                                <td className="text-center py-2.5 px-3 text-muted-foreground font-medium">{promo.completed}</td>
                                <td className="text-center py-2.5 px-3">
                                    <span className={`inline-flex items-center justify-center w-14 h-7 rounded-lg text-xs font-bold ${
                                        promo.conversion >= 50 ? 'bg-emerald-100 text-emerald-700' :
                                        promo.conversion >= 30 ? 'bg-amber-100 text-amber-700' :
                                        'bg-red-100 text-red-700'
                                    }`}>
                                        {promo.conversion}%
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    )
}
