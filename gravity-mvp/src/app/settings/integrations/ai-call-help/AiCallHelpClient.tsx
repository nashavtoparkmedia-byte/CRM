"use client"

import { useState } from 'react'
import Link from 'next/link'
import {
    BookOpen, User, Wrench, Sparkles, CheckCircle2, XCircle, HelpCircle,
    KeyRound, FolderTree, AlertTriangle, ArrowRight,
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
            {/* Главный заголовок вкладки — зеркалит формат менеджерской
                инструкции (эмодзи + короткое название), но с админ-семантикой. */}
            <div className="flex items-center gap-2.5 rounded-md border border-primary/15 bg-primary/5 px-4 py-3">
                <span aria-hidden className="text-[18px] leading-none">⚙️</span>
                <h2 className="text-[15px] font-semibold text-foreground">Настройка AI-обзвона</h2>
            </div>

            <Step number={1} title="Как включить AI-обзвон">
                <p>Раздел живёт в <b>Настройки → AI-обзвон</b> — это группа в боковом меню под группой «Интеграции».</p>
                <p className="mt-2">Чтобы AI-обзвон работал, нужно одно из двух:</p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <DashItem><b>Включён mock-режим</b> — для тестового запуска без оплаты внешних сервисов</DashItem>
                    <DashItem><b>Настроены API ключи</b> OpenAI и Yandex SpeechKit — для живых голосовых звонков (появится позже)</DashItem>
                </ul>
                <p className="mt-2 text-[12px] text-muted-foreground">Сейчас работает только mock-режим: менеджеры тестируют интерфейс на готовых сценариях разговора.</p>
            </Step>

            <Step number={2} title="Как настроить API ключи">
                <p>Открой <Link href="/settings/integrations/ai-call-keys" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"><KeyRound className="h-3.5 w-3.5" />API ключи AI-обзвона<ArrowRight className="h-3 w-3" /></Link>. На странице 4 секции:</p>
                <ul className="mt-2 space-y-1 text-[13px]">
                    <DashItem><b>OpenAI</b> — ключ для будущего LLM-диалога</DashItem>
                    <DashItem><b>Yandex SpeechKit</b> — ключ для распознавания речи</DashItem>
                    <DashItem><b>Yandex Folder ID</b> — каталог в Yandex Cloud (не секрет)</DashItem>
                    <DashItem><b>Mock-режим</b> — переключатель тестового запуска</DashItem>
                </ul>
                <p className="mt-3">Как заполнить:</p>
                <ol className="mt-1.5 ml-5 list-decimal space-y-1 text-[13px]">
                    <li>Открой файл <code className="rounded bg-surface px-1 py-0.5 text-[12px] border border-border">gravity-mvp/.env</code> в редакторе</li>
                    <li>Добавь нужную строку — например, <code className="rounded bg-surface px-1 py-0.5 text-[12px] border border-border">YANDEX_API_KEY=AQVN...</code></li>
                    <li>Сохрани файл и перезапусти dev-сервер</li>
                    <li>Обнови страницу API ключей — статус должен поменяться с «не настроено» на «настроено»</li>
                </ol>
                <p className="mt-2">Чтобы проверить, что ключ принят сервисом — нажми кнопку <Tag>Проверить подключение</Tag>. Система отправит тестовый запрос и покажет результат справа от кнопки.</p>
                <p className="mt-2 text-[12px] text-muted-foreground">Секреты живут только в .env, в базу не пишутся, в браузер не уходят.</p>
            </Step>

            <Step number={3} title="Как настроить проекты и сценарии">
                <p>Открой <Link href="/settings/integrations/ai-call-scenarios" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"><FolderTree className="h-3.5 w-3.5" />Проекты и сценарии<ArrowRight className="h-3 w-3" /></Link>.</p>
                <p className="mt-2"><b>Проект</b> — это группа сценариев под одну бизнес-цель. По умолчанию 3 проекта:</p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <DashItem><b>Квалификация лида</b> — обзвон новых заявок</DashItem>
                    <DashItem><b>Работа с оттоком</b> — возврат водителей</DashItem>
                    <DashItem><b>Опрос качества</b> — NPS-опрос активной базы</DashItem>
                </ul>
                <p className="mt-3">Внутри каждого проекта — кнопка <Tag>+ Сценарий</Tag>. У сценария 4 поля:</p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <DashItem><b>Название</b> — короткое имя для админа</DashItem>
                    <DashItem><b>Системный промт</b> — роль ассистента и стиль разговора</DashItem>
                    <DashItem><b>Вопросы по порядку</b> — обычно 3–5 чётких вопросов</DashItem>
                    <DashItem><b>Целевая длительность</b> — обычно 120 секунд</DashItem>
                </ul>
                <p className="mt-2 text-[12px] text-muted-foreground">Менеджер не выбирает сценарий вручную — система берёт нужный по контексту (новый лид → «Квалификация лида» и т. д.).</p>
            </Step>

            <Step number={4} title="Как проверить что всё работает">
                <p>Самый быстрый способ — сделать mock-звонок:</p>
                <ol className="mt-1.5 ml-5 list-decimal space-y-1 text-[13px]">
                    <li>Открой раздел <b>«Водители»</b></li>
                    <li>Открой карточку любого водителя <b>с указанным телефоном</b></li>
                    <li>Под телефоном должна быть синяя кнопка <Tag color="primary"><Sparkles className="h-3 w-3" />AI-звонок</Tag></li>
                    <li>Нажми её — через секунду откроется страница звонка</li>
                </ol>
                <p className="mt-2">На странице звонка проверь, что всё на месте:</p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <DashItem>Бейдж <Tag color="primary"><Sparkles className="h-3 w-3" />AI-обзвон</Tag> в заголовке</DashItem>
                    <DashItem>Вкладка <b>«AI-анализ»</b> открыта по умолчанию</DashItem>
                    <DashItem>Видны: итог, резюме, причина решения, ответы лида, задача менеджеру</DashItem>
                </ul>
                <p className="mt-2 text-[12px] text-muted-foreground">Если всё это видно — AI-обзвон работает.</p>
            </Step>

            <Step number={5} title="Что делать, если не работает" icon={<AlertTriangle className="h-4 w-4 text-destructive" />}>
                <p><b>Нет кнопки «AI-звонок» в карточке водителя</b></p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <DashItem>У водителя пустой телефон → возьми водителя с заполненным номером</DashItem>
                    <DashItem>Mock-режим выключен → проверь <Link href="/settings/integrations/ai-call-keys" className="text-primary underline-offset-2 hover:underline">страницу API ключей</Link>: карточка <b>«Mock-режим»</b> должна быть <Tag color="accent">включена</Tag></DashItem>
                </ul>

                <p className="mt-3"><b>Не создаётся звонок при клике</b></p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <DashItem>Появилась ошибка «Mock-режим выключен» → включи <code className="rounded bg-surface px-1 py-0.5 text-[12px] border border-border">AI_CALL_MOCK_MODE=true</code> в <code>.env</code> и перезапусти dev-сервер</DashItem>
                    <DashItem>Страница звонка 404 → миграции не применены, выполни <code className="rounded bg-surface px-1 py-0.5 text-[12px] border border-border">npx prisma migrate deploy</code> и перезапусти сервер</DashItem>
                </ul>

                <p className="mt-3"><b>Нет результата на вкладке «AI-анализ»</b></p>
                <ul className="mt-1.5 space-y-1 text-[13px]">
                    <DashItem>Открыт обычный звонок, а не AI-звонок → в общей истории такие звонки отмечены пиллом <Tag><Sparkles className="h-3 w-3" />ИИ</Tag></DashItem>
                    <DashItem>Список сценариев пустой → обнови страницу «Проекты и сценарии», CRM автоматически создаст дефолтный сценарий</DashItem>
                </ul>
            </Step>
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
