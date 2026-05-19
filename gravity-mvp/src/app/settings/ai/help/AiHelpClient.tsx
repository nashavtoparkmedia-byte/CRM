"use client"

import { useState } from 'react'
import Link from 'next/link'
import {
    Bot, User, Wrench, MessageSquare, ThumbsUp, ThumbsDown, AlertTriangle,
    KeyRound, Settings, BookOpen, RefreshCw, Power, Search, ArrowRight,
} from 'lucide-react'

type Tab = 'manager' | 'admin'

export default function AiHelpClient() {
    const [tab, setTab] = useState<Tab>('manager')

    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6 animate-in fade-in duration-300">
            <header className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-violet-100/60 text-violet-600">
                    <Bot className="h-5 w-5" />
                </div>
                <div className="flex-1">
                    <h1 className="text-[20px] font-semibold leading-tight text-foreground">Инструкция по AI-агенту</h1>
                    <p className="text-[13px] text-muted-foreground">
                        Справочник. Подробности по шагам — ниже.
                    </p>
                </div>
            </header>

            {/* Telegram-style segmented tabs */}
            <div className="inline-flex w-full rounded-md border border-border bg-surface p-1">
                <TabButton active={tab === 'manager'} onClick={() => setTab('manager')} icon={<User className="h-4 w-4" />} label="Для менеджера" />
                <TabButton active={tab === 'admin'}   onClick={() => setTab('admin')}   icon={<Wrench className="h-4 w-4" />} label="Для администратора" />
            </div>

            <QuickNav tab={tab} />

            {tab === 'manager' ? <ManagerHelp /> : <AdminHelp />}
        </div>
    )
}

const MANAGER_ANCHORS: Array<{ id: string; label: string }> = [
    { id: 'm-help',     label: 'Как AI помогает' },
    { id: 'm-handoff',  label: 'Когда AI передаст диалог' },
    { id: 'm-mistake',  label: 'Если AI ответил неправильно' },
    { id: 'm-where',    label: 'Где смотреть решения' },
    { id: 'm-feedback', label: 'Поставить 👍 / 👎' },
]

const ADMIN_ANCHORS: Array<{ id: string; label: string }> = [
    { id: 'a-overview', label: 'Что настраивается' },
    { id: 'a-provider', label: 'Провайдер' },
    { id: 'a-rules',    label: 'Правила' },
    { id: 'a-kb',       label: 'База знаний' },
    { id: 'a-sync',     label: 'Синхронизация' },
    { id: 'a-enable',   label: 'Включить' },
    { id: 'a-trouble',  label: 'Если не работает' },
]

function QuickNav({ tab }: { tab: Tab }) {
    const anchors = tab === 'manager' ? MANAGER_ANCHORS : ADMIN_ANCHORS
    return (
        <nav className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-surface/40 px-3 py-2 text-[12px]">
            <span className="text-muted-foreground">Перейти к:</span>
            {anchors.map(a => (
                <a key={a.id} href={`#${a.id}`} className="text-primary underline-offset-2 hover:underline">
                    {a.label}
                </a>
            ))}
            <span className="ml-auto inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                Открыть:
                <Link href="/settings/ai" className="text-primary underline-offset-2 hover:underline">
                    AI Control Center
                </Link>
            </span>
        </nav>
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
            <div className="flex items-center gap-2.5 rounded-md border border-primary/15 bg-primary/5 px-4 py-3">
                <span aria-hidden className="text-[18px] leading-none">🤖</span>
                <h2 className="text-[15px] font-semibold text-foreground">AI-агент в чатах MAX / Telegram / WhatsApp</h2>
            </div>

            <Step number={1} id="m-help" title="Как AI помогает в чатах" icon={<MessageSquare className="h-4 w-4 text-primary" />}>
                <p>AI читает входящие сообщения от водителей и отвечает на типовые вопросы автоматически — пока вы заняты другими диалогами.</p>
                <p className="mt-2">Над сообщением, которое отправил AI, в общем потоке стоит маленькая отметка — так понятно, что это не вы.</p>
            </Step>

            <Step number={2} id="m-handoff" title="Когда AI передаст диалог вам">
                <p>AI не отвечает сам и оставляет диалог менеджеру в трёх случаях:</p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <DashItem>не уверен в ответе (низкая «уверенность» в журнале)</DashItem>
                    <DashItem>видит жалобу или конфликт</DashItem>
                    <DashItem>уже отправил подряд несколько автоответов в этом чате — защита от «робот разговаривает с роботом»</DashItem>
                </ul>
                <p className="mt-2 text-[12px] text-muted-foreground">Конкретные пороги задаёт администратор на вкладке «Правила».</p>
            </Step>

            <Step number={3} id="m-mistake" title="Если AI ответил неправильно" icon={<AlertTriangle className="h-4 w-4 text-amber-600" />}>
                <ol className="ml-5 list-decimal space-y-1 text-[13px]">
                    <li>Напишите водителю правильный ответ обычным сообщением — поверх ответа AI.</li>
                    <li>Откройте <b>Журнал</b> в AI Control Center и поставьте 👎 на этом решении.</li>
                    <li>Расскажите администратору, какой ответ был неправильным — он поправит правила или базу знаний.</li>
                </ol>
            </Step>

            <Step number={4} id="m-where" title="Где посмотреть решения AI" icon={<Search className="h-4 w-4 text-primary" />}>
                <p>Раздел <Link href="/settings/ai" className="text-primary underline-offset-2 hover:underline">AI Control Center</Link> → вкладка <b>Журнал</b>.</p>
                <p className="mt-2">В журнале видно по каждому ответу:</p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <DashItem>откуда сообщение (MAX / TG / WA)</DashItem>
                    <DashItem>что решил AI (Автоответ / Эскалация)</DashItem>
                    <DashItem>текст ответа</DashItem>
                    <DashItem>уверенность в процентах — насколько AI был уверен</DashItem>
                </ul>
                <p className="mt-2 text-[12px] text-muted-foreground">Сверху — фильтры по каналу и решению. Используйте их, чтобы найти конкретный случай.</p>
            </Step>

            <Step number={5} id="m-feedback" title="Как поставить 👍 / 👎" icon={<ThumbsUp className="h-4 w-4 text-accent" />}>
                <p>На каждой записи в Журнале есть две кнопки. Они помогают админу понять, где AI работает, а где нужно поправить.</p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <li className="flex items-start gap-2">
                        <ThumbsUp className="mt-0.5 h-4 w-4 flex-shrink-0 text-accent" />
                        <span><b>Хорошо</b> — AI ответил правильно, можно ничего не менять</span>
                    </li>
                    <li className="flex items-start gap-2">
                        <ThumbsDown className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
                        <span><b>Плохо</b> — ответ неуместен, неточен или вреден</span>
                    </li>
                </ul>
                <p className="mt-2 text-[12px] text-muted-foreground">Оценка обратима — нажмите вторую кнопку, если ошиблись.</p>
            </Step>
        </div>
    )
}

