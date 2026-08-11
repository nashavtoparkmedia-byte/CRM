"use client";

import { useState, useEffect } from "react";
import { addApiConnection, deleteApiConnection, testApiRequest, updateApiConnectionName } from '@/modules/fleet-operations/public/v1/yandex-fleet-operations';
import type { ApiConnectionPublicMetadata } from "@/modules/fleet-operations/public/v1/api-connection-public-metadata";
import { Trash2, Plus, Pencil, Check, Server, RefreshCw } from "lucide-react";
import { Button } from "@/infrastructure/ui/button";
import { Input } from "@/infrastructure/ui/input";

type StatusMap = Record<string, 'checking' | 'ok' | 'error'>;

function formatDate(date: Date | string) {
    return new Date(date).toLocaleDateString('ru-RU', {
        day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

export default function ApiListClient({
    initialConnections,
}: {
    initialConnections: ApiConnectionPublicMetadata[];
}) {
    const [isAdding, setIsAdding] = useState(false);
    const [loadingTest, setLoadingTest] = useState<string | null>(null);
    const [editingName, setEditingName] = useState<string | null>(null);
    const [nameValue, setNameValue] = useState<string>("");
    const [statusMap, setStatusMap] = useState<StatusMap>(() =>
        Object.fromEntries(initialConnections.map(c => [c.id, 'checking']))
    );

    useEffect(() => {
        initialConnections.forEach(async (conn) => {
            try {
                const log = await testApiRequest(conn.id);
                const parsed = JSON.parse(log.responseBody || "{}");
                const ok = !parsed.error && !parsed.error_message;
                setStatusMap(prev => ({ ...prev, [conn.id]: ok ? 'ok' : 'error' }));
            } catch {
                setStatusMap(prev => ({ ...prev, [conn.id]: 'error' }));
            }
        });
    }, []);

    const handleTest = async (connectionId: string) => {
        setLoadingTest(connectionId);
        setStatusMap(prev => ({ ...prev, [connectionId]: 'checking' }));
        try {
            const log = await testApiRequest(connectionId);
            const parsed = JSON.parse(log.responseBody || "{}");
            const ok = !parsed.error && !parsed.error_message;
            setStatusMap(prev => ({ ...prev, [connectionId]: ok ? 'ok' : 'error' }));
        } catch {
            setStatusMap(prev => ({ ...prev, [connectionId]: 'error' }));
        }
        setLoadingTest(null);
    };

    const startEditName = (conn: ApiConnectionPublicMetadata) => {
        setEditingName(conn.id);
        setNameValue(conn.name || "");
    };

    const saveName = async (id: string) => {
        await updateApiConnectionName(id, nameValue);
        setEditingName(null);
    };

    return (
        <div className="flex w-full flex-col gap-6 animate-in fade-in duration-500">
            <div className="flex w-full justify-end">
                <Button onClick={() => setIsAdding(!isAdding)} className="h-11 px-6">
                    <Plus size={18} className="mr-2" /> Добавить API
                </Button>
            </div>

            {isAdding && (
                <div className="rounded-2xl border bg-card p-6 animate-in fade-in slide-in-from-top-4">
                    <form
                        action={async (formData) => {
                            await addApiConnection(formData);
                            setIsAdding(false);
                        }}
                        className="flex flex-col gap-5"
                    >
                        <h3 className="flex items-center gap-2 text-lg font-semibold">
                            <Server className="text-primary" size={20} />
                            Новое подключение
                        </h3>
                        <div className="space-y-1">
                            <label className="text-xs font-medium text-muted-foreground">Название парка</label>
                            <Input name="name" className="bg-secondary/50" placeholder="Например: Yoko, Наш Автопарк..." />
                        </div>
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                            <div className="space-y-1">
                                <label className="text-xs font-medium text-muted-foreground">Client ID (clid)</label>
                                <Input name="clid" required className="bg-secondary/50" placeholder="taxi/park/..." />
                            </div>
                            <div className="space-y-1">
                                <label className="text-xs font-medium text-muted-foreground">Park ID</label>
                                <Input name="parkId" required className="bg-secondary/50" placeholder="45e30e9d..." />
                            </div>
                        </div>
                        <div className="space-y-1">
                            <label className="text-xs font-medium text-muted-foreground">API Key</label>
                            <Input name="apiKey" type="password" required className="bg-secondary/50" placeholder="Секретный ключ..." />
                        </div>
                        <div className="flex justify-end gap-3">
                            <Button type="button" variant="outline" onClick={() => setIsAdding(false)}>Отмена</Button>
                            <Button type="submit">Сохранить</Button>
                        </div>
                    </form>
                </div>
            )}

            {initialConnections.length === 0 && !isAdding && (
                <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed bg-card p-16 text-center">
                    <Server size={36} className="mb-4 text-muted-foreground" />
                    <h3 className="mb-2 text-lg font-semibold">Нет подключений</h3>
                    <p className="mb-6 text-sm text-muted-foreground">Добавьте API для интеграции с Яндекс Про</p>
                    <Button onClick={() => setIsAdding(true)}>
                        <Plus size={16} className="mr-2" /> Добавить API
                    </Button>
                </div>
            )}

            {initialConnections.length > 0 && (
                <div className="rounded-2xl border bg-card overflow-hidden">
                    {/* Table header */}
                    <div className="grid grid-cols-[2fr_3fr_1fr_1.5fr_auto] gap-4 border-b bg-surface/60 px-5 py-3 text-xs font-medium text-muted-foreground">
                        <div>Название</div>
                        <div>Client ID</div>
                        <div>Статус</div>
                        <div>Добавлено</div>
                        <div />
                    </div>

                    {/* Rows */}
                    {initialConnections.map((conn) => {
                        const status = statusMap[conn.id];
                        const isOk = status === 'ok';
                        const isError = status === 'error';
                        const isChecking = status === 'checking';

                        return (
                            <div
                                key={conn.id}
                                className="grid grid-cols-[2fr_3fr_1fr_1.5fr_auto] gap-4 items-center border-b last:border-b-0 px-5 py-4 hover:bg-surface/40 transition-colors"
                            >
                                {/* Name */}
                                <div className="min-w-0">
                                    {editingName === conn.id ? (
                                        <div className="flex items-center gap-1">
                                            <Input
                                                value={nameValue}
                                                onChange={e => setNameValue(e.target.value)}
                                                onKeyDown={e => { if (e.key === 'Enter') saveName(conn.id); if (e.key === 'Escape') setEditingName(null); }}
                                                className="h-8 text-sm font-medium"
                                                autoFocus
                                            />
                                            <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0 text-green-600 hover:text-green-700" onClick={() => saveName(conn.id)}>
                                                <Check size={15} />
                                            </Button>
                                        </div>
                                    ) : (
                                        <button onClick={() => startEditName(conn)} className="group flex items-center gap-1.5 text-left w-full">
                                            <span className="text-sm font-medium text-foreground truncate">
                                                {conn.name || <span className="italic text-muted-foreground font-normal">Без названия</span>}
                                            </span>
                                            <Pencil size={12} className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                                        </button>
                                    )}
                                </div>

                                {/* CLID */}
                                <div className="font-mono text-xs text-muted-foreground truncate">{conn.clid}</div>

                                {/* Status badge */}
                                <div>
                                    {isChecking && (
                                        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                                            <span className="h-2 w-2 rounded-full bg-gray-300 animate-pulse" />
                                            Проверка…
                                        </span>
                                    )}
                                    {isOk && (
                                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-700">
                                            <span className="h-2 w-2 rounded-full bg-green-500" />
                                            Активный
                                        </span>
                                    )}
                                    {isError && (
                                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600">
                                            <span className="h-2 w-2 rounded-full bg-red-500" />
                                            Ошибка
                                        </span>
                                    )}
                                </div>

                                {/* Date */}
                                <div className="text-xs text-muted-foreground">{formatDate(conn.createdAt)}</div>

                                {/* Actions */}
                                <div className="flex items-center gap-1">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => handleTest(conn.id)}
                                        disabled={loadingTest === conn.id}
                                        className="h-8 w-8 text-muted-foreground hover:text-primary"
                                        title="Проверить связь"
                                    >
                                        <RefreshCw size={14} className={loadingTest === conn.id ? 'animate-spin' : ''} />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => deleteApiConnection(conn.id)}
                                        className="h-8 w-8 text-muted-foreground hover:bg-red-50 hover:text-red-600"
                                        title="Удалить"
                                    >
                                        <Trash2 size={14} />
                                    </Button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
