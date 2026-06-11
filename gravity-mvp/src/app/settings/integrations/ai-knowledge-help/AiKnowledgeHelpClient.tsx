"use client"

import { useState } from 'react'
import Link from 'next/link'
import {
    BookOpen, User, Wrench, MessageSquare, ThumbsUp, ThumbsDown, AlertTriangle,
    Brain, Search, Shield, GitMerge, History, FileBox, Power, Layers,
    ArrowLeft,
} from 'lucide-react'

type Tab = 'manager' | 'admin'

export default function AiKnowledgeHelpClient() {
    const [tab, setTab] = useState<Tab>('manager')

    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6 animate-in fade-in duration-300">
            <Link
                href="/settings/integrations/ai-call-help"
                className="inline-flex w-fit items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground transition-colors"
            >
                <ArrowLeft className="h-3.5 w-3.5" />
                К списку инструкций
            </Link>
            <header className="flex items-center gap-3 -mt-[2px]">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-violet-100/60 text-violet-600">
                    <Brain className="h-5 w-5" />
                </div>
                <div className="flex-1">
                    <h1 className="text-[20px] font-semibold leading-tight text-foreground">Инструкция по Ядру знаний AI</h1>
                    <p className="text-[13px] text-muted-foreground">
                        Структурированная память AI: что использует, как объясняет, как пополнить.
                    </p>
                </div>
            </header>

            <div className="inline-flex w-full rounded-md border border-border bg-surface p-1">
                <TabButton active={tab === 'manager'} onClick={() => setTab('manager')} icon={<User className="h-[4px] w-[4px]" />} label="Для менеджера" />
                <TabButton active={tab === 'admin'}   onClick={() => setTab('admin')}   icon={<Wrench className="h-[4px] w-[4px]" />} label="Для администратора" />
            </div>

            <QuickNav tab={tab} />

            {tab === 'manager' ? <ManagerHelp /> : <AdminHelp />}
        </div>
    )
}

const MANAGER_ANCHORS: Array<{ id: string; label: string }> = [
    { id: 'm-what',     label: 'Что такое ядро' },
    { id: 'm-handoff',  label: 'Почему AI передаёт' },
    { id: 'm-why',      label: 'Кнопка «Почему так?»' },
    { id: 'm-feedback', label: '👍 / 👎' },
    { id: 'm-mistake',  label: 'Если AI ошибся' },
]

const ADMIN_ANCHORS: Array<{ id: string; label: string }> = [
    { id: 'a-overview',  label: 'Ядро vs База знаний' },
    { id: 'a-import',    label: 'Импорт переписок' },
    { id: 'a-extract',   label: 'Сбор ядра' },
    { id: 'a-explain',   label: 'Explainability' },
    { id: 'a-verified',  label: 'Verified' },
    { id: 'a-conflict',  label: 'Конфликты' },
    { id: 'a-supersede', label: 'Superseded' },
    { id: 'a-shadow',    label: 'Shadow mode' },
    { id: 'a-runtime',   label: 'Runtime mode' },
    { id: 'a-trouble',   label: 'Если не работает' },
]

