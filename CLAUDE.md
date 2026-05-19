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

### Команды запуска — три уровня

Три ступени поднятия стека по нарастающей. Подбирай по тому, что человек
просит.

#### 1. «Запусти проект» / «Запусти проект СРМ»
Базовая ступень — 4 фоновых процесса. **Без телефонии и без
AudioBridge.** Этого достаточно для работы с лидами, скрапером, MAX и
WhatsApp/Telegram.

| Терминал | Папка | Команда |
|----------|-------|---------|
| 1 — CRM | `./gravity-mvp` | `npm run dev` |
| 2 — Scraper API | `./yandex-fleet-scraper` | `npm run start:api` |
| 3 — Scraper Worker | `./yandex-fleet-scraper` | `npm run start:worker` |
| 4 — MAX Scraper | `./max-web-scraper` | `node index.js` |

Порты: CRM → 3002, Scraper API → :3003, MAX Scraper → :3005.

**Local infra prerequisites (Redis + MinIO).** Без них AI-call
persistence layer не работает: recording upload в MinIO и
finalize/transcribe queue в Redis. Два способа поднять:

```
# Способ 1 — нативно в WSL (быстрее, не нужен Docker Desktop):
node gravity-mvp/scripts/ensure_local_infra.js

# Способ 2 — через Docker compose в telephony/ (рекомендовано для прода-зеркала):
docker compose -f telephony/docker-compose.yml up -d redis minio minio-init
```

Helper-скрипт `ensure_local_infra.js` идемпотентный: если Redis/MinIO
уже подняты — no-op; если нет — ставит/стартует в WSL и создаёт
`recordings` bucket. Запускать единожды после reboot.

Перед стартом скрапера дополнительно проверить `docker info` — если
Docker Desktop не запущен, AI-call всё ещё работает (нативные
WSL-сервисы), но скрапер с BullMQ упрётся в `ECONNREFUSED :6379`
если оба провайдера упали.

#### 2. «Телефония» / «Зелёная точка телефонии» / «Телефония красная»
**Не AudioBridge** — для зелёной точки в шапке нужен ТОЛЬКО FreeSWITCH.
Иконка трекает WebRTC SIP-регистрацию браузерного софтфона к FS на :7080,
к AudioBridge она отношения не имеет (тот только для AI-обзвона).

Команды:
```
# 1. Старт FS без sudo-промпта (через root-юзера WSL).
#    Использовать PowerShell-тул чтобы Git-Bash не корёжил /usr/local/... пути.
wsl -d Ubuntu-24.04 -u root /usr/local/freeswitch/bin/freeswitch -ncwait

# 2. После каждого свежего старта FS догрузить mod_audio_fork —
#    он НЕ в autoload.conf этой сборки. Без него AI-обзвон молчит,
#    но обычная телефония работает.
wsl -d Ubuntu-24.04 -u root /usr/local/freeswitch/bin/fs_cli -x "load mod_audio_fork"

# 3. Проверить мегафон зарегистрирован:
wsl -d Ubuntu-24.04 -u root /usr/local/freeswitch/bin/fs_cli -x "sofia status gateway megafon"
#    Ожидаем: State REGED, Status UP
```

Дальше сказать пользователю: **«обнови страницу CRM (Ctrl+R)»**.
SipContext в браузере не делает auto-retry — если на момент открытия
страницы FS лежал, иконка останется красной до перезагрузки вкладки.

WSL засыпает вместе с ноутом. После открытия крышки FS почти всегда
надо стартовать заново — это норма, а не баг.

#### 3. «Запусти проект полностью»
Базовая ступень + телефония + AudioBridge (для AI-обзвона).

Порядок:
1. Базовая ступень (4 процесса) — пункт 1.
2. Телефония — пункт 2 (FS + mod_audio_fork).
3. AudioBridge: `cd tools/audio-bridge-day1 && node server.js`. Ждать
   `[esl-events] subscribed (auto-fork URL: ws://192.168.0.102:3030/audio, ...)`.

