# CRM Project — Claude Code Instructions

## Project Overview
Internal CRM for managing drivers and analytics (NashAvtoParkMedia).

**Stack:** TypeScript + JavaScript, Node.js, Prisma ORM  
**OS:** Windows (важно для команд)

---

## Architecture — 4 модуля + 2 сервиса

| Модуль | Папка | Запуск |
|--------|-------|--------|
| CRM Frontend/Backend | `./gravity-mvp` | `npm run dev` |
| Scraper API | `./yandex-fleet-scraper` | `npm run start:api` |
| Scraper Worker | `./yandex-fleet-scraper` | `npm run start:worker` |
| MAX Web Scraper | `./max-web-scraper` | `node index.js` |
| TG Bot Backend | `./tg-bot` | `npm start` |
| TG Bot Frontend | `./tg-bot/tg-bot-frontend` | `npm run dev` |

Для запуска всего сразу: `start-all.bat` в корне проекта.

### Команда "Запусти проект СРМ"
При этой фразе запускать 4 фоновых процесса последовательно:

| Терминал | Папка | Команда |
|----------|-------|---------|
| 1 — CRM | `./gravity-mvp` | `npm run dev` |
| 2 — Scraper API | `./yandex-fleet-scraper` | `npm run start:api` |
| 3 — Scraper Worker | `./yandex-fleet-scraper` | `npm run start:worker` |
| 4 — MAX Scraper | `./max-web-scraper` | `node index.js` |

Порты: CRM → 3002, Scraper API → смотреть в .env yandex-fleet-scraper.

---

## Rules for Claude

### Безопасные команды (выполнять без подтверждения)
- `npm run dev`, `npm start`, `npm run build`, `npm run lint`
- `prisma generate`, `prisma migrate dev`
- `node scripts/*.js` (временные скрипты)

### НИКОГДА не использовать
- `taskkill`, `wmic`, `Stop-Process` — для остановки процессов использовать Ctrl+C
- Chained команды: `cmd1 && cmd2` — выполнять последовательно, по одной
- Inline eval: `node -e "..."` — создавать временный файл и запускать его
- Shell редиректы: `echo >> file`, `command > file.txt` — использовать запись через код
- `cat`, `grep`, `tail`, `ls`, `dir` — читать файлы напрямую через инструменты

### Предпочтительный паттерн для скриптов
```js
// ПЛОХО: node -e "require('./db').query()"
// ХОРОШО: создать scripts/temp_query.js, запустить node scripts/temp_query.js
```

### Секреты
Никогда не передавать `DATABASE_URL`, пароли и токены в аргументах команды.  
Всё через `.env` файлы.

---

## База знаний агентов
Перед работой с интеграциями читать `.agents/knowledge/`.  
Пример: `.agents/knowledge/max_chat_merging.md` — логика Anti-Ghost чатов MAX Web Scraper.

---

## Тестирование

- **UI/UX изменения** — проверять визуально в браузере
- **Backend/Logic** — запускать локальные тест-скрипты
- **Мелкие правки** (текст, стили) — визуальной проверки достаточно
- Не звать пользователя для проверки пока не проверил сам

---

## Режим "Full Auto"
Когда пользователь пишет **"Full Auto"**:
1. Сразу в реализацию, без лишних вопросов
2. Все рутинные команды — без подтверждения
3. Перед финальным репортом — самостоятельно проверить результат
4. Краткий итог: что сделано и что проверено

---

## Design System — Telegram UI Principle

**Эталон:** Telegram. Весь интерфейс CRM проектируется по аналогии с Telegram.

### Основное правило
Перед созданием любого нового интерфейса:
1. Определить, как аналогичный сценарий реализован в Telegram
2. Повторить структуру, поведение и уровень сложности

### Применяется ко всему
Окна, разделы, модалки, подтверждения, списки, карточки, формы, меню, уведомления, настройки, статусы, ошибки, загрузка, фильтры, действия пользователя.

### Принципы
- Максимально простой и предсказуемый интерфейс
- Без перегрузки, лишних элементов и декоративного дизайна
- Без сложных сценариев

### Запрещено
- Изобретать новый UI стиль
- Добавлять лишние шаги
- Усложнять действия пользователя
- Делать интерфейс сложнее, чем в Telegram
- Использовать нестандартные паттерны без явной необходимости

### Правило проверки
При новом сценарии → "Как это сделано в Telegram?"
Если в Telegram нет аналога → максимально простой вариант, который выглядел бы естественно внутри Telegram.

---

### CSS Design Tokens (Flat / Telegram-style)

