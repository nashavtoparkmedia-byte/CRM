"use client"

import { useState } from 'react'
import Link from 'next/link'
import {
    BookOpen, User, Wrench, Sparkles, CheckCircle2, XCircle, HelpCircle,
    KeyRound, FolderTree, ToggleRight, AlertTriangle, ArrowRight, ListChecks,
} from 'lucide-react'

type Tab = 'manager' | 'admin'

export default function AiCallHelpClient() {
    const [tab, setTab] = useState<Tab>('manager')

    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6 animate-in fade-in duration-300">
            <header className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10">
                    <BookOpen className="h-5 w-5 text-primary" />
                </div>
                <div className="flex-1">
                    <h1 className="text-[20px] font-semibold leading-tight text-foreground">Инструкция по AI-обзвону</h1>
                    <p className="text-[13px] text-muted-foreground">
                        Черновая справка. Финальная документация появится позже, когда будет подключён живой голосовой ассистент.
                    </p>
                </div>
            </header>

            {/* Telegram-style segmented tabs */}
            <div className="inline-flex w-full rounded-md border border-border bg-surface p-1">
                <TabButton active={tab === 'manager'} onClick={() => setTab('manager')} icon={<User className="h-4 w-4" />} label="Для менеджера" />
                <TabButton active={tab === 'admin'} onClick={() => setTab('admin')} icon={<Wrench className="h-4 w-4" />} label="Для администратора" />
            </div>

            {tab === 'manager' ? <ManagerHelp /> : <AdminHelp />}
        </div>
    )
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`flex flex-1 items-center justify-center gap-2 rounded-md px-4 py-2 text-[14px] font-medium transition-colors ${
                active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
            }`}
        >
            {icon}
            {label}
        </button>
    )
}

function ManagerHelp() {
    return (
        <div className="flex flex-col gap-5">
            {/* Главный заголовок вкладки — соответствует «### 🤖 Как использовать
                AI-обзвон» из финального текста инструкции. Эмодзи оставлен как
                рендер текста (Unicode), без замены на иконку библиотеки. */}
            <div className="flex items-center gap-2.5 rounded-md border border-primary/15 bg-primary/5 px-4 py-3">
                <span aria-hidden className="text-[18px] leading-none">🤖</span>
                <h2 className="text-[15px] font-semibold text-foreground">Как использовать AI-обзвон</h2>
            </div>

            <Step number={1} title="Запустить AI-звонок">
                <ol className="ml-5 list-decimal space-y-1 text-[13px]">
                    <li>Открой раздел <b>«Водители»</b></li>
                    <li>Выбери нужного водителя и открой его карточку</li>
                    <li>Найди кнопку <b>«AI-звонок»</b></li>
                    <li>Нажми её</li>
                </ol>
                <p className="mt-3 text-[13px] text-muted-foreground">Готово — система сама сделает звонок и проанализирует разговор.</p>
            </Step>

            <Step number={2} title="Что произойдёт дальше">
                <p>После нажатия ты автоматически попадёшь на страницу звонка.</p>
                <p className="mt-2">Тебе ничего не нужно делать — звонок уже завершён, результат готов.</p>
            </Step>

            <Step number={3} title="Где посмотреть результат">
                <p>На странице звонка открой вкладку <b>«AI-анализ»</b>.</p>
                <p className="mt-2">Там ты увидишь:</p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <DashItem>итог (подходит или нет)</DashItem>
                    <DashItem>краткое резюме</DashItem>
                    <DashItem>причину решения</DashItem>
                    <DashItem>ответы лида на вопросы</DashItem>
                    <DashItem>задачу для тебя (если нужна)</DashItem>
                </ul>
            </Step>

            <Step number={4} title="Как понять — хороший лид или нет">
                <p>Система показывает один из трёх вариантов:</p>
                <ul className="mt-2 space-y-1.5 text-[13px]">
                    <li className="flex items-start gap-2">
                        <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-accent" />
                        <span><b>Квалифицирован</b> — лид подходит → нужно связаться</span>
                    </li>
                    <li className="flex items-start gap-2">
                        <XCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
                        <span><b>Не подходит</b> — лид нецелевой → ничего делать не нужно</span>
                    </li>
                    <li className="flex items-start gap-2">
                        <HelpCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
                        <span><b>Нужно уточнить</b> — не хватает данных → нужно позвонить вручную</span>
                    </li>
                </ul>
            </Step>

            <Step number={5} title="Что делать дальше">
                <ul className="space-y-1 text-[13px]">
                    <DashItem>Если <b>есть задача</b> → открой её и выполни</DashItem>
                    <DashItem>Если <b>лид подходит</b> → свяжись с ним</DashItem>
                    <DashItem>Если <b>не подходит</b> → переходи к следующему</DashItem>
                </ul>
            </Step>

            <Step number={6} title="Где найти звонок позже">
                <p>Открой <b>карточку водителя</b> → вкладка <b>«Звонки»</b>.</p>
                <p className="mt-2 inline-flex flex-wrap items-center gap-1.5">
                    AI-звонки отмечены значком
                    <Tag><Sparkles className="h-3 w-3" />ИИ</Tag>
                </p>
            </Step>

            <div className="rounded-md border border-border bg-surface/40 px-4 py-3 text-[13px] text-muted-foreground">
                Если кнопки <b>«AI-звонок»</b> нет — обратись к администратору.
            </div>
        </div>
    )
}