⚠️ **Сначала проверить рабочий tree:** если `git diff
tools/audio-bridge-day1/server.js` показывает `uuid_audio_fork pause`
вокруг `uuid_broadcast` — это сломанная Plan-B попытка, она убивает
звонок (после pause медиа-bug не восстанавливается). Откатить ПЕРЕД
стартом bridge:
```
git checkout tools/audio-bridge-day1/server.js tools/audio-bridge-day1/call-session.js
```
Или зафиксировать отдельным коммитом, если правки имеют смысл.

**STT / TTS provider matrix (production):**
```
AI_CALL_STT_PROVIDER=yandex      # default, native Russian, no silence hallucinations
AI_CALL_TTS_PROVIDER=openai      # Yandex TTS not wired yet (separate follow-up)
```

**STT — Yandex SpeechKit v3 streaming.** PR #22 fixed the SDK transport
(nice-grpc + static API-Key metadata, replaced the broken `Session`
client). Live-verified against Whisper on the same scenario
(callId `cmpc74qzq000bvp04ngxgajwa` vs `cmpc6cd7v0007vp04tsqlopeh`):

| | Yandex | Whisper |
|---|---|---|
| user STT correctness | 6/6 clean | 4/6 (mishears: «Водительский бассейн», «Учительские») |
| silence hallucinations | 0 | 2× «Редактор субтитров А.Синецкая Корректор А.Егорова» |
| scenario fields captured | 6 (full flow → transfer to manager) | 2 (stuck on «не расслышал») |

Yandex doesn't expose `speech_context` / phrase hints in the v3
streaming proto, so no per-vocabulary tuning. Out-of-the-box `general`
model is fine for the driver-qualification scenario.

**Whisper остаётся fallback** через `AI_CALL_STT_PROVIDER=whisper`
override — code path не тронут, ничего не сломано. Используется когда
Yandex API ключ не сконфигурирован в админке или сторона Yandex
недоступна.

**TTS still on OpenAI.** Yandex TTS module exists (`yandex-tts.js`),
но не активирован в проде — отдельная follow-up задача (russian voice
quality work).

### AI-call persistence layer (Task #4/#5 — закрыты)

После реальных AI-звонков ожидается:
- `Call.recordingPath` — MP3 в MinIO под `<year>/<month>/<fsUuid>.mp3`
- `Call.aiSessionStatus = 'ended'` (или `'transferring'` для manager-handoff)
- `Call.aiAnalysis` — JSON с qualification_status / lead_summary / reason / lead_data
- `Call.aiSummary` — короткое summary одной строкой

**Прежние симптомы (опровергнуты)**: `recordingPath=null` после звонка
и `POST /api/ai-calls/sessions/<id>/finalize` тайм-аут >5 s. Корень
обоих — отсутствующая локальная инфра (MinIO для upload, Redis для
BullMQ queue.add блокировал finalize из-за `maxRetriesPerRequest: null`).

**Code-уровень фиксы (PR — см. ниже)**:
- `gravity-mvp/src/lib/freeswitch/recordingProcessor.ts` — per-stage
  logging (`recording_stage_wav_found` / `_encoded` / `_uploaded` /
  `_transcribe_enqueued`) + per-stage `withTimeout` обёртки (encode 60s,
  upload 30s, enqueue 2s). System никогда не блокируется на mute infra.
- `gravity-mvp/src/app/api/ai-calls/sessions/[id]/finalize/route.ts` —
  `enqueueAnalyze` обёрнут в `withTimeout(2000ms)`. Если Redis down —
  finalize не висит, аналитика откладывается на ручной retry.

**Regression smoke**: `node gravity-mvp/scripts/smoke_ai_persistence.js`
синтетически прогоняет полный lifecycle (Prisma insert → fake WAV →
processRecording → finalize HTTP → assertions) без живого звонка. 9/9
проверок PASS на текущем main, latency ~7s end-to-end (ffmpeg encode
+ MinIO upload — основное время).

