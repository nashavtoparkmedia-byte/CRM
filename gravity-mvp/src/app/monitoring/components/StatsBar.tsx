'use client';

import { Users, Search as SearchIcon } from 'lucide-react';
import type { MonitoringStats } from '@/app/monitoring/lib/types';

interface StatsBarProps {
    stats: MonitoringStats;
}

export function StatsBar({ stats }: StatsBarProps) {
    const checksDisplay = stats.checksUsedToday !== null
        ? `${stats.checksUsedToday}/${stats.checksLimitToday}`
        : '—';
    const checksRemaining = stats.checksUsedToday !== null
        ? stats.checksLimitToday - stats.checksUsedToday
        : null;

    return (
        <div className="flex items-center gap-6 rounded-xl bg-card p-4 shadow-sm border">
            <div className="flex items-center gap-2">
                <Users className="h-5 w-5 text-muted-foreground" />
                <span className="text-sm font-medium">Активные:</span>
                <span className="text-lg font-bold">{stats.activeDrivers}</span>
            </div>
            <div className="h-6 w-px bg-border" />
            <div className="flex items-center gap-2">
                <SearchIcon className="h-5 w-5 text-muted-foreground" />
                <span className="text-sm font-medium">Fleet:</span>
                <span className="text-lg font-bold">{checksDisplay}</span>
                {checksRemaining !== null && (
                    <span className="text-sm text-muted-foreground">
                        (осталось {checksRemaining})
                    </span>
                )}
                {stats.checksLimitReached && (
                    <span className="text-xs text-destructive font-medium px-2 py-0.5 bg-destructive/10 rounded">
                        Лимит
                    </span>
                )}
            </div>
        </div>
    );
}
