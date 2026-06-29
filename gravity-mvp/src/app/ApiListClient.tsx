"use client";

import { useState } from "react";
import { ApiConnection } from "@prisma/client";
import { addApiConnection, deleteApiConnection, testApiRequest, updateApiConnectionName } from "./actions";
import { Trash2, Play, Plus, Server, CheckCircle2, XCircle, Pencil, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

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

    const handleTest = async (connectionId: string) => {
        setLoadingTest(connectionId);
        try {
            const log = await testApiRequest(connectionId);
            const parsed = JSON.parse(log.responseBody || "{}");
            setTestResult({
                id: connectionId,
                result: JSON.stringify(parsed, null, 2),
                success: !parsed.error && !parsed.error_message
            });
        } catch (err: any) {
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

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
                {initialConnections.map((conn) => {
                    const isConnected = testResult?.id === conn.id && testResult.success;
                    const isFailed = testResult?.id === conn.id && !testResult.success;

                    return (
                        <div key={conn.id} className="flex flex-col justify-between gap-[4px] rounded-2xl border bg-card p-6 shadow-sm transition-all hover:shadow-md">
                            <div>
                                {/* Header: name + status dot + delete */}
                                <div className="mb-4 flex items-start justify-between gap-2">
                                    <div className="flex flex-1 items-center gap-2 min-w-0">
                                        <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${isConnected ? 'bg-green-500' : isFailed ? 'bg-red-500' : 'bg-gray-300'}`} />
                                        {editingName === conn.id ? (
                                            <div className="flex flex-1 items-center gap-1">
                                                <Input
                                                    value={nameValue}
                                                    onChange={e => setNameValue(e.target.value)}
                                                    onKeyDown={e => e.key === 'Enter' && saveName(conn.id)}
                                                    className="h-8 text-base font-semibold"
                                                    autoFocus
                                                />
                                                <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0 text-green-600" onClick={() => saveName(conn.id)}>
                                                    <Check size={16} />
                                                </Button>
                                            </div>
                                        ) : (
                                            <button
                                                onClick={() => startEditName(conn)}
                                                className="group flex items-center gap-1.5 min-w-0"
                                            >
                                                <span className="truncate text-base font-semibold text-foreground">
                                                    {conn.name || <span className="text-muted-foreground font-normal italic">Без названия</span>}
                                                </span>
                                                <Pencil size={13} className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                                            </button>
                                        )}
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => deleteApiConnection(conn.id)}
                                        className="h-8 w-8 shrink-0 text-muted-foreground hover:bg-red-50 hover:text-red-600"
                                    >
                                        <Trash2 size={16} />
                                    </Button>
                                </div>

                                {/* IDs */}
                                <div className="space-y-2">
                                    <div>
                                        <div className="text-xs font-medium text-muted-foreground">Park ID</div>
                                        <div className="font-mono text-xs text-foreground/70 truncate">{conn.parkId}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs font-medium text-muted-foreground">Client ID</div>
                                        <div className="font-mono text-xs text-foreground/70 truncate">{conn.clid}</div>
                                    </div>
                                </div>
                            </div>

                            <div className="mt-4 border-t pt-4">
                                <Button
                                    variant="secondary"
                                    onClick={() => handleTest(conn.id)}
                                    disabled={loadingTest === conn.id}
                                    className="w-full"
                                >
                                    {loadingTest === conn.id ? (
                                        <>Проверяю...</>
                                    ) : (
                                        <><Play size={16} className="mr-[2px]" /> Проверить связь</>
                                    )}
                                </Button>
                            </div>

                            {testResult?.id === conn.id && (
                                <div className={`mt-[2px] rounded-xl border p-[4px] shadow-inner ${testResult.success ? 'bg-green-50 border-green-100' : 'bg-red-50 border-red-100'}`}>
                                    <div className="mb-3 flex items-center justify-between">
                                        <Badge variant={testResult.success ? "success" : "destructive"} className="pointer-events-none flex items-center gap-1">
                                            {testResult.success ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                                            {testResult.success ? "Связь активна" : "Ошибка"}
                                        </Badge>
                                        <button onClick={() => setTestResult(null)} className="text-xs text-muted-foreground hover:text-foreground">
                                            Закрыть
                                        </button>
                                    </div>
                                    <pre className={`custom-scrollbar max-h-40 overflow-auto rounded-lg bg-white/50 p-[2px] font-mono text-xs ${testResult.success ? 'text-green-800' : 'text-red-800'}`}>
                                        {testResult.result}
                                    </pre>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
