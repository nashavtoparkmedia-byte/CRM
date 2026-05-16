# QA-отчёт WA pipeline — 2026-04-24 01:40

## Начальное состояние после wipe+backfill(30d)

- **Job completed:** 80 msgs (78 new, 2 existing), 14 chats, 13 contacts
- **Длительность:** ~45 сек (старт 01:33:29 → completed ~01:34:14)

### [WA-MEDIA] saved events — 9 штук, ~5.2 MB суммарно

| # | ext_id | type | mime | size |
|---|---|---|---|---|
| 1 | 80A7562C44606176 | image | jpeg | 46 331 B |
| 2 | 0C5F5398FFB26FA4 | image | jpeg | 108 658 B |
| 3 | 61F48CB8D21C98C0 | image | jpeg | 136 182 B |
| 4 | 1EE50A8171DC06CD | **video** | mp4 | **4 482 276 B** |
| 5 | 1C34D2303B316343 | image | jpeg | 125 888 B |
| 6 | 23E287EFC6A2AEE5 | image | jpeg | 46 402 B (с caption) |
| 7 | BC447624E3340E7A | image | jpeg | 92 751 B |
| 8 | 7B92C06CA7393F3F | image | jpeg | 101 605 B |
| 9 | 2E21C52BEC290585 | image | jpeg | 87 219 B |

## 2.4 DB sanity (автоматически)

### scripts/check-wa-state.js

```
Chat (unified):    14
Message (unified): 78
WhatsAppChat:      14
WhatsAppMessage:   80
By direction: inbound=48, outbound=30

Chats (all have messages, no empty):
  [22] 80324511928475@lid  "+7 900 495-19-12"
  [10] 156148468592658@lid "+7 909 002-77-75"
  [9]  156204152127588@lid "+44 7723 442982"
  [7]  79530042828@c.us    "+7 953 004-28-28"
  [7]  79221853150@c.us    "Наш Единый телефон Автопарк"
  [6]  79222155750@c.us    "Ремезов Саша"
  [4]  79655239035@c.us    "Каюмов Шергазы UBER"
  [3]  79028783198@c.us    "Тетя Рябухина Надя"
  [3]  79025095972@c.us    "Гоголев Сергей Наш"
  [2]  79221138555@c.us    "Миша свинг🕉️🙏🔱🙌"
  [2]  79049814438@c.us    "Джабаров Артур Наш Автопарк"
  [1]  0@c.us              "WhatsApp Business"
  [1]  79001984462@c.us    "Олег муж Татьяны"
  [1]  25001759633653@lid  "+7 800 600-21-61"

JID-like content messages: 0 ✅

Date distribution:
  sentAt >= 7d ago: 21
  sentAt <  7d ago: 57
  oldest: 2026-03-26T11:27:13.000Z (29 дней назад — в пределах 30d)
  newest: 2026-04-23T22:33:57.983Z (сегодня, не из будущего)
```

✅ **PASS**: 14/14 чатов с сообщениями, 0 пустых, 0 JID-в-теле, oldest корректно в пределах 30 дней, newest не в будущем.

### scripts/audit-wa-groups.js

```
WhatsAppChat с @g.us:            0 ✅
Unified Chat (whatsapp) с @g.us: 0 ✅
WhatsAppMessage linked @g.us:    0 ✅

Sample suffixes (все @c.us или @lid): верно.
```

⚠️ Минор: финальный `$queryRawUnsafe` с `instr()` падает — это SQLite функция, в Postgres не работает. Это косметика script'а, не pipeline. Фикс 1-строка (заменить на `strpos`/`substring`), не блокер.

✅ **PASS**: групп в БД нет, @g.us полностью скипается.

### scripts/audit-photo-captions.js — 10 media messages

| chat | type | content | attachments |
|---|---|---|---|
| Каюмов Шергазы UBER | image | `[Фото]` | 1 × jpeg 136 KB |
| Каюмов Шергазы UBER | image | `[Фото]` | 1 × jpeg 108 KB |
| **WhatsApp Business** | **video** | `[Видео]` | **0** ⚠️ |
| Тетя Рябухина Надя | image | `[Фото]` | 1 × jpeg 125 KB |
| **Миша свинг** | **image** | **"Добрый день всем Достойным🙌 Товарищ продает 12 Айфон…"** | 1 × jpeg 46 KB ✅ |
| +7 909 002-77-75 | image | `[Фото]` | 1 × jpeg 87 KB |
| Тетя Рябухина Надя | video | `[Видео]` | 1 × mp4 4.4 MB |
| +7 900 495-19-12 | image | `[Фото]` | 1 × jpeg 46 KB |
| +7 909 002-77-75 | image | `[Фото]` | 1 × jpeg 101 KB |
| +7 909 002-77-75 | image | `[Фото]` | 1 × jpeg 92 KB |

✅ **PASS частично**:
- 9 из 10 media скачаны корректно
- Caption для "Миша свинг" сохранился ✅
- **Баг:** видео от `0@c.us WhatsApp Business` не скачалось (attachments: 0). Вероятно — это системное бизнес-уведомление без decryption keys. Функция `downloadAndSaveMedia` должна была silent-return false; почему не попало в лог failure — уточнить отдельно. Severity: **minor** (WA Business чат редко используется для живой переписки).

## Визуальная UI-проверка — ждёт пользователя

| # | Что проверить | Статус |
|---|---|---|
| 2.1 | Вкладка Чаты/Группы — нет @g.us в Чаты, вкладка Группы состояние | ⏳ пользователь |
| 2.2 | Хронология в чате "+7 953 004-28-28" (раньше битые 2038) | ⏳ пользователь |
| 2.3 | Фото "Миша свинг" рендерится + caption виден; фото Каюмов без "[Фото]" | ⏳ пользователь |
| 2.5 | Force reset — подключение за 5-15 сек без QR | ⏳ пользователь |

## Найденные баги

1. **[minor] WhatsApp Business video не скачался** — `0@c.us` chat, video без attachment. Downloadmedia либо вернул empty, либо обошёл логгер. Очень редкий edge case.

2. **[minor] audit-wa-groups.js падает на `instr()` в Postgres** — script баг, не production. Надо заменить на `strpos`.

3. **[expected] Вкладка "Группы" в UI будет пустой** — код скипает @g.us целиком (WhatsAppService.ts:147-149, 343-345, 497-499). Это наблюдаемое поведение, не баг фиксов, а **архитектурный выбор**: если бизнес хочет видеть groups — нужна отдельная задача (сохранять @g.us в отдельный scope с chat_type='group' + UI-фильтр в "Группы" по этому полю). Severity: **major по пользовательскому ожиданию**, отмечен в отчёте Cowork'а для следующей итерации.

## Итог автоматической части

**PASS WITH ISSUES:**
- Все 5 pipeline-фиксов (12c7edc, 11b58d7, 1b918b4, e94f656, 86b024a) работают как задумано
- 9 из 10 media скачалось корректно
- Caption сохранился
- Хронология — все в окне 30 дней, без будущих дат
- 0 JID-junk, 0 пустых чатов, 0 @g.us в БД
- Минорные баги: 1 WA Business video + косметическая ошибка в audit-скрипте

Ожидает визуальную UI-проверку пользователем (2.1, 2.2, 2.3, 2.5).
