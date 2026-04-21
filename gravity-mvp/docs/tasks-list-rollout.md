# Tasks List — Churn MVP Rollout & Observation

Цель этого документа — провести 3 рабочих дня эксплуатации нового списка кейсов (сценарий «Отток»), собрать факты и подготовить их для анализа.

**Не добавлять UI, не чинить «по ощущениям», не принимать решений.**
Только фиксировать факты.

---

## 1. После merge

1. `git pull origin main` на проде.
2. Миграция: `npx prisma migrate deploy` — применит `20260422100000_add_usage_events` (создаёт таблицу `usage_events`).
3. `npm run build` и рестарт CRM (порт 3002).
4. Короткая sanity-проверка:
    - страница `/tasks` открывается
    - вкладка «Отток» показывает кейсы-строки (6 блоков, sticky header в режиме Таблица)
    - inline actions из строки работают
    - `SELECT COUNT(*) FROM usage_events;` → растёт по мере кликов

Если что-то из этих 4 пунктов не работает — **не эксплуатируем**, возвращаемся к разработке.

## 2. Включение в работу

- Сообщить менеджерам: работаем в новом списке, старый вид больше не используем.
- Параллельно старую версию не держим.
- Руководителю объяснить три режима (Operational / Control / Таблица) — одно предложение каждому.

## 3. Период наблюдения

- **Длительность:** 3 рабочих дня.
- **В эти 3 дня:** не меняем UI, не двигаем колонки в дефолтах, не добавляем фильтры, не патчим «по ощущениям».
- Любое замечание менеджера — в лог. Замечания не разбираем, не спорим, не объясняем — просто фиксируем.

## 4. Какие события собираются автоматически

Таблица `usage_events`. Каждая запись: `id, userId, action, payload, createdAt`.

| `action` | Когда пишется | `payload` |
|----------|---------------|-----------|
| `tasks_list_opened` | mount страницы `/tasks` | — |
| `mode_switch` | клик по Операционный / Контроль / Таблица | `{ viewId, mode }` |
| `density_switch` | клик по плотности Компактный / Стандартный / Полный | `{ density, viewId }` |
| `column_toggle` | show/hide колонки в popup «Настроить колонки» | `{ viewId, columnId, visible }` |
| `column_reorder` | drag-and-drop колонки внутри блока | `{ viewId, block, count }` |
| `inline_action` | клик по иконке в hover-зоне строки | `{ kind: 'call'\|'message'\|'reschedule'\|'escalate', taskId }` |
| `excel_click` | клик по Экспорт / Импорт (stub) | `{ kind: 'export'\|'import' }` |
| `filter_change` | переключение сценария, overdue chip, offer-select, park-select | `{ key, value }` |

Кроме этого в `task_events` (действующая таблица) уже логируются сами изменения задач: `called`, `wrote`, `postponed`, `escalated`, `status_changed`.

## 5. SQL для ежедневного снимка

Один запрос — одна метрика. Копировать в psql / pgAdmin / Metabase.

