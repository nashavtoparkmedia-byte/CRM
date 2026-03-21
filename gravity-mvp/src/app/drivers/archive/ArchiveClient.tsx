"use client"

import { useState } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { ChevronLeft, ChevronRight, Search, ActivitySquare, RefreshCw } from "lucide-react"
import type { DriverWithCells } from "../actions"
import { syncArchivedDrivers } from "../actions"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"

import { FleetCheckModal } from "@/app/monitoring/components/FleetCheckModal"
import { ToastProvider, useToast } from "@/app/monitoring/components/Toast"
import { ActionButtons } from "@/app/monitoring/components/ActionButtons"
import { HistoryIcons } from "@/app/monitoring/components/HistoryIcons"
import { DriverHoverCard } from "@/app/monitoring/components/DriverHoverCard"
import { FLEET_STATUS_LABELS } from "@/app/monitoring/lib/constants"

function getFleetStatusLabel(status: string | null, lastCheckAt: string | null): string {
    if (!status && !lastCheckAt) return 'не проверяли';
    if (status === 'queued') return FLEET_STATUS_LABELS.queued || 'в очереди';
    if (status === 'failed') return FLEET_STATUS_LABELS.failed || 'ошибка';

    if (status === 'completed' && lastCheckAt) {
        const date = new Date(lastCheckAt);
        const daysDiff = Math.floor((Date.now() - date.getTime()) / 86400000);
        if (daysDiff < 1) return 'сегодня';
        if (daysDiff === 1) return 'вчера';
        return `${daysDiff} дн. назад`;
    }
    return '—';
}

function formatDate(date: Date | null | string): string {
    if (!date) return '—';
    return new Date(date).toLocaleDateString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit'
    });
}

