"use client"

import { useState, useEffect } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import {
    Check,
    SkipForward,
    Phone,
    Send,
    AlertTriangle,
    ChevronLeft,
    ChevronRight,
    Inbox as InboxIcon,
    Filter,
} from "lucide-react"
import type { InboxTask } from "./actions"
import { resolveTask } from "./actions"
import { logManagerCall } from "../drivers/actions"
import { SegmentBadge } from "../drivers/components/SegmentBadge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import Link from "next/link"

// ─── Priority badge ────────────────────────────────────────────────────────

function PriorityBadge({ priority }: { priority: string }) {
    const styles: Record<string, string> = {
        high: "bg-red-100 text-red-700 border-red-200",
        medium: "bg-amber-100 text-amber-700 border-amber-200",
        low: "bg-blue-100 text-blue-700 border-blue-200",
    }
    const labels: Record<string, string> = {
        high: "Высокий",
        medium: "Средний",
        low: "Низкий",
    }

    return (
        <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase ${styles[priority] || styles.medium}`}>
            {labels[priority] || priority}
        </span>
    )
}

// ─── Task Card ──────────────────────────────────────────────────────────────

function TaskCard({
    task,
    onResolve,
}: {
    task: InboxTask
    onResolve: (id: string, resolution: "done" | "skipped") => void
}) {
    const [callLogged, setCallLogged] = useState(false)

    const handleCall = async () => {
        await logManagerCall(task.driverId)
        setCallLogged(true)
        setTimeout(() => setCallLogged(false), 2000)
    }

    const timeAgo = getTimeAgo(new Date(task.createdAt))

    return (
        <div className="group relative flex items-start gap-4 rounded-xl border bg-card p-4 shadow-sm transition-all hover:shadow-md hover:border-primary/20">
            {/* Priority indicator */}
            <div className={`mt-1 h-2 w-2 rounded-full shrink-0 ${
                task.priority === "high" ? "bg-red-500" :
                task.priority === "medium" ? "bg-amber-500" : "bg-blue-500"
            }`} />

            {/* Content */}
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                    <Link
                        href={`/drivers/${task.driverId}`}
                        className="text-sm font-bold text-foreground hover:text-primary transition-colors truncate"
                    >
                        {task.driverName}
                    </Link>
                    <SegmentBadge segment={task.driverSegment} />
                    <PriorityBadge priority={task.priority} />
                </div>
                <p className="text-sm text-muted-foreground mb-2 line-clamp-1">
                    {task.title}
                </p>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground/60">
                    <span>{timeAgo}</span>
                    {task.driverPhone && (
                        <>
                            <span>•</span>
                            <span className="font-mono">{task.driverPhone}</span>
                        </>
                    )}
                </div>
            </div>

            {/* Actions */}
            <div className="flex gap-1.5 shrink-0">
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-green-600 hover:bg-green-50 hover:text-green-700"
                    onClick={() => onResolve(task.id, "done")}
                    title="Выполнено"
                >
                    <Check size={16} />
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:bg-secondary"
                    onClick={() => onResolve(task.id, "skipped")}
                    title="Пропустить"
                >
                    <SkipForward size={16} />
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    className={`h-8 w-8 ${callLogged ? "text-emerald-600 bg-emerald-50" : "text-blue-600 hover:bg-blue-50"}`}
                    onClick={handleCall}
                    title="Позвонил"
                >
                    <Phone size={14} />
                </Button>
            </div>
        </div>
    )
}

function getTimeAgo(date: Date): string {
    const diff = Date.now() - date.getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 60) return `${mins}м назад`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}ч назад`
    const days = Math.floor(hrs / 24)
    return `${days}д назад`
}

// ─── Main Inbox Client ─────────────────────────────────────────────────────

interface InboxClientProps {
    tasks: InboxTask[]
    total: number
    counts: { high: number; medium: number; low: number; total: number }
    currentPage: number
    initialStatus: string
    initialPriority: string
    initialSearch: string
}

export default function InboxClient({
    tasks,
    total,
    counts,
    currentPage,
    initialStatus,
    initialPriority,
    initialSearch,
}: InboxClientProps) {
    const router = useRouter()
    const pathname = usePathname()
    const searchParams = useSearchParams()
    const [search, setSearch] = useState(initialSearch)
    const pageSize = 30
    const totalPages = Math.ceil(total / pageSize)

    const updateFilters = (overrides: Record<string, string | number> = {}) => {
        const params = new URLSearchParams(searchParams.toString())
        for (const [key, val] of Object.entries(overrides)) {
            if (val && val !== "all" && val !== "open") params.set(key, String(val))
            else params.delete(key)
        }
        params.set("page", "1")
        router.push(`${pathname}?${params.toString()}`)
    }

    const handleResolve = async (taskId: string, resolution: "done" | "skipped") => {
        await resolveTask(taskId, resolution)
        router.refresh()
    }

    return (
        <div className="flex flex-col gap-6 animate-in fade-in duration-500">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-foreground flex items-center gap-3">
                        <InboxIcon size={24} className="text-primary" />
                        Входящие
                    </h1>
                    <p className="text-sm text-muted-foreground mt-0.5">
                        Задачи, требующие внимания менеджера
                    </p>
                </div>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-4 gap-3">
                <div className="rounded-xl border bg-card p-4 shadow-sm">
                    <div className="text-2xl font-bold text-foreground">{counts.total}</div>
                    <div className="text-xs text-muted-foreground">Всего открытых</div>
                </div>
                <div className="rounded-xl border bg-card p-4 shadow-sm border-l-4 border-l-red-500">
                    <div className="text-2xl font-bold text-red-600">{counts.high}</div>
                    <div className="text-xs text-muted-foreground">Высокий приоритет</div>
                </div>
                <div className="rounded-xl border bg-card p-4 shadow-sm border-l-4 border-l-amber-500">
                    <div className="text-2xl font-bold text-amber-600">{counts.medium}</div>
                    <div className="text-xs text-muted-foreground">Средний</div>
                </div>
                <div className="rounded-xl border bg-card p-4 shadow-sm border-l-4 border-l-blue-500">
                    <div className="text-2xl font-bold text-blue-600">{counts.low}</div>
                    <div className="text-xs text-muted-foreground">Низкий</div>
                </div>
            </div>

            {/* Filters */}
            <div className="flex gap-3 items-end">
                <div className="w-40">
                    <label className="mb-2 block text-xs font-medium text-muted-foreground uppercase">Статус</label>
                    <select
                        value={initialStatus}
                        onChange={(e) => updateFilters({ status: e.target.value })}
                        className="flex h-10 w-full rounded-md border bg-secondary/50 px-3 py-2 text-sm"
                    >
                        <option value="open">Открытые</option>
                        <option value="done">Выполненные</option>
                        <option value="skipped">Пропущенные</option>
                        <option value="all">Все</option>
                    </select>
                </div>
                <div className="w-40">
                    <label className="mb-2 block text-xs font-medium text-muted-foreground uppercase">Приоритет</label>
                    <select
                        value={initialPriority}
                        onChange={(e) => updateFilters({ priority: e.target.value })}
                        className="flex h-10 w-full rounded-md border bg-secondary/50 px-3 py-2 text-sm"
                    >
                        <option value="all">Все</option>
                        <option value="high">Высокий</option>
                        <option value="medium">Средний</option>
                        <option value="low">Низкий</option>
                    </select>
                </div>
                <form onSubmit={(e) => { e.preventDefault(); updateFilters({ search }) }} className="flex-1 flex gap-2">
                    <Input
                        placeholder="Поиск по ФИО..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="h-10 bg-secondary/50"
                    />
                    <Button type="submit" className="h-10"><Filter size={16} /></Button>
                </form>
            </div>

            {/* Task List */}
            {tasks.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center rounded-xl border border-dashed border-muted-foreground/30 text-muted-foreground bg-card">
                    <InboxIcon size={48} className="mb-4 opacity-30" />
                    <p className="font-medium">Нет задач</p>
                    <p className="text-xs mt-1">Все задачи выполнены!</p>
                </div>
            ) : (
                <div className="space-y-2">
                    {tasks.map((task) => (
                        <TaskCard key={task.id} task={task} onResolve={handleResolve} />
                    ))}
                </div>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="flex items-center justify-between rounded-xl border bg-card px-4 py-3 shadow-sm">
                    <div className="text-sm text-muted-foreground">
                        {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, total)} из {total}
                    </div>
                    <div className="flex gap-2">
                        <Button variant="outline" size="icon" disabled={currentPage <= 1}
                            onClick={() => updateFilters({ page: currentPage - 1 })}>
                            <ChevronLeft className="h-4 w-4" />
                        </Button>
                        <div className="flex items-center px-4 font-medium text-sm">{currentPage} / {totalPages}</div>
                        <Button variant="outline" size="icon" disabled={currentPage >= totalPages}
                            onClick={() => updateFilters({ page: currentPage + 1 })}>
                            <ChevronRight className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
            )}
        </div>
    )
}