function QuickNav({ tab }: { tab: Tab }) {
    const anchors = tab === 'manager' ? MANAGER_ANCHORS : ADMIN_ANCHORS
    return (
        <nav className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-surface/40 px-3 py-[2px] text-[12px]">
            <span className="text-muted-foreground">Перейти к:</span>
            {anchors.map(a => (
                <a key={a.id} href={`#${a.id}`} className="text-primary underline-offset-2 hover:underline">
                    {a.label}
                </a>
            ))}
            <span className="ml-auto inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                Открыть:
                <Link href="/settings/ai" className="text-primary underline-offset-2 hover:underline">
                    AI в чатах
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
            className={`flex flex-1 items-center justify-center gap-[2px] rounded-md px-[4px] py-[2px] text-[14px] font-medium transition-colors ${
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
            <div className="flex items-center gap-2.5 rounded-md border border-primary/15 bg-primary/5 px-[4px] py-3">
                <span aria-hidden className="text-[18px] leading-none">🧠</span>
                <h2 className="text-[15px] font-semibold text-foreground">Как AI пользуется ядром знаний</h2>
            </div>

            <Step number={1} id="m-what" title="Что такое Ядро знаний" icon={<Brain className="h-[4px] w-[4px] text-primary" />}>
                <p>Это память AI о компании. В ней хранятся факты: тарифы, требования к водителям, расписание, документы и частые ответы.</p>
                <p className="mt-[2px]">AI отвечает водителю строго фактами из ядра — он не «придумывает» цифры и не обещает того, чего там нет.</p>
            </Step>

            <Step number={2} id="m-handoff" title="Почему AI иногда передаёт диалог тебе">
                <p>AI оставляет диалог менеджеру, когда:</p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <DashItem>в ядре нет точного ответа на вопрос</DashItem>
                    <DashItem>факты противоречат друг другу — нужно человеческое решение</DashItem>
                    <DashItem>тема требует менеджера (жалоба, исключение, нестандарт)</DashItem>
                </ul>
                <p className="mt-[2px] text-[12px] text-muted-foreground">Это не «AI сломался» — это норма. Лучше пусть передаст, чем выдаст неточность.</p>
            </Step>

            <Step number={3} id="m-why" title="Кнопка «Почему AI так ответил?»" icon={<Search className="h-[4px] w-[4px] text-primary" />}>
                <p>В разделе <Link href="/settings/ai" className="text-primary underline-offset-2 hover:underline">AI в чатах</Link> → вкладка <b>Журнал</b>. На каждом решении AI есть кнопка <Tag>Почему AI так ответил?</Tag></p>
                <p className="mt-[2px]">Откроется модал. Видно:</p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <DashItem>вопрос водителя и ответ AI</DashItem>
                    <DashItem>какие знания из ядра AI использовал</DashItem>
                    <DashItem>что AI сознательно пропустил и почему (например: «требует менеджера»)</DashItem>
                    <DashItem>было ли что-то отредактировано в ядре уже после этого ответа</DashItem>
                </ul>
                <p className="mt-[2px] text-[12px] text-muted-foreground">Эта кнопка — главное, что у тебя есть, когда хочется понять «как AI до этого дошёл».</p>
            </Step>

            <Step number={4} id="m-feedback" title="Как ставить 👍 / 👎" icon={<ThumbsUp className="h-[4px] w-[4px] text-accent" />}>
                <p>На каждом решении в Журнале:</p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <li className="flex items-start gap-[2px]">
                        <ThumbsUp className="mt-0.5 h-[4px] w-[4px] flex-shrink-0 text-accent" />
                        <span><b>Хорошо</b> — AI ответил правильно</span>
                    </li>
                    <li className="flex items-start gap-[2px]">
                        <ThumbsDown className="mt-0.5 h-[4px] w-[4px] flex-shrink-0 text-destructive" />
                        <span><b>Плохо</b> — ответ неточен, неуместен или вреден</span>
                    </li>
                </ul>
                <p className="mt-[2px] text-[12px] text-muted-foreground">Оценка обратима — нажми вторую кнопку, если ошибся. По 👎-оценкам админ потом подправляет ядро.</p>
            </Step>

            <Step number={5} id="m-mistake" title="Если AI ответил неправильно" icon={<AlertTriangle className="h-[4px] w-[4px] text-amber-600" />}>
                <ol className="ml-5 list-decimal space-y-1 text-[13px]">
                    <li>Напиши водителю правильный ответ обычным сообщением — поверх ответа AI.</li>
                    <li>Открой Журнал, нажми <Tag>Почему AI так ответил?</Tag> и поставь 👎.</li>
                    <li>Если ошибка стоит того — расскажи администратору. Он или поправит конкретный факт в ядре, или подтвердит правильную версию.</li>
                </ol>
            </Step>

            <div className="rounded-md border border-border bg-surface/40 px-[4px] py-3 text-[13px] text-muted-foreground">
                Если AI вообще не отвечает или странно себя ведёт — обратись к администратору.
            </div>
        </div>
    )
}

function AdminHelp() {
    return (
        <div className="flex flex-col gap-5">
            <div className="flex items-center gap-2.5 rounded-md border border-primary/15 bg-primary/5 px-[4px] py-3">
                <span aria-hidden className="text-[18px] leading-none">⚙️</span>
                <h2 className="text-[15px] font-semibold text-foreground">Операционная инструкция</h2>
            </div>

            <Step number={1} id="a-overview" title="Ядро знаний vs База знаний" icon={<Layers className="h-[4px] w-[4px] text-primary" />}>
                <p>Это <b>не</b> старая «База знаний» (вкладка КБ). Старая КБ — ручные FAQ-карточки, которые админ пишет с нуля.</p>
                <p className="mt-[2px]"><b>Ядро знаний</b> — это извлечённая память AI: факты добываются автоматически из реальных переписок менеджеров с водителями. Алгоритм читает сотни диалогов и выделяет повторяющиеся утверждения с подтверждением минимум от двух менеджеров.</p>
                <p className="mt-[2px] text-[12px] text-muted-foreground">Старая КБ остаётся доступной (legacy) — её можно перенести в ядро отдельным действием.</p>
            </Step>

            <Step number={2} id="a-import" title="Шаг 1. Импорт переписок" icon={<History className="h-[4px] w-[4px] text-primary" />}>
                <p>На вкладке <b>Синхронизация</b> загрузите историю чатов из MAX / Telegram / WhatsApp. Без переписок ядро не из чего собирать.</p>
                <ol className="mt-1.5 ml-5 list-decimal space-y-1 text-[13px]">
                    <li>Выберите каналы.</li>
                    <li>Режим: «За последние N дней», 30–90 дней — хороший старт.</li>
                    <li>Запустите импорт и дождитесь завершения.</li>
                </ol>
            </Step>

            <Step number={3} id="a-extract" title="Шаг 2. Сбор ядра" icon={<Brain className="h-[4px] w-[4px] text-primary" />}>
                <p>На вкладке <b>Ядро знаний</b> нажмите <Tag>Собрать ядро</Tag>. AI прочитает импортированные переписки и извлечёт повторяющиеся факты.</p>
                <p className="mt-[2px]">Выберите пресет качества:</p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <DashItem><b>Экономичная</b> — для быстрого первого прогона</DashItem>
                    <DashItem><b>Сбалансированная</b> (рекомендуется) — баланс качества и стоимости</DashItem>
                    <DashItem><b>Повышенное качество</b> — самая дорогая, для тонкой доводки</DashItem>
                </ul>
                <p className="mt-[2px] text-[12px] text-muted-foreground">Первый сбор занимает 5–20 минут. Затем — повторно после новых переписок или при доводке.</p>
            </Step>

            <Step number={4} id="a-explain" title="Шаг 3. Как читать «Почему AI так ответил?»" icon={<Search className="h-[4px] w-[4px] text-primary" />}>
                <p>В Журнале на каждом решении есть кнопка <Tag>Почему AI так ответил?</Tag>. Это главный инструмент для оценки и доводки.</p>
                <p className="mt-[2px]">В модале вы видите:</p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <DashItem><b>Вопрос и ответ</b> — что спросил водитель и что ответил AI</DashItem>
                    <DashItem><b>Использованные знания</b> — какие факты ядра вошли в ответ, со scores</DashItem>
                    <DashItem><b>Сознательно пропущенные</b> — что AI исключил и почему (конфликт / requires_human / низкая уверенность)</DashItem>
                    <DashItem><b>Источники</b> — фрагменты реальных переписок, откуда факт извлечён (только Admin)</DashItem>
                    <DashItem><b>Audit-таймлайн</b> — что менялось в ядре уже после этого ответа</DashItem>
                    <DashItem><b>Retry preview</b> — повторный прогон с текущим состоянием ядра, чтобы увидеть «как бы AI ответил сейчас»</DashItem>
                </ul>
            </Step>

            <Step number={5} id="a-verified" title="Verified — подтверждённые факты" icon={<Shield className="h-[4px] w-[4px] text-accent" />}>
                <p>На карточке знания есть отметка <b>Подтверждено</b> и кнопка для её установки/снятия.</p>
                <p className="mt-[2px]">«Подтверждено» означает: админ лично проверил факт и ручается за точность. На таких знаниях AI делает больший упор в ответе и упоминает их с пометкой <b>[подтверждено]</b>.</p>
                <p className="mt-[2px] text-[12px] text-muted-foreground">Перед включением runtime критически важно подтвердить хотя бы базовые факты (тарифы, требования, условия выплат). Считайте, что только подтверждённые знания готовы к продакшну.</p>
            </Step>

            <Step number={6} id="a-conflict" title="Конфликты — два факта спорят друг с другом" icon={<AlertTriangle className="h-[4px] w-[4px] text-destructive" />}>
                <p>Если AI извлёк из переписок противоречие (например: «комиссия 5%» и «комиссия 7%»), оба факта получают одинаковый <b>conflictGroupId</b> и помечаются.</p>
                <p className="mt-[2px]">В разделе ядра такие знания выделены амбер-цветом. Откройте карточку, нажмите <Tag>Разрешить конфликт</Tag>:</p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <DashItem>выберите правильный вариант</DashItem>
                    <DashItem>или впишите свой — он станет каноничным, остальные уйдут в архив</DashItem>
                </ul>
                <p className="mt-[2px] text-[12px] text-muted-foreground">Все изменения попадают в audit-журнал.</p>
            </Step>

            <Step number={7} id="a-supersede" title="Superseded — обновление факта" icon={<GitMerge className="h-[4px] w-[4px] text-primary" />}>
                <p>Если условия компании изменились (например: «комиссия теперь 6%»), не правьте старую карточку — создайте новую через <Tag>Заменить факт</Tag>. Старая помечается как <b>superseded</b>, новая становится активной.</p>
                <p className="mt-[2px] text-[12px] text-muted-foreground">Так сохраняется история: для старых решений AI explainability видно «на этот ответ влиял факт A», даже если факт A уже заменён.</p>
            </Step>

            <Step number={8} id="a-shadow" title="Shadow mode — наблюдение перед запуском" icon={<History className="h-[4px] w-[4px] text-primary" />}>
                <p>В shadow-режиме retriever работает параллельно, но клиенту по-прежнему отвечает старая KB. AI ничего не меняет — только собирает trace для оценки.</p>
                <p className="mt-[2px]">В шапке ядра — pill <Tag>Shadow</Tag>, в разделе «Активность ответов» — последние trace.</p>
                <p className="mt-[2px]">Включается через переменную окружения <code className="rounded bg-surface px-1 py-0.5 text-[12px] border border-border">AI_KNOWLEDGE_SHADOW_MODE=1</code>. Сначала shadow — потом runtime.</p>
            </Step>

            <Step number={9} id="a-runtime" title="Runtime mode — AI отвечает из ядра" icon={<Power className="h-[4px] w-[4px] text-accent" />}>
                <p>Когда checklist готовности зелёный — переводите в runtime. AI начинает отвечать из ядра, старая KB больше не используется.</p>
                <p className="mt-[2px]">Включается переменной окружения <code className="rounded bg-surface px-1 py-0.5 text-[12px] border border-border">AI_KNOWLEDGE_RUNTIME_ENABLED=1</code> + перезапуск CRM.</p>
                <p className="mt-[2px] rounded-md border border-[#FFE8B0] bg-[#FFFBED] px-3 py-[2px] text-[12px] text-[#8B6914]">
                    <b>Это не UI-переключатель.</b> До перезапуска ничего не поменяется. Это страховка от случайного флипа кнопкой. Кликните на pill <Tag>Shadow</Tag> в ядре — увидите готовность и точные env-флаги.
                </p>
            </Step>

            <Step number={10} id="a-trouble" title="Если что-то не работает" icon={<AlertTriangle className="h-[4px] w-[4px] text-destructive" />}>
                <p><b>Кнопка «Собрать ядро» серая</b> — провайдер AI не настроен или API-ключ не сохранён. Откройте <b>AI Провайдер</b>, нажмите «Проверить» и «Сохранить».</p>
                <p className="mt-[2px]"><b>Сбор завершился ошибкой</b> — посмотрите запись в «Источники» → «Сбор ядра из истории». Там видно сколько пар обработано и где упал LLM.</p>
                <p className="mt-[2px]"><b>Ядро пустое после сбора</b> — мало переписок, или слишком короткий период. Увеличьте окно импорта.</p>
                <p className="mt-[2px]"><b>AI игнорирует ядро</b> — проверьте режим: pill в шапке. Если <b>Legacy</b> — runtime не включён, ставьте env-флаг.</p>
                <p className="mt-[2px]"><b>Конфликтов слишком много</b> — переписки противоречат друг другу. Разрешите хотя бы критичные (тарифы / документы) перед runtime.</p>
            </Step>

            <div className="rounded-md border border-border bg-surface/40 px-[4px] py-3 text-[13px] text-muted-foreground">
                Архитектурная документация и red lines модуля — в <code className="rounded bg-surface px-1 py-0.5 border border-border text-[12px]">.claude/knowledge/</code>, не здесь.
            </div>
        </div>
    )
}

function DashItem({ children }: { children: React.ReactNode }) {
    return (
        <li className="flex gap-[2px]">
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
