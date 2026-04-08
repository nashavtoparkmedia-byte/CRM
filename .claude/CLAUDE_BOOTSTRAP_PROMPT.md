# Claude Bootstrap — Self-Initialization Prompt

При начале новой сессии выполни эту последовательность автоматически.

## 1. Определи корень проекта

```
ROOT = git rev-parse --show-toplevel
```

Проверь:
- `ROOT/.claude/` существует
- `ROOT/.git/` существует (один, без вложенных)
- `ROOT/CLAUDE.md` существует

Если что-то отсутствует — сообщи пользователю до начала работы.

## 2. Загрузи инструкции

Прочитай в указанном порядке:
1. `ROOT/CLAUDE.md` — правила, архитектура, design system
2. `ROOT/PROJECT_STRUCTURE.md` — карта модулей, портов, каналов

## 3. Загрузи инфраструктуру

Проверь наличие:

| Путь | Назначение |
|------|------------|
| `.claude/skills/` | Автоматические навыки (10 шт) |
| `.claude/knowledge/` | Доменные знания (anti-ghost, messenger snapshot) |
| `.claude/workflows/` | Автоматизация запуска |
| `.claude/launch.json` | Preview server config |
| `.mcp.json` | MCP серверы (Context7, PostgreSQL) |

Если файлы отсутствуют — перечислить недостающие.

## 4. Проверь memory

Memory хранится вне репо: `~/.claude/projects/<project-path-slug>/memory/`.
Slug формируется из абсолютного пути: разделители заменяются на `--`.

Проверь:
- memory для текущего пути существует
- `MEMORY.md` читается

Если memory отсутствует:
- создай папку
- создай пустой `MEMORY.md`
- предложи импорт из старой memory если есть

## 5. Построй карту проекта

Определи из `PROJECT_STRUCTURE.md` или сканированием:

| Модуль | Директория | Порт |
|--------|-----------|------|
| CRM | `gravity-mvp/` | 3002 |
| MAX Scraper | `max-web-scraper/` | 3005 |
| TG Bot | `tg-bot/` | 3001 |
| TG Bot Frontend | `tg-bot/tg-bot-frontend/` | 3004 |
| Yandex Scraper | `yandex-fleet-scraper/` | .env |

Точки входа:
- CRM: `gravity-mvp/src/app/` (Next.js pages + API routes)
- MAX: `max-web-scraper/index.js`
- TG: `tg-bot/` (npm start)
- Scraper: `yandex-fleet-scraper/` (API + Worker)

## 6. Проверь готовность

```
git status --short          # должен быть clean или known changes
git branch                  # main
ls .env per module          # gravity-mvp, max-web-scraper, tg-bot, yandex-fleet-scraper
```

## 7. Ответь пользователю

Краткий отчёт (не больше 5 строк):
- корень проекта
- количество модулей
- статус инфраструктуры (skills, knowledge, memory)
- git status
- готовность: READY / WARNING (с описанием)

## Правила

- Все пути относительные от ROOT
- Никогда не хардкодить абсолютные пути в инструкциях
- Язык общения: русский
- Design system: Telegram UI Principle (см. CLAUDE.md)
- При работе с интеграциями — сначала читать `.claude/knowledge/`
- Режим "Full Auto" = сразу в реализацию, проверить самому, краткий итог
