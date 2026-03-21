import { getApiConnections } from '../actions'
import ApiListClient from '../ApiListClient'
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"

export const dynamic = 'force-dynamic'

const API_ENDPOINTS = [
    // --- ПАРК И ПРОФИЛИ ---
    {
        provider: "Yandex Fleet API",
        endpoint: "POST /v1/parks/driver-profiles/list",
        method: "POST",
        description: "Получение списка профилей водителей парка с их статусами и данными.",
        auth: "X-Client-ID, X-Api-Key",
    },
    {
        provider: "Yandex Fleet API",
        endpoint: "GET /v1/parks/driver-profiles",
        method: "GET",
        description: "Получение данных о конкретном профиле водителя (по ID).",
        auth: "X-Client-ID, X-Api-Key",
    },
    {
        provider: "Yandex Fleet API",
        endpoint: "PUT /v1/parks/driver-profiles",
        method: "PUT",
        description: "Создание профиля водителя в парке.",
        auth: "X-Client-ID, X-Api-Key",
    },
    {
        provider: "Yandex Fleet API",
        endpoint: "GET /v1/parks/driver-work-rules",
        method: "GET",
        description: "Получение списка доступных условий работы (тарифов) для парка.",
        auth: "X-Client-ID, X-Api-Key",
    },
    {
        provider: "Yandex Fleet API",
        endpoint: "POST /v1/parks/driver-work-rules/list",
        method: "POST",
        description: "Получение детальных настроек условий работы (комиссии, лимиты, ограничения).",
        auth: "X-Client-ID, X-Api-Key",
    },
    {
        provider: "Yandex Fleet API",
        endpoint: "POST /v1/parks/cars/list",
        method: "POST",
        description: "Получение списка автомобилей парка (включая марку, модель, госномер).",
        auth: "X-Client-ID, X-Api-Key",
    },
    {
        provider: "Yandex Fleet API",
        endpoint: "GET /v1/parks/cars",
        method: "GET",
        description: "Получение данных о конкретном автомобиле.",
        auth: "X-Client-ID, X-Api-Key",
    },
    {
        provider: "Yandex Fleet API",
        endpoint: "POST /v1/parks/driver-profiles/car-bindings",
        method: "POST",
        description: "Работа с привязками водителей к автомобилям.",
        auth: "X-Client-ID, X-Api-Key",
    },

    // --- ФИНАНСЫ И БАЛАНСЫ ---
    {
        provider: "Yandex Fleet API",
        endpoint: "POST /v1/parks/driver-profiles/balances",
        method: "POST",
        description: "Получение текущих балансов водителей в автопарке.",
        auth: "X-Client-ID, X-Api-Key",
    },
    {
        provider: "Yandex Fleet API",
        endpoint: "POST /v2/parks/driver-profiles/transactions/list",
        method: "POST",
        description: "Получение выписки по счету (списания, начисления, комиссии) по водителям.",
        auth: "X-Client-ID, X-Api-Key",
    },
    {
        provider: "Yandex Fleet API",
        endpoint: "POST /v1/parks/driver-profiles/transactions/categories",
        method: "POST",
        description: "Справочник категорий транзакций.",
        auth: "X-Client-ID, X-Api-Key",
    },
    {
        provider: "Yandex Fleet API",
        endpoint: "POST /v1/parks/driver-profiles/transactions",
        method: "POST",
        description: "Создание новой транзакции (ручное пополнение баланса или списание штрафа/аренды).",
        auth: "X-Client-ID, X-Api-Key",
    },

    // --- ЗАКАЗЫ И ДОПОЛНИТЕЛЬНО ---
    {
        provider: "Yandex Fleet API",
        endpoint: "POST /v2/parks/orders/list",
        method: "POST",
        description: "Получение истории заказов по парку с фильтрацией по дате и водителям.",
        auth: "X-Client-ID, X-Api-Key",
    },
    {
        provider: "Yandex Fleet API",
        endpoint: "POST /v1/parks/receipts/list",
        method: "POST",
        description: "Получение чеков по заказам.",
        auth: "X-Client-ID, X-Api-Key",
    }
]

export default async function SettingsPage() {
    const connections = await getApiConnections()

    return (
        <div className="flex flex-col gap-10 pb-12 animate-in fade-in duration-500">
            {/* Primary Settings */}
            <ApiListClient initialConnections={connections} />

            {/* Reference Table */}
            <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2 p-2 border-b pb-4">
                    <h2 className="text-2xl font-bold text-foreground">Справочник Yandex Fleet API</h2>
                    <p className="text-sm text-muted-foreground">
                        Полный перечень доступных Endpoints для интеграции с Яндекс Про, включая еще не реализованные в CRM.
                    </p>
                </div>

                <div className="rounded-2xl border bg-card shadow-sm overflow-hidden">
                    <Table>
                        <TableHeader>
                            <TableRow className="bg-muted/50 hover:bg-muted/50">
                                <TableHead className="w-[200px]">Провайдер / Сервис</TableHead>
                                <TableHead className="w-[100px]">Метод</TableHead>
                                <TableHead className="w-[350px]">Endpoint</TableHead>
                                <TableHead>Описание</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {API_ENDPOINTS.map((api, idx) => (
                                <TableRow key={idx}>
                                    <TableCell className="font-medium">
                                        <div className="flex flex-col gap-1">
                                            <span>{api.provider}</span>
                                            <span className="text-xs text-muted-foreground">Авторизация: {api.auth}</span>
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <Badge variant={api.method === 'POST' ? 'default' : 'secondary'} className="font-mono text-[10px] uppercase">
                                            {api.method}
                                        </Badge>
                                    </TableCell>
                                    <TableCell>
                                        <code className="rounded bg-secondary/50 px-2 py-1 font-mono text-xs break-all text-secondary-foreground">
                                            {api.endpoint}
                                        </code>
                                    </TableCell>
                                    <TableCell className="text-sm text-muted-foreground">
                                        {api.description}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            </div>
        </div>
    )
}
