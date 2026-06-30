"use client";

import { useState, useEffect } from "react";
import { ApiConnection } from "@prisma/client";
import { addApiConnection, deleteApiConnection, testApiRequest, updateApiConnectionName } from "./actions";
import { Trash2, Play, Plus, Pencil, Check, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type StatusMap = Record<string, 'checking' | 'ok' | 'error'>;

export default function ApiListClient({
    initialConnections,
}: {
    initialConnections: ApiConnection[];
}) {
    const [isAdding, setIsAdding] = useState(false);
    const [testResult, setTestResult] = useState<{ id: string; result: string; success: boolean } | null>(null);
    const [loadingTest, setLoadingTest] = useState<string | null>(null);
    const [editingName, setEditingName] = useState<string | null>(null);
    const [nameValue, setNameValue] = useState<string>("");
    const [statusMap, setStatusMap] = useState<StatusMap>(() =>
        Object.fromEntries(initialConnections.map(c => [c.id, 'checking']))
    );

    // Auto-check all connections on mount
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
        try {
            const log = await testApiRequest(connectionId);
            const parsed = JSON.parse(log.responseBody || "{}");
            const ok = !parsed.error && !parsed.error_message;
            setStatusMap(prev => ({ ...prev, [connectionId]: ok ? 'ok' : 'error' }));
            setTestResult({
                id: connectionId,
                result: JSON.stringify(parsed, null, 2),
                success: ok,
            });
        } catch (err: any) {
            setStatusMap(prev => ({ ...prev, [connectionId]: 'error' }));
            setTestResult({ id: connectionId, result: err.message, success: false });
        }
        setLoadingTest(null);
    };

    const startEditName = (conn: ApiConnection) => {
        setEditingName(conn.id);
        setNameValue(conn.name || "");
    };

    const saveName = async (id: string) => {
        await updateApiConnectionName(id, nameValue);
        setEditingName(null);
    };

    return (
        <div className="flex w-full flex-col gap-6 animate-in fade-in duration-500">
            <div className="flex w-full justify-end pb-[2px]">
                <Button onClick={() => setIsAdding(!isAdding)} className="h-11 px-6">
                    <Plus size={18} className="mr-[2px]" /> Добавить API
                </Button>
            </div>

            {isAdding && (
                <div className="rounded-2xl border bg-card p-6 shadow-sm animate-in fade-in slide-in-from-top-4">
                    <form
                        action={async (formData) => {
                            await addApiConnection(formData);
                            setIsAdding(false);
                        }}
                        className="flex flex-col gap-5"
                    >
                        <h3 className="mb-[2px] flex items-center gap-[2px] text-lg font-bold">
                            <Server className="text-primary" size={20} />
                            Новое подключение
                        </h3>
                        <div className="space-y-[2px]">
                            <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Название парка</label>
                            <Input name="name" className="bg-secondary/50" placeholder="Например: Yoko, Наш Автопарк..." />
                        </div>
                        <div className="grid grid-cols-1 gap-[4px] md:grid-cols-2">
                            <div className="space-y-[2px]">
                                <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Client ID (clid)</label>
                                <Input name="clid" required className="bg-secondary/50" placeholder="Например: 1234..." />
                            </div>
                            <div className="space-y-[2px]">
                                <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Park ID (parkId)</label>
                                <Input name="parkId" required className="bg-secondary/50" placeholder="Например: abc..." />
                            </div>
                        </div>
                        <div className="space-y-[2px]">
                            <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">API Key</label>
                            <Input name="apiKey" type="password" required className="bg-secondary/50" placeholder="Ваш секретный ключ API..." />
                        </div>
                        <div className="mt-[4px] flex justify-end gap-3">
                            <Button type="button" variant="outline" onClick={() => setIsAdding(false)}>
                                Отмена
                            </Button>
                            <Button type="submit">Сохранить API</Button>
                        </div>
                    </form>
                </div>
            )}

            {initialConnections.length === 0 && !isAdding && (
                <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed bg-card p-[12px] text-center">
                    <div className="mb-[4px] rounded-full bg-secondary p-[4px]">
                        <Server size={32} className="text-muted-foreground" />
                    </div>
                    <h3 className="mb-[2px] text-xl font-bold text-foreground">Нет настроенных API</h3>
                    <p className="mb-6 max-w-sm text-sm text-muted-foreground">
                        Добавьте данные подключения, чтобы CRM могла получать информацию о водителях из Яндекс Про.
                    </p>
                    <Button onClick={() => setIsAdding(true)} size="lg">
                        <Plus size={18} className="mr-[2px]" /> Добавить API
                    </Button>
                </div>
            )}

            <div className="flex flex-col divide-y rounded-2xl border bg-card overflow-hidden">
                {initialConnections.map((conn) => {
                    const status = statusMap[conn.id];
                    const isConnected = status === 'ok';
                    const isFailed = status === 'error';

                    return (
                        <div key={conn.id} className="flex items-center gap-4 px-5 py-4 hover:bg-surface transition-colors">
                            {/* Status dot */}
                            <span className={`h-2.5 w-2.5 shrink-0 rounded-full transition-colors duration-500 ${isConnected ? 'bg-green-500' : isFailed ? 'bg-red-500' : 'bg-gray-300 animate-pulse'}`} />

                            {/* Name */}
                            <div className="flex-1 min-w-0">
                                {editingName === conn.id ? (
                                    <div className="flex items-center gap-1">
                                        <Input
                                            value={nameValue}
                                            onChange={e => setNameValue(e.target.value)}
                                            onKeyDown={e => e.key === 'Enter' && saveName(conn.id)}
                                            className="h-8 text-sm font-semibold"
                                            autoFocus
                                        />
                                        <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0 text-green-600" onClick={() => saveName(conn.id)}>
                                            <Check size={15} />
                                        </Button>
                                    </div>
                                ) : (
                                    <button onClick={() => startEditName(conn)} className="group flex items-center gap-1.5 min-w-0 text-left">
                                        <span className="text-sm font-semibold text-foreground">
                                            {conn.name || <span className="text-muted-foreground font-normal italic">Без названия</span>}
                                        </span>
                                        <Pencil size={12} className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                                    </button>
                                )}
                                <div className="font-mono text-xs text-muted-foreground truncate mt-0.5">{conn.parkId}</div>
                            </div>

                            {/* Actions */}
                            <div className="flex items-center gap-1 shrink-0">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleTest(conn.id)}
                                    disabled={loadingTest === conn.id}
                                    className="h-8 px-3 text-xs text-muted-foreground"
                                >
                                    {loadingTest === conn.id ? 'Проверяю...' : <><Play size={13} className="mr-1" />Проверить</>}
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => deleteApiConnection(conn.id)}
                                    className="h-8 w-8 text-muted-foreground hover:bg-red-50 hover:text-red-600"
                                >
                                    <Trash2 size={15} />
                                </Button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