export default function ArchiveClient(props: {
    initialDrivers: DriverWithCells[]
    total: number
    currentPage: number
    initialSearch: string
}) {
    return (
        <ToastProvider>
            <ArchiveClientInner {...props} />
        </ToastProvider>
    )
}
function ArchiveClientInner({
    initialDrivers,
    total,
    currentPage,
    initialSearch,
}: {
    initialDrivers: DriverWithCells[]
    total: number
    currentPage: number
    initialSearch: string
}) {
    const router = useRouter()
    const pathname = usePathname()
    const searchParams = useSearchParams()
    const { showToast } = useToast()

    const [search, setSearch] = useState(initialSearch)
    const [isLoading, setIsLoading] = useState(false)
    const [isSyncing, setIsSyncing] = useState(false)
    const [fleetCheckModal, setFleetCheckModal] = useState<{ driverId: string; driverName: string } | null>(null)

    const pageSize = 50
    const totalPages = Math.ceil(total / pageSize)

    const updateFilters = (overrides: { page?: number; search?: string } = {}) => {
        setIsLoading(true)
        const params = new URLSearchParams(searchParams.toString())

        const newSearch = overrides.search !== undefined ? overrides.search : search
        const newPage = overrides.page !== undefined ? overrides.page : undefined

        if (newSearch) params.set("search", newSearch)
        else params.delete("search")

        if (newPage !== undefined) params.set("page", String(newPage))
        else params.set("page", "1")

        router.push(`${pathname}?${params.toString()}`)
        setIsLoading(false)
    }

    const startFleetCheck = async (driverId: string, licenseNumber?: string) => {
        try {
            const body: Record<string, string> = {}
            if (licenseNumber) body.licenseNumber = licenseNumber

            const res = await fetch(`/api/monitoring/drivers/${driverId}/fleet-check`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })

            if (res.status === 429) {
                const data = await res.json()
                showToast(`⛔ Лимит проверок достигнут: ${data.errorCode}`, 'error')
                return
            }

            if (!res.ok) {
                const data = await res.json()
                showToast(`❌ ${data.error}`, 'error')
                return
            }

            const data = await res.json()
            showToast(`🔎 Проверка запущена (${data.checkId?.slice(0, 8)}...)`, 'success')
            setFleetCheckModal(null)
            router.refresh()
        } catch (err) {
            showToast('❌ Не удалось запустить проверку', 'error')
            console.error('Fleet check error:', err)
        }
    }

    const handleCall = async (driverId: string) => {
        try {
            await fetch(`/api/monitoring/drivers/${driverId}/event`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ eventType: 'call_attempt' }),
            });
            showToast('📞 Звонок зафиксирован', 'success');
            router.refresh()
        } catch (err) {
            console.error('Failed to log call:', err);
        }
    };

    const handleMessage = (driverId: string) => {
        const driver = initialDrivers.find((d) => d.id === driverId);
        if (driver) {
            showToast(`💬 Сообщение для: ${driver.fullName}`, 'info');
        }
    };

    const handleFleetCheckClick = (e: React.MouseEvent, driver: DriverWithCells) => {
        e.stopPropagation()
        // In this implementation the driver license might not be loaded initially on the archive page, 
        // so we always show the modal to enter/confirm the license number if we don't fetch it explicitly.
        // For simplicity and safety, asking for it or leaving it blank defaults to the modal.
        setFleetCheckModal({ driverId: driver.id, driverName: driver.fullName })
    }

    return (
        <div className="flex w-full flex-col gap-6">
            {/* Table with Filters */}
            <div className="flex flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
                
                {/* Search Bar */}
                <div className="flex flex-col gap-4 border-b p-4 md:flex-row md:items-end bg-secondary/10">
                    <form
                        onSubmit={(e) => {
                            e.preventDefault()
                            updateFilters()
                        }}
                        className="flex w-full flex-col gap-4 md:flex-row"
                    >
                        <div className="flex-1">
                            <label className="mb-2 block text-xs font-medium text-muted-foreground uppercase">
                                Поиск по ФИО в архиве
                            </label>
                            <Input
                                placeholder="Введите имя..."
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                className="h-10 bg-white"
                            />
                        </div>
                        <Button type="submit" className="h-10 px-8 self-end" disabled={isLoading || isSyncing}>
                            <Search className="mr-2 h-4 w-4" /> Найти
                        </Button>
                        <Button 
                            type="button" 
                            variant="outline" 
                            className="h-10 px-6 self-end gap-2"
                            disabled={isSyncing}
                            onClick={async () => {
                                setIsSyncing(true)
                                try {
                                    const res = await syncArchivedDrivers()
                                    showToast(`✅ Загружено ${res.count} водителей из архива`, 'success')
                                    updateFilters({ page: 1 }) // refresh
                                } catch (err: any) {
                                    showToast(`❌ Ошибка синхронизации: ${err.message}`, 'error')
                                } finally {
                                    setIsSyncing(false)
                                }
                            }}
                        >
                            <RefreshCw className={`h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`} />
                            {isSyncing ? 'Загрузка...' : `Синхронизировать с Яндекс (${total})`}
                        </Button>
                    </form>
                </div>

                {/* Table Data */}
                <div className="overflow-x-auto">
                    <Table>
                        <TableHeader>
                            <TableRow className="bg-muted/50 hover:bg-muted/50">
                                <TableHead className="w-[200px]">Водитель</TableHead>
                                <TableHead className="w-[120px]">Телефон</TableHead>
                                <TableHead className="w-[120px]">Добавлен</TableHead>
                                <TableHead className="w-[120px]">Посл. заказ</TableHead>
                                <TableHead className="w-[120px]">Уволен</TableHead>
                                <TableHead className="w-[120px]">ВУ</TableHead>
                                <TableHead className="w-[100px]">Парк</TableHead>
                                <TableHead className="w-[100px]">Проверка</TableHead>
                                <TableHead className="w-[80px]">История</TableHead>
                                <TableHead className="text-right">Действия</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading ? (
                                <TableRow>
                                    <TableCell colSpan={4} className="h-24 text-center">
                                        Загрузка...
                                    </TableCell>
                                </TableRow>
                            ) : initialDrivers.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                                        В архиве нет водителей, соответствующих поиску.
                                    </TableCell>
                                </TableRow>
                            ) : (
                                initialDrivers.map((driver) => (
                                    <TableRow
                                        key={driver.id}
                                        className="group cursor-pointer hover:bg-muted/30"
                                        onClick={() => router.push(`/drivers/${driver.id}`)}
                                    >
                                        <TableCell className="font-medium text-foreground">
                                            {driver.fullName}
                                            <div className="text-xs text-muted-foreground mt-0.5 font-mono">
                                                ID: {driver.yandexDriverId.substring(0, 6)}...
                                            </div>
                                        </TableCell>

                                        <TableCell className="text-xs">
                                            {driver.phone || '—'}
                                        </TableCell>

                                        <TableCell className="text-xs">
                                            {formatDate(driver.hiredAt)}
                                        </TableCell>

                                        <TableCell className="text-xs">
                                            {formatDate(driver.lastOrderAt)}
                                        </TableCell>

                                        <TableCell className="text-xs">
                                            {formatDate(driver.dismissedAt)}
                                        </TableCell>

                                        <TableCell className="text-xs font-mono">
                                            {driver.licenseNumber || '—'}
                                        </TableCell>

                                        <TableCell className="text-xs italic text-muted-foreground truncate max-w-[100px]">
                                            {driver.lastExternalPark || '—'}
                                        </TableCell>

                                        <TableCell className="text-[11px]">
                                            <span className={
                                                driver.lastFleetCheckStatus === 'queued' ? 'text-amber-600' :
                                                driver.lastFleetCheckStatus === 'failed' ? 'text-destructive' :
                                                'text-muted-foreground'
                                            }>
                                                {getFleetStatusLabel(driver.lastFleetCheckStatus, driver.lastFleetCheckAt as any)}
                                            </span>
                                        </TableCell>

                                        <TableCell>
                                            <DriverHoverCard driverId={driver.id} driverName={driver.fullName} phone={driver.phone}>
                                                <div className="flex items-center">
                                                     <HistoryIcons eventTypes={driver.recentEvents || []} />
                                                </div>
                                            </DriverHoverCard>
                                        </TableCell>

                                        <TableCell className="text-right">
                                            <ActionButtons
                                                driverId={driver.id}
                                                phone={driver.phone}
                                                licenseNumber={driver.licenseNumber} 
                                                checksLimitReached={false}
                                                lastFleetCheckStatus={driver.lastFleetCheckStatus}
                                                onCall={handleCall}
                                                onMessage={handleMessage}
                                                onFleetCheck={() => {
                                                    if (driver.licenseNumber) {
                                                        startFleetCheck(driver.id, driver.licenseNumber)
                                                    } else {
                                                        setFleetCheckModal({ driverId: driver.id, driverName: driver.fullName })
                                                    }
                                                }}
                                            />
                                        </TableCell>
                                    </TableRow>
                                ))
                            )}
                        </TableBody>
                    </Table>
                </div>

                {/* Pagination */}
                <div className="flex items-center justify-between border-t bg-muted/20 px-4 py-3 sm:px-6">
                    <div className="text-sm text-muted-foreground">
                        Показаны с{" "}
                        <span className="font-medium text-foreground">
                            {total === 0 ? 0 : (currentPage - 1) * pageSize + 1}
                        </span>{" "}
                        по{" "}
                        <span className="font-medium text-foreground">
                            {Math.min(currentPage * pageSize, total)}
                        </span>{" "}
                        из{" "}
                        <span className="font-medium text-foreground">{total}</span>
                    </div>
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            size="icon"
                            onClick={() => updateFilters({ page: currentPage - 1 })}
                            disabled={currentPage <= 1 || isLoading}
                        >
                            <ChevronLeft className="h-4 w-4" />
                        </Button>
                        <div className="flex items-center justify-center px-4 font-medium text-sm">
                            {currentPage} / {totalPages || 1}
                        </div>
                        <Button
                            variant="outline"
                            size="icon"
                            onClick={() => updateFilters({ page: currentPage + 1 })}
                            disabled={currentPage >= totalPages || isLoading}
                        >
                            <ChevronRight className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
            </div>

            {fleetCheckModal && (
                <FleetCheckModal
                    driverName={fleetCheckModal.driverName}
                    onSubmit={(license) => startFleetCheck(fleetCheckModal.driverId, license)}
                    onClose={() => setFleetCheckModal(null)}
                />
            )}
        </div>
    )
}
