"use client"

import { useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import type { DriverCard as DriverCardType } from "../actions"
import { DriverCard } from "./DriverCard"
import { Button } from "@/components/ui/button"

interface DriverCardGridProps {
    drivers: DriverCardType[]
    total: number
    page: number
    pageSize: number
    onPageChange: (page: number) => void
    onMessage: (driver: DriverCardType) => void
}

export function DriverCardGrid({
    drivers,
    total,
    page,
    pageSize,
    onPageChange,
    onMessage,
}: DriverCardGridProps) {
    const totalPages = Math.ceil(total / pageSize)

    return (
        <div className="flex flex-col gap-6">
            {/* Cards Grid */}
            {drivers.length === 0 ? (
                <div className="flex items-center justify-center rounded-xl border bg-card p-12 text-muted-foreground">
                    Водители не найдены
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {drivers.map((driver) => (
                        <DriverCard
                            key={driver.id}
                            driver={driver}
                            onMessage={onMessage}
                        />
                    ))}
                </div>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="flex items-center justify-between rounded-xl border bg-card px-4 py-3 shadow-sm">
                    <div className="text-sm text-muted-foreground">
                        Показаны с{" "}
                        <span className="font-medium text-foreground">
                            {(page - 1) * pageSize + 1}
                        </span>{" "}
                        по{" "}
                        <span className="font-medium text-foreground">
                            {Math.min(page * pageSize, total)}
                        </span>{" "}
                        из{" "}
                        <span className="font-medium text-foreground">{total}</span>
                    </div>
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            size="icon"
                            onClick={() => onPageChange(page - 1)}
                            disabled={page <= 1}
                        >
                            <ChevronLeft className="h-4 w-4" />
                        </Button>
                        <div className="flex items-center justify-center px-4 font-medium text-sm">
                            {page} / {totalPages}
                        </div>
                        <Button
                            variant="outline"
                            size="icon"
                            onClick={() => onPageChange(page + 1)}
                            disabled={page >= totalPages}
                        >
                            <ChevronRight className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
            )}
        </div>
    )
}
