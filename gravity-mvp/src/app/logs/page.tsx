import { getApiLogs } from '@/modules/fleet-operations/public/v1/yandex-fleet-operations'
export const dynamic = 'force-dynamic'
import NeumorphicCard from '@/components/NeumorphicCard'
import Header from '@/components/Header'
import { requireIntegrationAdminPageAccess } from '@/modules/identity-access/public/v1'

export default async function LogsPage() {
    await requireIntegrationAdminPageAccess('/logs')
    const logs = await getApiLogs()

    return (
        <main className="max-w-6xl mx-auto p-6 flex flex-col gap-[8px]">
            <Header />

            <div className="flex flex-col gap-6 w-full mt-[4px]">
                {logs.length === 0 ? (
                    <div className="text-center py-[12px] text-gray-500">
                        No API logs recorded yet. Go to Dashboard and run a test.
                    </div>
                ) : (
                    logs.map(log => (
                        <NeumorphicCard key={log.id} className="flex flex-col gap-3">
                            <div className="flex justify-between items-center border-b border-gray-700/50 pb-3">
                                <div className="flex items-center gap-3">
                                    <span className={`px-[2px] py-1 rounded text-xs font-bold ${log.statusCode >= 200 && log.statusCode < 300 ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                                        {log.statusCode}
                                    </span>
                                    <span className="font-bold text-gray-200">{log.method}</span>
                                    <span className="text-sm font-mono text-gray-400">{log.requestUrl}</span>
                                </div>
                                <div className="flex items-center gap-[4px] text-sm text-gray-500 border-l border-gray-700/50 pl-[4px]">
                                    <span>{log.durationMs}ms</span>
                                    <span>{new Date(log.createdAt).toLocaleString()}</span>
                                </div>
                            </div>

                            <div className="mt-[2px]">
                                <p className="text-xs text-blue-400 font-semibold uppercase mb-[2px] tracking-wider">
                                    Client: {log.connection.clid} | Park: {log.connection.parkId}
                                </p>
                                <div className="bg-[#1e2129] p-[4px] rounded-xl shadow-inner overflow-hidden flex flex-col">
                                    <span className="text-xs text-gray-600 font-mono mb-[2px] block">Response JSON</span>
                                    <pre className="text-sm text-green-400/90 font-mono overflow-auto custom-scrollbar max-h-96">
                                        {parseOrFormatJson(log.responseBody || '{}')}
                                    </pre>
                                </div>
                            </div>
                        </NeumorphicCard>
                    ))
                )}
            </div>
        </main>
    )
}

function parseOrFormatJson(str: string) {
    try {
        const obj = JSON.parse(str)
        return JSON.stringify(obj, null, 2)
    } catch (e) {
        return str
    }
}
