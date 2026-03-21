'use client';

import { useState } from 'react';
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { FLEET_STATUS_LABELS } from '@/app/monitoring/lib/constants';
import { ActionButtons } from './ActionButtons';
import { HistoryIcons } from './HistoryIcons';
import { DriverHoverCard } from './DriverHoverCard';
import type { MonitoringDriver } from '@/app/monitoring/lib/types';

interface AllDriversSectionProps {
    drivers: MonitoringDriver[];
    total: number;
    page: number;
    limit: number;
    checksLimitReached: boolean;
    onPageChange: (page: number) => void;
    onSearch: (query: string) => void;
    onCall: (driverId: string) => void;
    onMessage: (driverId: string) => void;
    onFleetCheck: (driverId: string) => void;
}

function getFleetStatusLabel(status: string | null, lastCheckAt: string | null): string {
    if (!status && !lastCheckAt) return 'не проверяли';
    if (status === 'queued') return FLEET_STATUS_LABELS.queued || 'в очереди';
    if (status === 'failed') return FLEET_STATUS_LABELS.failed || 'ошибка';

    if (status === 'completed' && lastCheckAt) {
        const daysDiff = Math.floor((Date.now() - new Date(lastCheckAt).getTime()) / 86400000);
        if (daysDiff < 1) return 'сегодня';
        if (daysDiff === 1) return 'вчера';
        return `${daysDiff} дн. назад`;
    }
    return '—';
}

export function AllDriversSection({
    drivers,
    total,
    page,
    limit,
    checksLimitReached,
    onPageChange,
    onSearch,
    onCall,
    onMessage,
    onFleetCheck,
}: AllDriversSectionProps) {
    const [searchQuery, setSearchQuery] = useState('');
    const totalPages = Math.ceil(total / limit);

    const handleSearch = () => {
        onSearch(searchQuery);
    };

    return (
        <div className="rounded-xl bg-card shadow-sm border">
            <div className="flex items-center justify-between p-4 border-b">
                <h2 className="text-lg font-semibold">
                    Все водители
                    <span className="ml-2 text-sm font-normal text-muted-foreground">({total})</span>
                </h2>
                <div className="flex items-center gap-2">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            placeholder="Поиск по имени..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                            className="pl-9 w-64"
                        />
                    </div>
                    <Button variant="outline" size="sm" onClick={handleSearch}>
                        Найти
                    </Button>
                </div>
            </div>
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Водитель</TableHead>
                        <TableHead>Телефон</TableHead>
                        <TableHead>Парк</TableHead>
                        <TableHead>Проверка</TableHead>
                        <TableHead>История</TableHead>
                        <TableHead>Действие</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {drivers.length === 0 ? (
                        <TableRow>
                            <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                                Водители не найдены
                            </TableCell>
                        </TableRow>
                    ) : (
                        drivers.map((d) => (
                            <TableRow key={d.id}>
                                <TableCell className="font-medium">{d.fullName}</TableCell>
                                <TableCell className="text-sm text-muted-foreground">{d.phone || '—'}</TableCell>
                                <TableCell className="text-sm">{d.lastExternalPark || '—'}</TableCell>
                                <TableCell className="text-sm">
                                    <span className={
                                        d.lastFleetCheckStatus === 'queued' ? 'text-amber-600' :
                                            d.lastFleetCheckStatus === 'failed' ? 'text-destructive' :
                                                'text-muted-foreground'
                                    }>
                                        {getFleetStatusLabel(d.lastFleetCheckStatus, d.lastFleetCheckAt)}
                                    </span>
                                </TableCell>
                                <TableCell>
                                    <DriverHoverCard driverId={d.id} driverName={d.fullName} phone={d.phone}>
                                        <HistoryIcons eventTypes={d.recentEvents} />
                                    </DriverHoverCard>
                                </TableCell>
                                <TableCell>
                                    <ActionButtons
                                        driverId={d.id}
                                        phone={d.phone}
                                        licenseNumber={d.licenseNumber}
                                        checksLimitReached={checksLimitReached}
                                        lastFleetCheckStatus={d.lastFleetCheckStatus}
                                        onCall={onCall}
                                        onMessage={onMessage}
                                        onFleetCheck={onFleetCheck}
                                    />
                                </TableCell>
                            </TableRow>
                        ))
                    )}
                </TableBody>
            </Table>

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="flex items-center justify-between p-4 border-t">
                    <span className="text-sm text-muted-foreground">
                        Страница {page} из {totalPages}
                    </span>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onPageChange(page - 1)}
                            disabled={page <= 1}
                        >
                            <ChevronLeft className="h-4 w-4" />
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onPageChange(page + 1)}
                            disabled={page >= totalPages}
                        >
                            <ChevronRight className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