```sql
-- 5.1. Сколько раз открывали список за день (по менеджерам)
SELECT DATE("createdAt") AS day,
       "userId",
       COUNT(*) AS opens
FROM usage_events
WHERE action = 'tasks_list_opened'
GROUP BY 1, 2
ORDER BY 1 DESC, opens DESC;

-- 5.2. Сколько раз переключали режим и в какой чаще
SELECT DATE("createdAt") AS day,
       payload->>'mode' AS mode,
       COUNT(*) AS n
FROM usage_events
WHERE action = 'mode_switch'
GROUP BY 1, 2
ORDER BY 1 DESC, n DESC;

-- 5.3. Какая плотность строк реально используется
SELECT payload->>'density' AS density,
       COUNT(*) AS n
FROM usage_events
WHERE action = 'density_switch'
  AND "createdAt" >= NOW() - INTERVAL '3 days'
GROUP BY 1
ORDER BY n DESC;

-- 5.4. Какие колонки скрывают
SELECT payload->>'columnId' AS column_id,
       (payload->>'visible')::boolean AS visible,
       COUNT(*) AS n
FROM usage_events
WHERE action = 'column_toggle'
GROUP BY 1, 2
ORDER BY n DESC;

-- 5.5. Какие inline actions используют чаще
SELECT payload->>'kind' AS kind,
       COUNT(*) AS n,
       COUNT(DISTINCT "userId") AS users
FROM usage_events
WHERE action = 'inline_action'
GROUP BY 1
ORDER BY n DESC;

-- 5.6. Какие фильтры используют
SELECT payload->>'key' AS filter_key,
       payload->>'value' AS value,
       COUNT(*) AS n
FROM usage_events
WHERE action = 'filter_change'
GROUP BY 1, 2
ORDER BY n DESC;

-- 5.7. Сколько раз кликают Excel-заглушки (показатель ожидания фичи)
SELECT payload->>'kind' AS kind, COUNT(*) AS n
FROM usage_events
WHERE action = 'excel_click'
GROUP BY 1;

-- 5.8. Реальные действия менеджеров на задачах (не телеметрия, а факт)
SELECT "eventType", COUNT(*) AS n, COUNT(DISTINCT "taskId") AS tasks
FROM task_events
WHERE "createdAt" >= NOW() - INTERVAL '3 days'
  AND "eventType" IN ('called','wrote','postponed','escalated')
GROUP BY 1
ORDER BY n DESC;
```

## 6. Шаблон ежедневного отчёта

Заполнять в конце каждого рабочего дня. Не больше одной страницы.

```
# Tasks list — день {N} из 3 — {дата}

## Что работало (факты, без оценок)
- менеджер {userId/имя} сделал {N} inline-звонков / {N} переносов / ...
- чаще всего использовали режим: {Operational / Control / Таблица}
- чаще всего скрывали колонку: {id}, {id}
- чаще всего включали фильтр: {key=value}

## Что мешало (цитаты и факты, без интерпретации)
- {имя} → "не могу найти поле {X}"
- {имя} → "не вижу дедлайн"
- кейс из sentry/логов: {ошибка}

## Что игнорировали
- режим {mode} — переключили всего {N} раз
- фильтр {key} — не трогали
- кнопки Экспорт/Импорт — {N} кликов (показатель ожидания)

## Действия, которые делали чаще всего
- по данным task_events: {called N} / {wrote N} / {postponed N} / {escalated N}

## Новые боли, замеченные сегодня
- (пусто если нет)
```

### Что НЕ фиксируем

- «кажется неудобно» (без конкретики)
- «можно сделать красивее»
- любые пожелания без привязки к конкретному действию
- субъективные оценки «норм / плохо»

## 7. Итоговая сводка после 3 дней

В день 4 (первый после наблюдения) подготовить один общий список:

```
# Tasks List Churn — итог 3 дней эксплуатации

## Сводные цифры (SQL 5.1–5.8)
| Метрика | Значение |
|---------|----------|
| Уникальных пользователей | ... |
| Открытий списка / день | ... |
| Inline-действий всего | ... |
| Самый частый режим | ... |
| Самая частая плотность | ... |

## Повторяющиеся наблюдения (≥2 раза от разных людей)
- ...
- ...

## Единичные наблюдения
- ...

## Ошибки в логах / БД
- ...

## Что НЕ используется
(потенциальные кандидаты на упрощение)
- ...
```

**В этот отчёт не включаем:**
- решения («давайте сделаем так»)
- гипотезы
- приоритезацию

Только факты. Решения — отдельной сессией, после сводки.

## 8. Когда переходить к следующему этапу

После того как сводка по 3 дням готова и показана команде — переходим к:

1. **Excel export / import** — реальная реализация (канонический + рабочий формат, preview diff, conflict detection). Контракт `exportKey` уже на месте.
2. **Перенос сценария «Подключение»** — добавить записи в `list-columns.ts` и `list-views.ts`; код рендера / стор не трогать.

Ничего из этого не начинаем до тех пор, пока нет факт-сводки.