### SIP extension mapping (шапка CRM)
`src/lib/sip/extensions.ts` маппит `user.id` → SIP-расширение в FS.
Сейчас: `u1=101`, `u2=102`, `u3=103`. Если в `src/data/users.json`
появится новый менеджер `uN` — добавить запись EXTENSIONS и создать
`<N>.xml` в `/usr/local/freeswitch/conf/directory/default/`. Без записи
иконка останется красной с `403 no_extension_for_user` на
`/api/calls/sip-credentials`.

### Echo elimination via mod_audio_fork mono (issue #20 — закрыто)

**Состояние:** echo элиминирован физически. Bridge форкит в `mono`,
который тапает только **inbound (caller's audio)** медиа канала.
TTS живёт на outbound стороне и физически не попадает в WS.

**Что было ошибочно**: ранний код-коммент утверждал что
`mono`/`stereo` mix-types «сломаны в этой сборке» (0 PCM frames) и что
`pause/resume` тоже не работают. Эти assertion были основаны на
тесте на loopback-канале **без active playback** — естественно
mixed/stereo не получали write-side audio (его не было), что
выглядело как «модуль сломан». mono работал бы, но не был
повторно проверен.

**Что обнаружено повторным тестом** (`scripts/test_mod_audio_fork.js`,
prerequisite: `mod_audio_fork` loaded + loopback-канал с
continuous tone playback):

| Mix-type | FPS | Bytes/frame | Verdict |
|---|---|---|---|
| `mono`   | 46.1 | 320 (8k×20ms) | ✅ WS opens, PCM flows |
| `mixed`  | 46.1 | 320 | ✅ |
| `stereo` | 46.1 | 640 (×2 ch) | ✅ |
| `pause`  | — | — | ✅ frames stop в 2с |
| `resume` | — | — | ✅ frames restart в 2с |

Все 4 API surface работают.

**Production-state** (`tools/audio-bridge-day1/server.js`):
```js
const mixType = process.env.BRIDGE_FORK_MIX ?? 'mono'
```
`mono` — дефолт. Override `BRIDGE_FORK_MIX=mixed` если когда-нибудь
нужно вернуться на mixed (требует включить source-gate в
call-session.js onPcm() для защиты от echo).

**Backwards-compat**: source-gate в `call-session.js onPcm()` (drop
PCM при `state==='speaking'` + `acceptSttAfter` window) сохранён как
defense-in-depth. Под mono он dead code (state-гейт не срабатывает,
т.к. в STT-поток TTS физически не попадает), под mixed — рабочий
fallback. Удалять не нужно — он free safety net.

### Audio diagnostics — measurement harness (issue #23 baseline)

Если возникает жалоба «робот звучит рвано / теряются буквы / micropauses»,
**не идти в режим subjective listening loop**. В
`tools/audio-bridge-day1/scripts/` лежит objective measurement infra —
полный README там, шорт-список:

| Хочется узнать | Команда |
|---|---|
| MOS / SNR одной пары WAV | `wsl python3 .../score_quality.py ref.wav deg.wav` |
| Что юзер реально слышит в softphone | Browser snippet `webrtc_capture_auto.js` + `diag_upload_server.py` |
| Сравнить N FS-конфигов | `node .../run_quality_matrix.js` (правит `CONFIGS`) |
| RTP pacing FS-side | `bash .../capture_rtp_to_megafon.sh start/stop/analyze` + `analyze_rtp_pacing.js` |
| Micro-gap pattern в любом WAV | `node .../analyze_local_wav.js <wav>` |
| Bit-diff двух WAV (с alignment) | `node .../diff_wav_samples.js a.wav b.wav` |

Issue #23 protocol установил **base MOS ~1.55** для текущего pipeline
(PCMA + multiple resample stages — это codec-floor, не дефект).
Изменения, которые **не двигают MOS относительно этого baseline'а на
>0.1**, можно считать perceptually neutral. Возврат к "на слух
лучше/хуже" без objective harness — не аргумент в этом проекте.

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
Перед работой с интеграциями читать `.claude/knowledge/`.  
Пример: `.claude/knowledge/max_chat_merging.md` — логика Anti-Ghost чатов MAX Web Scraper.

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
