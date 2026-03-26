"use client";

import { useState } from "react";
import { ApiConnection } from "@prisma/client";
import { addApiConnection, deleteApiConnection, testApiRequest } from "./actions";
import { Trash2, Play, Plus, Server, CheckCircle2, XCircle } from "lucide-react";
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

    return (
        <div className="flex w-full flex-col gap-6 animate-in fade-in duration-500">
            <div className="flex w-full justify-end pb-2">
                <Button onClick={() => setIsAdding(!isAdding)} className="h-11 px-6">
                    <Plus size={18} className="mr-2" /> Добавить API
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
                        <h3 className="mb-2 flex items-center gap-2 text-lg font-bold">
                            <Server className="text-primary" size={20} />
                            Новое подключение
                        </h3>
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                            <div className="space-y-2">
                                <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Client ID (clid)</label>
                                <Input name="clid" required className="bg-secondary/50" placeholder="Например: 1234..." />
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Park ID (parkId)</label>
                                <Input name="parkId" required className="bg-secondary/50" placeholder="Например: abc..." />
                            </div>
                        </div>
                        <div className="space-y-2">
                            <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">API Key</label>
                            <Input name="apiKey" type="password" required className="bg-secondary/50" placeholder="Ваш секретный ключ API..." />
                        </div>
                        <div className="mt-4 flex justify-end gap-3">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => setIsAdding(false)}
                            >
                                Отмена
                            </Button>
                            <Button type="submit">Сохранить API</Button>
                        </div>
                    </form>
                </div>
            )}

            {initialConnections.length === 0 && !isAdding && (
                <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed bg-card p-12 text-center">
                    <div className="mb-4 rounded-full bg-secondary p-4">
                        <Server size={32} className="text-muted-foreground" />
                    </div>
                    <h3 className="mb-2 text-xl font-bold text-foreground">Нет настроенных API</h3>
                    <p className="mb-6 max-w-sm text-sm text-muted-foreground">
                        Добавьте данные подключения, чтобы CRM могла получать информацию о водителях из Яндекс Про.
                    </p>
                    <Button onClick={() => setIsAdding(true)} size="lg">
                        <Plus size={18} className="mr-2" /> Добавить API
                    </Button>
                </div>
            )}

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
                {initialConnections.map((conn) => (
                    <div key={conn.id} className="flex flex-col justify-between gap-4 rounded-2xl border bg-card p-6 shadow-sm transition-all hover:shadow-md">
                        <div>
                            <div className="mb-4 flex items-start justify-between">
                                <div className="rounded-lg bg-blue-50 p-2 text-blue-600">
                                    <Server size={24} />
                                </div>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => deleteApiConnection(conn.id)}
                                    className="h-8 w-8 text-muted-foreground hover:bg-red-50 hover:text-red-600"
                                >
                                    <Trash2 size={16} />
                                </Button>
                            </div>

                            <div className="space-y-3">
                                <div>
                                    <div className="text-xs font-medium text-muted-foreground">Client ID</div>
                                    <div className="font-mono text-sm font-semibold">{conn.clid}</div>
                                </div>
                                <div>
                                    <div className="text-xs font-medium text-muted-foreground">Park ID</div>
                                    <div className="font-mono text-sm">{conn.parkId}</div>
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
                                    <>Тестирование...</>
                                ) : (
                                    <><Play size={16} className="mr-2" /> Проверить связь</>
                                )}
                            </Button>
                        </div>

                        {testResult?.id === conn.id && (
                            <div className={`mt-2 rounded-xl border p-4 shadow-inner ${testResult.success ? 'bg-green-50 border-green-100' : 'bg-red-50 border-red-100'}`}>
                                <div className="mb-3 flex items-center justify-between">
                                    <Badge variant={testResult.success ? "success" : "destructive"} className="pointer-events-none flex items-center gap-1">
                                        {testResult.success ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                                        {testResult.success ? "Успешно" : "Ошибка"}
                                    </Badge>
                                    <button
                                        onClick={() => setTestResult(null)}
                                        className="text-xs text-muted-foreground hover:text-foreground"
                                    >
                                        Закрыть
                                    </button>
                                </div>
                                <pre className={`custom-scrollbar max-h-40 overflow-auto rounded-lg bg-white/50 p-2 font-mono text-xs ${testResult.success ? 'text-green-800' : 'text-red-800'}`}>
                                    {testResult.result}
                                </pre>
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