function DashItem({ children }: { children: React.ReactNode }) {
    return (
        <li className="flex gap-2">
            <span aria-hidden className="text-muted-foreground">—</span>
            <span>{children}</span>
        </li>
    )
}

function AdminHelp() {
    return (
        <div className="flex flex-col gap-5">
            <Step number={1} title="Настроить API ключи">
                <p>Перейдите в <Link href="/settings/integrations/ai-call-keys" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"><KeyRound className="h-3.5 w-3.5" />API ключи AI-обзвона<ArrowRight className="h-3 w-3" /></Link>. Что нужно:</p>
                <ul className="mt-2 ml-5 list-disc space-y-1 text-[13px]">
                    <li><code className="rounded bg-surface px-1 py-0.5 text-[12px] border border-border">OPENAI_API_KEY</code> — для LLM-диалога (когда подключим)</li>
                    <li><code className="rounded bg-surface px-1 py-0.5 text-[12px] border border-border">YANDEX_API_KEY</code> + <code className="rounded bg-surface px-1 py-0.5 text-[12px] border border-border">YANDEX_FOLDER_ID</code> — для распознавания речи (Yandex SpeechKit)</li>
                </ul>
                <p className="mt-2 text-[12px] text-muted-foreground">Секреты хранятся только в файле <code>gravity-mvp/.env</code>. UI показывает статус и последние 4 символа — для смены ключа правьте .env и перезапускайте dev-сервер.</p>
            </Step>

            <Step number={2} title="Настроить проекты">
                <p>Перейдите в <Link href="/settings/integrations/ai-call-scenarios" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"><FolderTree className="h-3.5 w-3.5" />Проекты и сценарии<ArrowRight className="h-3 w-3" /></Link>. По умолчанию 3 проекта:</p>
                <ul className="mt-2 ml-5 list-disc space-y-1 text-[13px]">
                    <li><b>Квалификация лида</b> — обзвон новых заявок</li>
                    <li><b>Работа с оттоком</b> — возврат водителей, которые перестали брать заказы</li>
                    <li><b>Опрос качества</b> — NPS-опрос среди активной базы</li>
                </ul>
                <p className="mt-2 text-[12px] text-muted-foreground">Сейчас новые проекты создаются разработчиком через миграцию — UI добавления проектов появится в одной из следующих фаз.</p>
            </Step>

            <Step number={3} title="Настроить сценарии">
                <p>В том же разделе <Link href="/settings/integrations/ai-call-scenarios" className="text-primary underline-offset-2 hover:underline">«Проекты и сценарии»</Link> внутри каждого проекта — кнопка <Tag>+ Сценарий</Tag>. Поля сценария:</p>
                <ul className="mt-2 ml-5 list-disc space-y-1 text-[13px]">
                    <li><b>Название</b> — что увидит менеджер в выпадающем списке</li>
                    <li><b>Системный промт</b> — роль ассистента, тон, обработка возражений (он же отправится в LLM целиком)</li>
                    <li><b>Вопросы по порядку</b> — обычно 3–5 чётких вопросов для квалификации</li>
                    <li><b>Целевая длительность</b> — подсказка темпа модели, обычно 120 секунд</li>
                </ul>
                <p className="mt-2 text-[12px] text-muted-foreground">Удаление — это soft-delete: сценарий просто перестаёт показываться менеджерам, история звонков по нему не теряется.</p>
            </Step>

            <Step number={4} title="Как включить mock-режим">
                <p>В <code>gravity-mvp/.env</code> добавьте строку:</p>
                <pre className="mt-2 rounded-md border border-border bg-surface p-3 font-mono text-[12px] text-foreground">AI_CALL_MOCK_MODE=true</pre>
                <p className="mt-2 text-[13px]">Перезапустите dev-сервер (<code className="rounded bg-surface px-1 py-0.5 text-[12px] border border-border">npm run dev</code>). На странице <Link href="/settings/integrations/ai-call-keys" className="text-primary underline-offset-2 hover:underline">API ключи</Link> карточка «Mock-режим» должна показать <Tag color="accent"><ToggleRight className="h-3 w-3" />включён</Tag>.</p>
                <p className="mt-2 text-[12px] text-muted-foreground">В этом режиме кнопка «AI-звонок (mock)» создаёт фейковую запись Call(isAi=true) с готовым транскриптом — это безопасно тестировать без OpenAI/Yandex.</p>
            </Step>

            <Step number={5} title="Что делать, если AI-звонок не создаётся" icon={<AlertTriangle className="h-4 w-4 text-destructive" />}>
                <ul className="ml-5 list-decimal space-y-2 text-[13px]">
                    <li>
                        <b>Кнопка «AI-звонок (mock)» отдаёт ошибку «Mock-режим выключен»</b> — добавьте <code className="rounded bg-surface px-1 py-0.5 text-[12px] border border-border">AI_CALL_MOCK_MODE=true</code> в <code>.env</code> и перезапустите dev-сервер.
                    </li>
                    <li>
                        <b>Кнопки вообще нет в карточке</b> — карточка открыта без <code>driverId</code>/<code>contactId</code>. Откройте карточку из списка водителей или лидов, чтобы у компонента были данные.
                    </li>
                    <li>
                        <b>Звонок создаётся, но <code>/calls/&lt;id&gt;</code> 404</b> — проверьте, что миграции применены: <code className="rounded bg-surface px-1 py-0.5 text-[12px] border border-border">npx prisma migrate deploy</code>, потом <code className="rounded bg-surface px-1 py-0.5 text-[12px] border border-border">npx prisma generate</code>. После этого перезапустите dev-сервер.
                    </li>
                    <li>
                        <b>Список сценариев пустой</b> — на первом просмотре страницы «Проекты и сценарии» CRM сам создаёт дефолтный сценарий «Квалификация водителя (по умолчанию)» в проекте «Квалификация лида». Если этого не произошло — проверьте подключение к БД и логи dev-сервера.
                    </li>
                    <li>
                        <b>На карточке звонка нет блока AI-анализа</b> — это значит, что у записи Call нет <code>isAi=true</code>. Откройте звонок, созданный именно кнопкой «AI-звонок (mock)», обычные звонки таким бейджем не помечаются.
                    </li>
                </ul>
            </Step>

            <section className="rounded-md border border-border bg-surface/40 p-5">
                <h2 className="mb-2 flex items-center gap-2 text-[15px] font-semibold text-foreground">
                    <ListChecks className="h-4 w-4 text-primary" />
                    Что НЕ работает в этой версии (Day 1)
                </h2>
                <ul className="ml-5 list-disc space-y-1 text-[13px] text-foreground leading-relaxed">
                    <li>Живой голосовой обзвон — ключи Yandex/OpenAI можно настроить, но провайдеры ещё не подключены к dial-флоу. Сейчас работает только mock-режим.</li>
                    <li>Аудио-запись AI-звонков (для mock-звонков записи нет; для живого — будет позже)</li>
                    <li>Перевод на менеджера через SIP REFER (запланирован)</li>
                    <li>Большой аналитический дашборд (метрики копятся в <code>Call.metadata</code>, но визуализации пока нет)</li>
                </ul>
            </section>
        </div>
    )
}

function Step({
    number,
    title,
    children,
    icon,
}: {
    number?: number
    title: string
    children: React.ReactNode
    icon?: React.ReactNode
}) {
    return (
        <section className="rounded-md border border-border bg-card p-5">
            <div className="mb-3 flex items-center gap-3">
                {number !== undefined && (
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-[13px] font-semibold text-primary">
                        {number}
                    </span>
                )}
                {icon}
                <h2 className="text-[16px] font-semibold text-foreground">{title}</h2>
            </div>
            <div className="text-[13px] text-foreground leading-relaxed">{children}</div>
        </section>
    )
}

function Tag({ children, color }: { children: React.ReactNode; color?: 'primary' | 'accent' }) {
    const cls =
        color === 'primary'
            ? 'bg-primary/10 text-primary'
            : color === 'accent'
              ? 'bg-accent/10 text-accent'
              : 'bg-surface text-foreground border border-border'
    return (
        <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>
            {children}
        </span>
    )
}