```css
/* Цвета — Chat & Messaging palette */
--primary:          #2AABEE;   /* Telegram blue */
--primary-dark:     #1E96D4;
--on-primary:       #FFFFFF;
--accent:           #059669;   /* online / success green */
--background:       #FFFFFF;
--surface:          #F1F5FD;   /* фон карточек, sidebar */
--foreground:       #0F172A;   /* основной текст */
--muted:            #64748B;   /* второстепенный текст, meta */
--border:           #E4ECFC;
--destructive:      #DC2626;
--on-destructive:   #FFFFFF;

/* Flat — без теней и градиентов */
--shadow:           none;
--elevation:        0;
--gradient:         none;

/* Форма */
--radius-sm:        6px;       /* input, badge */
--radius-md:        12px;      /* card, modal */
--radius-bubble:    16px;      /* chat bubble */
--radius-pill:      999px;     /* аватар, tag */

/* Типографика — Inter (system-first) */
--font-family:      'Inter', system-ui, -apple-system, sans-serif;
--font-size-xs:     12px;      /* meta, timestamp */
--font-size-sm:     13px;      /* caption, secondary */
--font-size-base:   15px;      /* body, list item */
--font-size-md:     17px;      /* subheading */
--font-size-lg:     20px;      /* section title */
--font-weight-normal:   400;
--font-weight-medium:   500;
--font-weight-semibold: 600;
--font-weight-bold:     700;
--line-height-tight:    1.3;
--line-height-base:     1.5;
--letter-spacing-tight: -0.3px;

/* Spacing — 4-point grid */
--space-1:  4px;
--space-2:  8px;
--space-3:  12px;
--space-4:  16px;
--space-5:  20px;
--space-6:  24px;
--space-8:  32px;
--space-12: 48px;

/* Touch targets */
--touch-target-min: 44px;
--list-item-height: 56px;      /* строка списка — как в Telegram */
--topbar-height:    56px;
--input-height:     44px;

/* Анимации — быстрые, ненавязчивые */
--duration-fast:    150ms;
--duration-base:    200ms;
--easing:           ease;
```

### Tailwind config (gravity-mvp)

```js
// tailwind.config — расширение для Telegram-стиля
fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
colors: {
  primary:     '#2AABEE',
  'primary-dark': '#1E96D4',
  accent:      '#059669',
  surface:     '#F1F5FD',
  muted:       '#64748B',
  border:      '#E4ECFC',
},
borderRadius: {
  sm: '6px', md: '12px', bubble: '16px', pill: '9999px',
},
boxShadow: { none: 'none' },
```

### Компоненты — обязательные правила

**Список (list row)**
- Высота строки: 56px
- Аватар слева 40×40px (border-radius: pill)
- Основной текст: 15px/500, цвет foreground
- Мета / время: 12px/400, цвет muted, выровнено справа
- Hover: `bg-surface` (без outline, без тени)
- Нет декоративных иконок "стрелочка вправо"

**Модальное окно**
- border-radius: 12px, padding: 24px
- Заголовок: 17px/600
- Кнопки: bottom sheet или inline в футере
- Overlay: `rgba(0,0,0,0.4)`
- Нет крестика ×, если есть кнопка "Отмена"

**Кнопки**
- Primary: bg-primary, text-white, height 44px, radius 8px, font 15px/600
- Secondary / Ghost: border 1px border-border, bg transparent
- Destructive: bg-destructive, text-white
- Нет градиентов, нет теней на кнопках

**Input / форма**
- height: 44px, border: 1px solid border, radius 8px
- Focus: border-primary (только цвет, никакого box-shadow glow)
- Placeholder: цвет muted
- Label сверху, 13px/500

**Чат (messages)**
- Пузырь входящего: bg-surface, radius 16px (кроме нижнего левого — 4px)
- Пузырь исходящего: bg-primary, text-white, radius 16px (кроме нижнего правого — 4px)
- Время в пузыре: 11px, opacity 0.7
- Sticky input снизу: height 44px + padding
- Typing indicator: 3 точки, анимация pulse 600ms

**Пустые состояния (empty state)**
- Иконка или иллюстрация (простая, outline)
- Заголовок: 17px/600
- Подпись: 14px/400, muted
- CTA-кнопка опциональна

**Загрузка**
- Skeleton с `animate-pulse`, цвет `bg-surface`
- Никогда не оставлять пустой экран без индикатора

**Уведомления / Toast**
- Снизу по центру или снизу справа
- Без заголовка: одна строка текста
- Auto-dismiss 3 сек
- Нет иконок предупреждения — только для критических ошибок

### Анти-паттерны (запрещено в вёрстке)

| Запрещено | Правильно |
|-----------|-----------|
| `box-shadow` на карточках | `border: 1px solid var(--border)` |
| Градиентные фоны | Solid-цвет из палитры |
| Несколько primary-цветов | Один `--primary`, остальное — surface/muted |
| Иконки везде "для красоты" | Иконки только если несут смысл |
| Модалки с 3+ действиями | Разбить на шаги или убрать лишнее |
| Анимации > 300ms | `duration-fast: 150ms` / `duration-base: 200ms` |
| Кнопки меньше 44px по высоте | `min-height: var(--touch-target-min)` |
| Breadcrumbs на плоской навигации | Только заголовок страницы |
| Hover-эффекты с тенью | `hover:bg-surface` — только цвет фона |

---

## Производительность
- Скрипты должны логировать прогресс: `console.log('Connecting...', 'Done')`
- Если команда висит > 20 сек без вывода — прерывать и менять подход
- Перед сложными Prisma-запросами проверять доступность БД через `prisma.$queryRaw`
