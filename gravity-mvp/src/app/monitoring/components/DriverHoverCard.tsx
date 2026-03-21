'use client';

import { useState, useEffect } from 'react';
import type { DriverEventItem } from '@/app/monitoring/lib/types';
import { EVENT_ICONS } from '@/app/monitoring/lib/constants';

interface DriverHoverCardProps {
    driverId: string;
    driverName: string;
    phone: string | null;
    children: React.ReactNode;
}

export function DriverHoverCard({ driverId, driverName, phone, children }: DriverHoverCardProps) {
    const [show, setShow] = useState(false);
    const [events, setEvents] = useState<DriverEventItem[] | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!show || events !== null) return;

        setLoading(true);
        fetch(`/api/monitoring/drivers/${driverId}/events?limit=5`)
            .then((res) => res.json())
            .then((data) => setEvents(data.events || []))
            .catch(() => setEvents([]))
            .finally(() => setLoading(false));
    }, [show, driverId, events]);

    return (
        <div
            className="relative inline-block"
            onMouseEnter={() => setShow(true)}
            onMouseLeave={() => setShow(false)}
        >
            {children}
            {show && (
                <div className="absolute z-40 left-0 top-full mt-1 w-72 rounded-lg bg-card shadow-lg border p-4">
                    <div className="font-semibold text-sm mb-1">{driverName}</div>
                    {phone && <div className="text-sm text-muted-foreground mb-2">📞 {phone}</div>}
                    <div className="border-t pt-2">
                        {loading && <div className="text-xs text-muted-foreground">Загрузка...</div>}
                        {events && events.length === 0 && (
                            <div className="text-xs text-muted-foreground">Нет событий</div>
                        )}
                        {events && events.length > 0 && (
                            <div className="space-y-4">
                                {events.map((e) => {
                                    // Special rendering for completed fleet check with detailed results
                                    if (e.eventType === 'fleet_check_completed' && e.payload?.result) {
                                        const r = e.payload.result as any;
                                        const profile = r.profile || {};
                                        const act = r.activity || {};
                                        const qual = r.quality || {};
                                        return (
                                            <div key={e.id} className="text-xs space-y-2 border-b pb-2 last:border-0">
                                                <div className="flex items-center gap-2">
                                                    <span>{EVENT_ICONS[e.eventType] || '✅'}</span>
                                                    <span className="text-muted-foreground">
                                                        {new Date(e.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
                                                    </span>
                                                    <span className="font-medium text-green-600">Отчёт получен</span>
                                                </div>

                                                {/* Profile & Quality */}
                                                <div className="bg-gray-50 p-2 rounded-md">
                                                    <div className="mb-1">
                                                        <span className="font-semibold">{profile.name || driverName}</span>
                                                    </div>
                                                    <div className="flex flex-col gap-1 text-gray-700 mt-1.5">
                                                        {qual.rating !== undefined && qual.rating !== null && <div>⭐ {qual.rating}</div>}
                                                        {act.experience && <div>Стаж: {act.experience.replace('Подключён к сервису\n', '')}</div>}
                                                    </div>
                                                </div>

                                                {/* Activity Stats */}
                                                <div className="grid grid-cols-2 gap-2 text-gray-600">
                                                    {act.totalOrders && (
                                                        <div className="col-span-2">Всего: {act.totalOrders}</div>
                                                    )}
                                                    {act.firstRide && <div>Первая: {act.firstRide}</div>}
                                                    {act.lastRide && <div>Последняя: {act.lastRide}</div>}
                                                </div>

                                                {/* Monthly breakdown */}
                                                {act.monthlyStats && Array.isArray(act.monthlyStats) && act.monthlyStats.length > 0 ? (
                                                    <div className="mt-2 text-gray-600">
                                                        <div className="font-medium mb-1">Активность (мес):</div>
                                                        <div className="space-y-1 max-h-24 overflow-y-auto pr-1">
                                                            {act.monthlyStats.filter((st: any) => typeof st === 'object' && st !== null && st.month).map((st: any, i: number) => (
                                                                <div key={i} className="flex justify-between items-center text-[10px] bg-slate-50 px-1 py-0.5 rounded">
                                                                    <span>{st.month}</span>
                                                                    <div className="flex gap-1.5 opacity-80">
                                                                        {st.comfort > 0 && <span className="text-yellow-600" title="Комфорт">К:{st.comfort}</span>}
                                                                        {st.economy > 0 && <span className="text-blue-500" title="Эконом">Э:{st.economy}</span>}
                                                                        {st.kids > 0 && <span className="text-rose-500" title="Детский">Д:{st.kids}</span>}
                                                                        {st.other > 0 && <span className="text-cyan-600" title="Остальные">О:{st.other}</span>}
                                                                        <span className="font-medium text-gray-700">Всего: {st.total || 0}</span>
                                                                    </div>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                ) : null}

                                                {/* Reviews */}
                                                {r.topReviews && typeof r.topReviews === 'object' && Object.keys(r.topReviews).length > 0 && (
                                                    <div className="mt-2 text-gray-600 border-t pt-1">
                                                        <div className="font-medium mb-1">Отзывы (топ):</div>
                                                        <ul className="list-disc pl-4 text-[10px] space-y-0.5">
                                                            {Object.entries(r.topReviews).slice(0, 3).map(([k, v]) => (
                                                                <li key={k}>{k}: {String(v)}</li>
                                                            ))}
                                                        </ul>
                                                    </div>
                                                )}

                                                {/* Other Parks Notice */}
                                                {r.otherParks && Array.isArray(r.otherParks) && r.otherParks.length > 0 && r.otherParks[0]?.rawText && (
                                                    <details className="mt-2 text-[10px] bg-amber-50 rounded px-1.5 py-1 cursor-pointer">
                                                        <summary className="text-amber-800 font-medium select-none outline-none">
                                                            ⚠️ Найдены другие парки ({r.otherParks.length})
                                                        </summary>
                                                        <div className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-[9px] text-amber-900/80 leading-tight border-t border-amber-200/50 pt-1">
                                                            {r.otherParks[0].rawText.split(' | ').filter((row: string) => !row.includes('Машина\tКомпания')).map((row: string, idx: number) => (
                                                                <div key={idx} className="border-b border-amber-200/50 last:border-0 py-0.5">{row.replace(/\t/g, ' - ')}</div>
                                                            ))}
                                                        </div>
                                                    </details>
                                                )}
                                            </div>
                                        );
                                    }

                                    // Default rendering for other events
                                    return (
                                        <div key={e.id} className="flex items-center gap-2 text-xs">
                                            <span>{EVENT_ICONS[e.eventType] || '•'}</span>
                                            <span className="text-muted-foreground">
                                                {new Date(e.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
                                            </span>
                                            <span>{e.eventType.replace(/_/g, ' ')}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
