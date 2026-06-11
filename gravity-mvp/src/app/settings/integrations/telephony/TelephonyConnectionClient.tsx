"use client"

import { useEffect, useState } from "react"
import {
    Save, AlertCircle, CheckCircle2, Loader2, RefreshCw,
    Eye, EyeOff, Info, ExternalLink,
} from "lucide-react"
import TelephonyTabs from "../_components/TelephonyTabs"

interface ParamMap {
    username?: string
    password?: string
    realm?: string
    proxy?: string
    'from-user'?: string
    'from-domain'?: string
    register?: string
    'expire-seconds'?: string
    'register-transport'?: string
}

interface CheckResult {
    ok: boolean
    label: string
    detail: string
}

interface StatusPayload {
    ok: boolean
    checks: Record<string, CheckResult>
}

const MASKED = '••••••••'

export default function TelephonyConnectionClient({ canEdit }: { canEdit: boolean }) {
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [params, setParams] = useState<ParamMap>({})
    const [initialParams, setInitialParams] = useState<ParamMap>({})
    const [confPath, setConfPath] = useState<string>('')

    const [status, setStatus] = useState<StatusPayload | null>(null)
    const [statusLoading, setStatusLoading] = useState(false)

    const [showPassword, setShowPassword] = useState(false)
    const [saving, setSaving] = useState(false)
    const [saveMsg, setSaveMsg] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null)

    async function loadConfig() {
        setLoading(true)
        setError(null)
        try {
            const r = await fetch('/api/settings/telephony-connection')
            const body = await r.json()
            if (!r.ok) throw new Error(body.error ?? `status ${r.status}`)
            setParams(body.params ?? {})
            setInitialParams(body.params ?? {})
            setConfPath(body.path ?? '')
        } catch (err: any) {
            setError(err.message ?? 'не удалось загрузить настройки')
        } finally {
            setLoading(false)
        }
    }

    async function loadStatus() {
        setStatusLoading(true)
        try {
            const r = await fetch('/api/settings/telephony-status')
            const body = await r.json()
            setStatus(body)
        } catch {
            setStatus(null)
        } finally {
            setStatusLoading(false)
        }
    }

    useEffect(() => {
        loadConfig()
        loadStatus()
        const interval = setInterval(loadStatus, 15000)  // refresh status every 15s
        return () => clearInterval(interval)
    }, [])

    const dirty = JSON.stringify(params) !== JSON.stringify(initialParams)

    function update<K extends keyof ParamMap>(k: K, v: string) {
        setParams(prev => ({ ...prev, [k]: v }))
    }

    async function handleSave() {
        if (!canEdit || !dirty || saving) return
        setSaving(true)
        setSaveMsg(null)
        try {
            const r = await fetch('/api/settings/telephony-connection', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ params }),
            })
            const body = await r.json()
            if (!r.ok) throw new Error(body.error ?? `status ${r.status}`)
            setParams(body.params ?? params)
            setInitialParams(body.params ?? params)
            const rescanOk = body.rescan?.ok !== false
            setSaveMsg({
                kind: 'ok',
                message: rescanOk
                    ? 'Сохранено и применено в FreeSWITCH'
                    : 'Сохранено, но не удалось перезагрузить FreeSWITCH: ' + (body.rescan?.error ?? ''),
            })
            setShowPassword(false)
            setTimeout(() => loadStatus(), 1500)  // give sofia a moment to re-register
        } catch (err: any) {
            setSaveMsg({ kind: 'error', message: err.message ?? 'ошибка сохранения' })
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6 animate-in fade-in duration-300">
            <TelephonyTabs active="connection" />

            {!canEdit && (
                <div className="flex items-center gap-[2px] rounded-md border border-border bg-surface px-3 py-[2px] text-[13px] text-muted-foreground">
                    <AlertCircle className="h-3.5 w-3.5" />
                    Только Администратор или Руководитель может редактировать настройки.
                </div>
            )}

            {/* ── Status ──────────────────────────────────────────────── */}
            <section className="flex flex-col gap-3 rounded-md border border-border bg-card p-5">
                <div className="flex items-center justify-between">
                    <div>
                        <div className="text-[15px] font-semibold text-foreground">Состояние</div>
                        <div className="text-[12px] text-muted-foreground">Обновляется каждые 15 секунд</div>
                    </div>
                    <button
                        onClick={loadStatus}
                        disabled={statusLoading}
                        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-[13px] text-muted-foreground hover:bg-surface hover:text-foreground disabled:opacity-60"
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${statusLoading ? 'animate-spin' : ''}`} />
                        Обновить
                    </button>
                </div>

                <div className="grid grid-cols-1 gap-[2px] md:grid-cols-2">
                    {!status && statusLoading && (
                        <div className="col-span-full text-center text-[13px] text-muted-foreground py-3">Загружаем статус…</div>
                    )}
                    {status && Object.entries(status.checks).map(([key, check]) => (
                        <div
                            key={key}
                            className={`flex items-center gap-3 rounded-md border px-3 py-2.5 ${
                                check.ok
                                    ? 'border-emerald-200 bg-emerald-50'
                                    : 'border-red-200 bg-red-50'
                            }`}
                        >
                            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white ${
                                check.ok ? 'bg-emerald-500' : 'bg-red-500'
                            }`}>
                                {check.ok ? <CheckCircle2 className="h-[4px] w-[4px]" /> : <AlertCircle className="h-[4px] w-[4px]" />}
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="text-[13px] font-medium text-foreground truncate">{check.label}</div>
                                <div className="text-[11px] text-muted-foreground truncate">{check.detail}</div>
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            {/* ── MultiFon credentials ────────────────────────────────── */}
            <section className="flex flex-col gap-[4px] rounded-md border border-border bg-card p-5">
                <div className="flex items-center justify-between">
                    <div>
                        <div className="text-[15px] font-semibold text-foreground">Подключение к МультиФон</div>
                        <div className="text-[12px] text-muted-foreground">
                            SIP-trunk Мегафона «МультиФон Бизнес». После сохранения FreeSWITCH автоматически
                            перезагрузит gateway.
                        </div>
                    </div>
                </div>

                {loading && (
                    <div className="flex items-center justify-center py-[8px]">
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                )}

                {!loading && error && (
                    <div className="flex items-start gap-[2px] rounded-md border border-destructive/30 bg-destructive/5 px-3 py-[2px] text-[13px] text-destructive">
                        <AlertCircle className="h-[4px] w-[4px] shrink-0 mt-0.5" />
                        <div className="min-w-0">
                            <div className="font-medium">{error}</div>
                            <div className="text-[11px] opacity-70 mt-1 font-mono">{confPath}</div>
                        </div>
                    </div>
                )}

                {!loading && !error && (
                    <>
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                            <FormField
                                label="Логин (номер trunk)"
                                hint="Номер из договора МультиФон Бизнес"
                                value={params.username ?? ''}
                                onChange={(v) => update('username', v)}
                                placeholder="79221853150"
                                disabled={!canEdit}
                            />
                            <FormField
                                label="Пароль"
                                hint="Пароль SIP-trunk из лк.мегафон.ру"
                                value={params.password ?? ''}
                                onChange={(v) => update('password', v)}
                                placeholder="••••••••"
                                disabled={!canEdit}
                                type={showPassword ? 'text' : 'password'}
                                trailing={
                                    <button
                                        type="button"
                                        onClick={() => {
                                            // First click — clear the masked placeholder so the
                                            // operator types a fresh password (we treat the
                                            // sentinel as "don't change" on the backend).
                                            if (params.password === MASKED) update('password', '')
                                            setShowPassword(v => !v)
                                        }}
                                        className="h-9 w-9 inline-flex items-center justify-center text-muted-foreground hover:text-foreground"
                                        title={showPassword ? 'Скрыть' : 'Показать'}
                                    >
                                        {showPassword ? <EyeOff className="h-[4px] w-[4px]" /> : <Eye className="h-[4px] w-[4px]" />}
                                    </button>
                                }
                            />
                            <FormField
                                label="Realm"
                                hint="SIP-realm для авторизации"
                                value={params.realm ?? ''}
                                onChange={(v) => update('realm', v)}
                                placeholder="multifon.ru"
                                disabled={!canEdit}
                            />
                            <FormField
                                label="Proxy / SBC"
                                hint="Адрес сервера МультиФон"
                                value={params.proxy ?? ''}
                                onChange={(v) => update('proxy', v)}
                                placeholder="sbc.megafon.ru"
                                disabled={!canEdit}
                            />
                            <FormField
                                label="From-user"
                                hint="Обычно совпадает с логином"
                                value={params['from-user'] ?? ''}
                                onChange={(v) => update('from-user', v)}
                                placeholder="79221853150"
                                disabled={!canEdit}
                            />
                            <FormField
                                label="From-domain"
                                hint="Обычно совпадает с realm"
                                value={params['from-domain'] ?? ''}
                                onChange={(v) => update('from-domain', v)}
                                placeholder="multifon.ru"
                                disabled={!canEdit}
                            />
                        </div>

                        <div className="flex items-start gap-[2px] rounded-md bg-surface px-3 py-[2px] text-[12px] text-muted-foreground">
                            <Info className="h-[4px] w-[4px] shrink-0 mt-0.5 text-primary" />
                            <div>
                                Файл конфигурации FreeSWITCH:{' '}
                                <span className="font-mono text-foreground">{confPath || '...'}</span>.
                                После сохранения выполняется <span className="font-mono">sofia profile external killgw megafon</span>{' '}
                                и <span className="font-mono">rescan</span> — gateway перерегистрируется в течение 5–10 секунд.
                            </div>
                        </div>
                    </>
                )}
            </section>

            {/* ── Future: manager extension passwords, WS URL etc. ────── */}
            <section className="flex flex-col gap-[2px] rounded-md border border-dashed border-border bg-surface/30 p-5">
                <div className="flex items-center gap-[2px] text-[13px] font-medium text-foreground">
                    <ExternalLink className="h-3.5 w-3.5" />
                    Технические параметры
                </div>
                <div className="text-[12px] text-muted-foreground">
                    Пароли расширений менеджеров (101/102), адрес WebRTC-сокета, ESL-host —
                    редактируются вручную через <span className="font-mono">.env</span>.
                    UI для них пока не реализован.
                </div>
            </section>

            {/* ── Save footer ─────────────────────────────────────────── */}
            <footer className="sticky bottom-[4px] z-10 flex items-center justify-between rounded-md border border-border bg-card px-[4px] py-3 shadow-sm">
                <div className="text-[12px] text-muted-foreground">
                    {saveMsg?.kind === 'ok' && (
                        <span className="inline-flex items-center gap-1 text-emerald-600">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            {saveMsg.message}
                        </span>
                    )}
                    {saveMsg?.kind === 'error' && (
                        <span className="inline-flex items-center gap-1 text-destructive">
                            <AlertCircle className="h-3.5 w-3.5" />
                            {saveMsg.message}
                        </span>
                    )}
                    {!saveMsg && !loading && dirty && (
                        <span className="text-amber-600">Есть несохранённые изменения</span>
                    )}
                </div>
                <button
                    type="button"
                    onClick={handleSave}
                    disabled={!canEdit || !dirty || saving || loading}
                    className="inline-flex h-11 items-center gap-[2px] rounded-md bg-primary px-5 text-[15px] font-semibold text-white transition-colors hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-60"
                >
                    {saving ? <Loader2 className="h-[4px] w-[4px] animate-spin" /> : <Save className="h-[4px] w-[4px]" />}
                    Сохранить и применить
                </button>
            </footer>
        </div>
    )
}

function FormField({
    label, hint, value, onChange, placeholder, disabled, type, trailing,
}: {
    label: string
    hint?: string
    value: string
    onChange: (v: string) => void
    placeholder?: string
    disabled?: boolean
    type?: string
    trailing?: React.ReactNode
}) {
    return (
        <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
            <span className="flex items-stretch rounded-md border border-border bg-background focus-within:border-primary transition-colors">
                <input
                    type={type ?? 'text'}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={placeholder}
                    disabled={disabled}
                    className="h-10 flex-1 bg-transparent px-3 text-[14px] outline-none disabled:opacity-60 font-mono"
                />
                {trailing}
            </span>
            {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
        </label>
    )
}
