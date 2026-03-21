'use client';

import { EVENT_ICONS } from '@/app/monitoring/lib/constants';

interface HistoryIconsProps {
    eventTypes: string[];
}

export function HistoryIcons({ eventTypes }: HistoryIconsProps) {
    if (!eventTypes || eventTypes.length === 0) {
        return <span className="text-muted-foreground text-sm">—</span>;
    }

    // Merge fleet_check_requested + fleet_check_completed into one icon
    const hasRequested = eventTypes.includes('fleet_check_requested');
    const hasCompleted = eventTypes.includes('fleet_check_completed');

    const merged = eventTypes.filter(
        (t) => !(t === 'fleet_check_requested' && hasCompleted) && !(t === 'fleet_check_completed' && hasRequested)
    );

    if (hasRequested && hasCompleted) {
        merged.push('fleet_check_done');
    } else if (hasCompleted) {
        merged.push('fleet_check_done');
    }

    return (
        <div className="flex items-center gap-1">
            {merged.map((type, i) => (
                <span key={i} className="text-base cursor-default">
                    {type === 'fleet_check_done' ? (
                        <span className="relative inline-flex items-center">
                            🔍<span className="text-xs absolute -bottom-0.5 -right-1">✅</span>
                        </span>
                    ) : (
                        EVENT_ICONS[type] || '•'
                    )}
                </span>
            ))}
        </div>
    );
}
