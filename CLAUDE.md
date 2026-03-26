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

## Производительность
- Скрипты должны логировать прогресс: `console.log('Connecting...', 'Done')`
- Если команда висит > 20 сек без вывода — прерывать и менять подход
- Перед сложными Prisma-запросами проверять доступность БД через `prisma.$queryRaw`
