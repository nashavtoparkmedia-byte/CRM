# mod_audio_fork — установка для AI-звонков

Модуль FreeSWITCH, который форкает аудио активного звонка в WebSocket. Используется AI-bridge'ом: live STT слушает речь лида, TTS возвращает синтезированный голос ИИ обратно в звонок.

**В стандартной сборке FreeSWITCH (`freeswitch-meta-vanilla` apt-пакет, исходники с official mirror) этого модуля нет.** Его нужно собрать отдельно.

---

## Где взять

⚠️ **Оригинальный `drachtio/drachtio-freeswitch-modules` репозиторий удалён с GitHub (404).** Используем активный форк, который держит идентичные исходники:

```
https://github.com/mdslaney/drachtio-freeswitch-modules
```

Конкретно нам нужен `modules/mod_audio_fork/` из этого репо.

**Самый быстрый путь** — готовый script-инсталлер в этом проекте:

```bash
wsl bash /mnt/d/Github/CRM-day1/telephony/setup-mod-audio-fork.sh
```

Он сам ставит build-зависимости (включая `libwebsockets-dev`), клонирует исходники, собирает, устанавливает, регистрирует в `modules.conf.xml` и `load`-ит в running FreeSWITCH. Идемпотентен — безопасно перезапускать.

Ниже — ручные шаги (если хочешь видеть процесс).

## Сборка в WSL2 Ubuntu 24.04

Действующий FreeSWITCH у нас 1.10.12, собран из исходников в `/usr/local/freeswitch/`. Headers и `pkg-config` уже стоят (раз FS собрался). Поэтому шаги короткие.

### 1. Зависимости

```bash
sudo apt update
sudo apt install -y build-essential autoconf libtool pkg-config \
                    libwebsockets-dev \
                    libspeex-dev libspeexdsp-dev libsndfile1-dev
```

`libwebsockets-dev` обязательна — без неё `configure` падает.

### 2. Клонируем модули

```bash
cd ~
git clone --depth 1 https://github.com/mdslaney/drachtio-freeswitch-modules.git
cd drachtio-freeswitch-modules/modules/mod_audio_fork
```

### 3. Bootstrap + build

```bash
./bootstrap.sh
./configure
make
sudo make install
```

`make install` положит `mod_audio_fork.so` в `/usr/local/freeswitch/mod/`.

### 4. Регистрация модуля

Открой `/usr/local/freeswitch/conf/autoload_configs/modules.conf.xml` и добавь:

```xml
<load module="mod_audio_fork"/>
```

в секцию `<modules>`. По алфавиту, после `mod_audio_file_format` и до `mod_av`.

### 5. Загрузить без перезапуска

```bash
sudo /usr/local/freeswitch/bin/fs_cli -x "load mod_audio_fork"
```

Должно вывести `+OK Reloading XML\n+OK module loaded`. Проверка:

```bash
sudo /usr/local/freeswitch/bin/fs_cli -x "module_exists mod_audio_fork"
```

Должно: `true`.

## Использование в dialplan

В нашем `telephony/conf/dialplan/default/` создадим хук для AI-звонков. Для существующего outbound трафика (обычные click-to-call) ничего не меняется — модуль работает только когда явно вызывается через application.

Пример вызова из dialplan (для AI-сценария):

```xml
<action application="set" data="fork_metadata={\"callId\":\"${call_uuid}\",\"leadId\":\"${lead_id}\"}"/>
<action application="audio_fork" data="ws://host.docker.internal:3030/audio-fork mixed both"/>
```

Расшифровка параметров `audio_fork`:
- `ws://...` — WebSocket-эндпоинт Node.js-бриджа в gravity-mvp
- `mixed` — отдаём смешанный mono-стрим (а не отдельные каналы a/b). Можно `stereo` если нужны раздельные.
- `both` — направление: и слушаем (стрим лида в bridge), и принимаем (bridge отдаёт TTS-аудио)

`fork_metadata` — произвольный JSON, попадает в первое WebSocket-сообщение `start`. Через него передаём `callId` и `leadId` чтобы бридж знал, к какой Call-записи привязать сессию.

## Проверка работоспособности

После установки запусти простой test-сервер на любом порту, который просто принимает WS-соединение и закрывает:

```bash
# В отдельном терминале
python3 -c "
import asyncio, websockets
async def echo(ws):
    async for msg in ws:
        if isinstance(msg, bytes): print(f'audio {len(msg)} bytes')
        else: print(f'text {msg}')
asyncio.run(websockets.serve(echo, 'localhost', 3030).serve_forever())
"
```

Затем в `fs_cli` запусти тестовый dialplan с `audio_fork`. В терминале с echo-сервером должны посыпаться `audio NNN bytes` сообщения с частотой ~50/сек (20мс кадры).

## Если что-то пошло не так

| Симптом | Причина | Что делать |
|---|---|---|
| `./bootstrap.sh: No such file` | Старая версия drachtio modules | `git pull` или используй `autoreconf -i` |
| `configure: error: switch_pthread.h not found` | `freeswitch-dev` headers не установлены | FreeSWITCH у нас из исходников — headers в `/usr/local/freeswitch/include/freeswitch/`. Добавь `--with-freeswitch-src=/path/to/freeswitch-1.10.12` к `./configure` |
| `module_exists mod_audio_fork` → `false` после load | Версия модуля несовместима с FS 1.10.12 | Чекаут конкретного коммита: `git checkout v0.5.0` |
| WebSocket connection refused | Бридж не слушает на 3030 | `netstat -tlnp \| grep 3030` |

## Что отдать обратно

После того как `module_exists mod_audio_fork` возвращает `true` и тест с Python-echo принимает аудио — сообщи в чат:
- Версия модуля (`git log -1 --oneline` из drachtio репо)
- Вывод `module_exists` команды
- Скриншот первых строк лога python-echo с принятым аудио

Если используется не WSL2, а другой инстанс FreeSWITCH (например, на VPS), всё то же самое — пути могут отличаться (`/usr/lib/freeswitch/mod/` вместо `/usr/local/freeswitch/mod/`).