function AdminHelp() {
    return (
        <div className="flex flex-col gap-5">
            <div className="flex items-center gap-2.5 rounded-md border border-primary/15 bg-primary/5 px-4 py-3">
                <span aria-hidden className="text-[18px] leading-none">⚙️</span>
                <h2 className="text-[15px] font-semibold text-foreground">Настройка AI-агента</h2>
            </div>

            <Step number={1} id="a-overview" title="Что настраивается в AI Control Center">
                <p>Это <b>не AI-обзвон</b> (тот — в <Link href="/settings/integrations/ai-call-scenarios" className="text-primary underline-offset-2 hover:underline">отдельном разделе</Link>). Здесь — AI-агент, который отвечает в текстовых чатах MAX / Telegram / WhatsApp.</p>
                <p className="mt-2">Пять вкладок:</p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <DashItem><b>Синхронизация</b> — загрузка истории чатов в базу</DashItem>
                    <DashItem><b>AI Провайдер</b> — Anthropic / OpenAI, ключ, модели</DashItem>
                    <DashItem><b>Правила</b> — режим работы, пороги, промпт</DashItem>
                    <DashItem><b>База знаний</b> — точные ответы для AI</DashItem>
                    <DashItem><b>Журнал</b> — что и как ответил AI</DashItem>
                </ul>
            </Step>

            <Step number={2} id="a-provider" title="Шаг 1. Настройка провайдера" icon={<KeyRound className="h-4 w-4 text-primary" />}>
                <p>Откройте <b>AI Провайдер</b> и выполните по порядку:</p>
                <ol className="mt-1.5 ml-5 list-decimal space-y-1 text-[13px]">
                    <li>Выберите провайдера: <b>Anthropic</b> (лучше понимает русский) или <b>OpenAI</b> (дешевле и быстрее на коротких ответах).</li>
                    <li>Получите ключ — ссылка «где взять» рядом с полем.</li>
                    <li>Вставьте ключ и нажмите <Tag>Проверить</Tag>. Дождитесь зелёной галочки.</li>
                    <li>Нажмите <Tag>Сохранить</Tag>.</li>
                </ol>
                <p className="mt-2 text-[12px] text-muted-foreground">Имена моделей внутри «Дополнительно» обычно менять не нужно — дефолты подходят. Они подменяются автоматически при переключении провайдера.</p>
            </Step>

            <Step number={3} id="a-rules" title="Шаг 2. Правила" icon={<Settings className="h-4 w-4 text-primary" />}>
                <p>Откройте <b>Правила</b> и задайте безопасный старт:</p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <DashItem>Режим: <b>«Советует»</b> — AI пишет ответ в подсказку, отправляет менеджер. Безопасный старт.</DashItem>
                    <DashItem>Каналы: включите те мессенджеры, где готовы пускать AI.</DashItem>
                    <DashItem>Уверенность для автоответа: <b>0.75</b> — рекомендуемое значение. Чем выше, тем реже AI отвечает сам.</DashItem>
                    <DashItem>Макс. автоответов подряд: <b>5</b> — защита от диалога робота с роботом.</DashItem>
                </ul>
                <p className="mt-3">Заполните 4 блока промпта:</p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <DashItem><b>Роль</b> — кто отвечает (должность, компания)</DashItem>
                    <DashItem><b>Тон</b> — как разговаривать</DashItem>
                    <DashItem><b>Разрешено</b> — что AI может делать без согласования</DashItem>
                    <DashItem><b>Запрещено</b> — обещания, оценки, домыслы</DashItem>
                </ul>
                <p className="mt-2 text-[12px] text-muted-foreground">Можно оставить пустым — будут значения по умолчанию.</p>
            </Step>

            <Step number={4} id="a-kb" title="Шаг 3. База знаний" icon={<BookOpen className="h-4 w-4 text-primary" />}>
                <p>До запуска добавьте <b>3–5 базовых FAQ</b>. Без них AI будет «фантазировать» по контексту:</p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <DashItem>условия работы (комиссия, выплаты)</DashItem>
                    <DashItem>адрес офиса и график</DashItem>
                    <DashItem>как получить справку / документы</DashItem>
                </ul>
                <p className="mt-3">Структура записи:</p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <DashItem><b>Заголовок</b> — короткое имя</DashItem>
                    <DashItem><b>Категория</b> — для группировки (general, payments, docs…)</DashItem>
                    <DashItem><b>Примеры вопросов</b> — как водитель может спросить</DashItem>
                    <DashItem><b>Ответ</b> — точный текст, который должен выдать AI</DashItem>
                </ul>
                <p className="mt-2 text-[12px] text-muted-foreground">Теги и приоритет — в свёрнутом блоке «Дополнительно». На старте не нужны.</p>
            </Step>

            <Step number={5} id="a-sync" title="Шаг 4. Синхронизация истории" icon={<RefreshCw className="h-4 w-4 text-primary" />}>
                <p>На вкладке <b>Синхронизация</b> загрузите историю чатов — AI будет понимать контекст диалогов.</p>
                <ol className="mt-1.5 ml-5 list-decimal space-y-1 text-[13px]">
                    <li>Выберите каналы (MAX / TG / WA).</li>
                    <li>Режим: <b>«За последние N дней»</b>, 7 — достаточно для прогрева.</li>
                    <li>Нажмите <Tag>Запустить импорт</Tag>.</li>
                </ol>
                <p className="mt-2 text-[12px] text-muted-foreground">MAX-импорт требует, чтобы был запущен <b>MAX Web Scraper</b> (иконка в трее или <code className="rounded bg-surface px-1 py-0.5 text-[12px] border border-border">start-all.bat</code> в корне проекта). Если статус «Сервис не запущен» — включите его и нажмите «Повторить проверку».</p>
            </Step>

            <Step number={6} id="a-enable" title="Шаг 5. Включить AI" icon={<Power className="h-4 w-4 text-accent" />}>
                <p>В шапке страницы — кнопка <Tag color="accent">Включить</Tag>. Нажмите её, когда:</p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <DashItem>провайдер подключён и проверен</DashItem>
                    <DashItem>выбран режим («Советует» для старта)</DashItem>
                    <DashItem>в каналах есть хотя бы один мессенджер</DashItem>
                    <DashItem>в базе знаний есть базовые ответы</DashItem>
                </ul>
                <p className="mt-2 text-[12px] text-muted-foreground">Первые сутки заходите в Журнал каждые 2 часа, ставьте 👍 / 👎. Если 👍 преобладает — переключайтесь на «Автоответ».</p>
            </Step>

            <Step number={7} id="a-trouble" title="Если AI не отвечает" icon={<AlertTriangle className="h-4 w-4 text-destructive" />}>
                <p><b>AI выключен</b> — в шапке серый индикатор. Нажмите «Включить».</p>
                <p className="mt-2"><b>Ключ не подключён</b> — в Журнале появятся ошибки. Откройте <b>AI Провайдер</b>, нажмите «Проверить» ещё раз.</p>
                <p className="mt-2"><b>Каналы не выбраны</b> — в Правилах ни один из MAX / TG / WA не подсвечен синим.</p>
                <p className="mt-2"><b>Порог слишком высокий</b> — AI всегда передаёт диалог менеджеру. Уменьшите «Уверенность для автоответа» в Правилах.</p>
                <p className="mt-2"><b>Импорт упирается в «Сервис не запущен»</b> — включите MAX Web Scraper в трее или через <code className="rounded bg-surface px-1 py-0.5 text-[12px] border border-border">start-all.bat</code>.</p>
            </Step>
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

function Step({
    number,
    title,
    children,
    icon,
    id,
}: {
    number?: number
    title: string
    children: React.ReactNode
    icon?: React.ReactNode
    id?: string
}) {
    return (
        <section id={id} className="scroll-mt-20 rounded-md border border-border bg-card p-5">
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
