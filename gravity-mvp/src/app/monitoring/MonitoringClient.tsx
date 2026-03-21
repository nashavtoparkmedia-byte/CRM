'use client';

import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import { StatsBar } from './components/StatsBar';
import { AttentionSection } from './components/AttentionSection';
import { AllDriversSection } from './components/AllDriversSection';
import { FleetCheckModal } from './components/FleetCheckModal';
import { AddToAttentionModal } from './components/AddToAttentionModal';
import { ToastProvider, useToast } from './components/Toast';
import type {
    MonitoringDriver, MonitoringStats, AttentionItem,
} from '@/app/monitoring/lib/types';

interface MonitoringClientProps {
    initialDrivers: MonitoringDriver[];
    initialTotal: number;
    initialStats: MonitoringStats;
    initialAttention: AttentionItem[];
    initialAttentionTotal: number;
}

export function MonitoringClient(props: MonitoringClientProps) {
    return (
        <ToastProvider>
            <MonitoringClientInner {...props} />
        </ToastProvider>
    );
}

function MonitoringClientInner({
    initialDrivers,
    initialTotal,
    initialStats,
    initialAttention,
    initialAttentionTotal,
}: MonitoringClientProps) {
    const { showToast } = useToast();
    const [drivers, setDrivers] = useState(initialDrivers);
    const [total, setTotal] = useState(initialTotal);
    const [stats, setStats] = useState(initialStats);
    const [attention, setAttention] = useState(initialAttention);
    const [attentionTotal, setAttentionTotal] = useState(initialAttentionTotal);
    const [page, setPage] = useState(1);
    const [searchQuery, setSearchQuery] = useState('');

    // Modal state
    const [fleetCheckModal, setFleetCheckModal] = useState<{ driverId: string; driverName: string } | null>(null);
    const [attentionModal, setAttentionModal] = useState<{ driverId: string; driverName: string } | null>(null);

    // Refresh drivers list
    const refreshDrivers = useCallback(async (p: number = page, search: string = searchQuery) => {
        try {
            const params = new URLSearchParams({
                page: String(p),
                limit: '20',
                sort: 'fullName',
                order: 'asc',
            });
            if (search) params.set('search', search);

            const res = await fetch(`/api/monitoring/drivers?${params}`);
            const data = await res.json();
            setDrivers(data.drivers);
            setTotal(data.total);
            setStats(data.stats);
        } catch (err) {
            console.error('Failed to refresh drivers:', err);
        }
    }, [page, searchQuery]);

    // Refresh attention list
    const refreshAttention = useCallback(async () => {
        try {
            const res = await fetch('/api/monitoring/attention?limit=20');
            const data = await res.json();
            setAttention(data.items);
            setAttentionTotal(data.total);
        } catch (err) {
            console.error('Failed to refresh attention:', err);
        }
    }, []);

    // Action handlers
    const handleCall = async (driverId: string) => {
        try {
            await fetch(`/api/monitoring/drivers/${driverId}/event`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ eventType: 'call_attempt' }),
            });
            showToast('📞 Звонок зафиксирован', 'success');
        } catch (err) {
            console.error('Failed to log call:', err);
        }
    };

    const handleMessage = (driverId: string) => {
        const driver = drivers.find((d) => d.id === driverId) ||
            attention.find((a) => a.driver.id === driverId)?.driver;
        if (driver) {
            showToast(`💬 Telegram для: ${driver.fullName}`, 'info');
        }
    };

    const handleFleetCheck = (driverId: string) => {
        // Search in main drivers list first
        const driver = drivers.find((d) => d.id === driverId);
        if (driver) {
            if (driver.licenseNumber) {
                startFleetCheck(driverId);
            } else {
                setFleetCheckModal({ driverId, driverName: driver.fullName });
            }
            return;
        }

        // Fallback: search in attention list (driver may not be on current drivers page)
        const attentionDriver = attention.find((a) => a.driver.id === driverId)?.driver;
        if (attentionDriver) {
            if (attentionDriver.licenseNumber) {
                startFleetCheck(driverId);
            } else {
                setFleetCheckModal({ driverId, driverName: attentionDriver.fullName });
            }
        }
    };

    const startFleetCheck = async (driverId: string, licenseNumber?: string) => {
        try {
            const body: Record<string, string> = {};
            if (licenseNumber) body.licenseNumber = licenseNumber;

            const res = await fetch(`/api/monitoring/drivers/${driverId}/fleet-check`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (res.status === 429) {
                const data = await res.json();
                showToast(`⛔ Лимит проверок достигнут: ${data.errorCode}`, 'error');
                return;
            }

            if (!res.ok) {
                const data = await res.json();
                showToast(`❌ ${data.error}`, 'error');
                return;
            }

            const data = await res.json();
            showToast(`🔎 Проверка запущена (${data.checkId?.slice(0, 8)}...)`, 'success');
            setFleetCheckModal(null);
            await refreshDrivers();
        } catch (err) {
            showToast('❌ Не удалось запустить проверку', 'error');
            console.error('Fleet check error:', err);
        }
    };

    const handleResolve = async (attentionId: string) => {
        try {
            await fetch(`/api/monitoring/attention/${attentionId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'resolved' }),
            });
            showToast('✅ Задача закрыта', 'success');
            await refreshAttention();
        } catch (err) {
            showToast('❌ Не удалось закрыть задачу', 'error');
            console.error('Failed to resolve:', err);
        }
    };

    const handleAddAttention = async (reason: string, riskLevel: string) => {
        if (!attentionModal) return;
        try {
            await fetch(`/api/monitoring/drivers/${attentionModal.driverId}/attention`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason, riskLevel }),
            });
            showToast('🏷️ Водитель добавлен в наблюдение', 'success');
            setAttentionModal(null);
            await refreshAttention();
        } catch (err) {
            showToast('❌ Не удалось добавить в наблюдение', 'error');
            console.error('Failed to add attention:', err);
        }
    };

    const handlePageChange = (newPage: number) => {
        setPage(newPage);
        refreshDrivers(newPage, searchQuery);
    };

    const handleSearch = (query: string) => {
        setSearchQuery(query);
        setPage(1);
        refreshDrivers(1, query);
    };

    const handleShowAllAttention = async () => {
        try {
            const res = await fetch('/api/monitoring/attention?limit=100');
            const data = await res.json();
            setAttention(data.items);
            setAttentionTotal(data.total);
        } catch (err) {
            console.error('Failed to load all attention:', err);
        }
    };

    return (
        <div className="flex flex-col gap-6 p-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-bold">Мониторинг водителей</h1>
                <Button
                    onClick={() => {
                        if (drivers.length > 0) {
                            setAttentionModal({ driverId: drivers[0].id, driverName: drivers[0].fullName });
                        }
                    }}
                    className="gap-2"
                >
                    <Plus className="h-4 w-4" />
                    Добавить в наблюдение
                </Button>
            </div>

            {/* Stats */}
            <StatsBar stats={stats} />

            {/* Attention Section */}
            <AttentionSection
                items={attention}
                total={attentionTotal}
                checksLimitReached={stats.checksLimitReached}
                onCall={handleCall}
                onMessage={handleMessage}
                onFleetCheck={handleFleetCheck}
                onResolve={handleResolve}
                onShowAll={handleShowAllAttention}
            />

            {/* All Drivers */}
            <AllDriversSection
                drivers={drivers}
                total={total}
                page={page}
                limit={20}
                checksLimitReached={stats.checksLimitReached}
                onPageChange={handlePageChange}
                onSearch={handleSearch}
                onCall={handleCall}
                onMessage={handleMessage}
                onFleetCheck={handleFleetCheck}
            />

            {/* Modals */}
            {fleetCheckModal && (
                <FleetCheckModal
                    driverName={fleetCheckModal.driverName}
                    onSubmit={(license) => startFleetCheck(fleetCheckModal.driverId, license)}
                    onClose={() => setFleetCheckModal(null)}
                />
            )}
            {attentionModal && (
                <AddToAttentionModal
                    driverName={attentionModal.driverName}
                    onSubmit={handleAddAttention}
                    onClose={() => setAttentionModal(null)}
                />
            )}
        </div>
    );
}
