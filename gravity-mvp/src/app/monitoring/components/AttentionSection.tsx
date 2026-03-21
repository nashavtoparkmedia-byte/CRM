'use client';

import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { RISK_LEVELS } from '@/app/monitoring/lib/constants';
import { ActionButtons } from './ActionButtons';
import type { AttentionItem } from '@/app/monitoring/lib/types';

interface AttentionSectionProps {
    items: AttentionItem[];
    total: number;
    checksLimitReached: boolean;
    onCall: (driverId: string) => void;
    onMessage: (driverId: string) => void;
    onFleetCheck: (driverId: string) => void;
    onResolve: (attentionId: string) => void;
    onShowAll: () => void;
}

const riskIndicators: Record<string, string> = {
    low: '🟢',
    medium: '🟡',
    high: '🔴',
};

export function AttentionSection({
    items,
    total,
    checksLimitReached,
    onCall,
    onMessage,
    onFleetCheck,
    onResolve,
    onShowAll,
}: AttentionSectionProps) {
    if (items.length === 0) {
        return null; // Don't render section if no attention items
    }

    return (
        <div className="rounded-xl bg-card shadow-sm border">
            <div className="flex items-center justify-between p-4 border-b">
                <h2 className="text-lg font-semibold">
                    ⚡ Требуют внимания
                    <span className="ml-2 text-sm font-normal text-muted-foreground">({total})</span>
                </h2>
                {total > items.length && (
                    <Button variant="ghost" size="sm" onClick={onShowAll}>
                        Показать все
                    </Button>
                )}
            </div>
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Водитель</TableHead>
                        <TableHead>Телефон</TableHead>
                        <TableHead>Причина</TableHead>
                        <TableHead>Парк</TableHead>
                        <TableHead>Риск</TableHead>
                        <TableHead>Действие</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {items.map((item) => (
                        <TableRow key={item.id}>
                            <TableCell className="font-medium">{item.driver.fullName}</TableCell>
                            <TableCell className="text-sm text-muted-foreground">{item.driver.phone || '—'}</TableCell>
                            <TableCell className="text-sm">{item.reason}</TableCell>
                            <TableCell className="text-sm">{item.driver.lastExternalPark || '—'}</TableCell>
                            <TableCell>
                                <span title={RISK_LEVELS[item.riskLevel as keyof typeof RISK_LEVELS]?.label || item.riskLevel}>
                                    {riskIndicators[item.riskLevel] || '🟡'}
                                </span>
                            </TableCell>
                            <TableCell>
                                <ActionButtons
                                    driverId={item.driver.id}
                                    phone={item.driver.phone}
                                    licenseNumber={item.driver.licenseNumber}
                                    checksLimitReached={checksLimitReached}
                                    lastFleetCheckStatus={null}
                                    showResolve
                                    onCall={onCall}
                                    onMessage={onMessage}
                                    onFleetCheck={onFleetCheck}
                                    onResolve={() => onResolve(item.id)}
                                />
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}
