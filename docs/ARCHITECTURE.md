# GM Whispers — техническое описание

Актуально для версии 0.2.0 (9.10.2026). Что и зачем строим — `PLAN.md` (разделы 0–7, история). Что дальше — `ROADMAP.md`.

## 1. Из чего состоит

```
Foundry VTT (браузер ГМа)                 Этот же ПК                      Интернет
┌──────────────────────────┐   HTTP 127.0.0.1:8765   ┌──────────────────────┐
│ модуль gm-whispers       │ ───────────────────────▶│ GM Whispers Core      │──▶ Claude API / OpenAI
│ панель, настройки, HUD,  │   X-GMW-Token           │ Python, FastAPI       │
│ журнал событий, база     │ ◀───────────────────────│ база знаний BM25      │
└──────────────────────────┘                         │ сессии, расшифровка   │◀── папка облака (Craig)
                                                     └──────────────────────┘
```

- **Модуль** (`foundry-module/gm-whispers/`) — только у мастера. Собирает данные из мира (журналы, компендиумы, сцена, токены, бой, чат), показывает панель и окно настроек, пишет журнал сессии на сервер. Ничего не вычисляет про модели сам.
- **Core** (`server/`) — локальный сервер. Хранит базу знаний и сессии, ходит к провайдерам моделей, расшифровывает голос, читает папку с записями Craig. Слушает только 127.0.0.1; каждый запрос модуля несёт локальный токен.
- **Данные** — `data/` рядом с сервером (в `.gitignore`): `kb/kb.json`, `sessions/<id>/`, `logs/`, `models/`, `archive/`, `craig_inbox.json`.

## 2. Модуль Foundry

| Файл | За что отвечает |
|---|---|
| `main.js` | Настройки модуля (адрес, токен — client; kbPacks, logSession, kbAutoSync — world), клавиши Alt+G / Alt+T / Alt+R, кнопка на панели токенов, меню «Настройки сервера», `game.gmWhispers.{open,refreshKb,summary,settings}`, «Что нового» |
| `api.js` | `request(path, {method, body, timeout})` с токеном и таймаутом, `ServerError`, `stripHtml` (DOMParser), `isNoise` (подсказки AG D&D Hub) |
| `panel.js` | `AdvisorPanel` (ApplicationV2): статус (/health раз в 60 с, перерисовка только при изменениях), мастер первого запуска, примеры вопросов (по ситуации), лента ответов (до 40), прогресс долгих операций, `submit()`, `askAboutToken(token, kind)`, `refreshKb()`; `openPanel()`, `askHotkey(kind)` |
| `settings.js` | `ServerSettingsApp`: GET/POST `/settings`, проверка ключа через `/settings/models`, словарь говорящих, исключения, экспорт/импорт (без ключей) |
| `context.js` | `gatherContext({includeScene, tokens})`: страницы и заметки сцены, партия, стороны токенов, статблоки выделенных, бой |
| `tactics.js` | `tacticalSnapshot({focusToken})`: свой поиск пути по клеткам (стены, трудная местность, враги), укрытие по DMG, видимость, двери, регионы; `statblock(actor)` с подписями dnd5e |
| `session.js` | «Итоги»: диалог выбора сессии, забор записи Craig (`/craig/sync` + опрос `/craig/jobs`), загрузка файла расшифровки, `/session/summarize`, запись в журнал «GM Whispers · Дневник кампании» (ownership NONE), `indexEntry` |
| `logger.js` | Хуки чата, боя, хитов, сцен, добычи → очередь (localStorage, до 5000) → `/session/events` раз в 10 с; пишет только активный ГМ |
| `kbsync.js` | `kindFor(entry)` — вид источника по настройке папок `kbSources`; сбор страниц (мир + компендиумы из kbPacks, перевод Babele) с `kind`, автообновление: хуки журналов → `/kb/upsert` через 3 с, повтор при недоступном сервере, `markSynced` |
| `tokenhud.js` | Палитра в HUD токена: «Кто это / Реплика / Ход» |
| `md.js` | Markdown → HTML, ссылки `[S#]` → значки (панель) или `@UUID` (журнал); в журнале `@` и `[[` из текста модели экранируются |
| `changelog.js` | Список изменений по версиям; показ один раз при смене версии |
| `bible.js` | `getBible()` — текст двух страниц журнала библии для запросов; `openOrBuildBible()` — открыть или собрать; `updateBibleAfterSummary()` — после «Итогов» |
| `prep.js` | «К игре»: диалог, последние итоги из дневника, `/session/prep`, журнал «GM Whispers · К игре» |
| `lang/ru.json`, `lang/en.json` | Тексты интерфейса (`GMW.*`); новые тексты только здесь, старые переносятся перед 1.0 |

Соглашения: ApplicationV2 с `_renderHTML`/`_replaceHTML`, действия через `data-action`, весь текст из данных и от модели — через `esc()`, тултипы только `data-tooltip-text`. Все хуки обёрнуты в try/catch.

## 3. Сервер

| Модуль | За что отвечает |
|---|---|
| `config.py` | `Settings` из `.env` (ключи, модели, Craig, язык, хранение, origins), пути `DATA_DIR`, `SOURCES_PATH`, `SPEAKERS_PATH`, `IGNORE_PATH`; `FROZEN` для exe |
| `campaign.py` | Профиль кампании (`config/campaign.json`): `load/save`, `block(lang)` — текст для промптов, `render(template, lang)` подставляет `{campaign}` и `{lang}`, `resolve_lang` |
| `settings_store.py` | `public()` (ключи маскируются), `apply(body)` → `write_env` (сохраняет чужие строки и комментарии) + `reload()` + запись speakers/ignore |
| `app.py` | FastAPI, lifespan (inbox, очистка сессий, flush базы), CORS (localhost + `GMW_ALLOWED_ORIGINS`), `auth`, все эндпоинты (раздел 5) |
| `kb.py` | HTML → блоки → фрагменты (~1400 символов), классификация: явный `kind` от модуля (`KINDS`) или правила `sources.json`, индекс BM25 (`_Index` — неизменяемый снимок, обновление в потоке под `threading.Lock`), `rebuild`, инкрементальный `upsert`, отложенная запись `kb.json` (20 с), устойчивая загрузка |
| `llm.py` | Провайдеры `PROVIDERS` (anthropic, openai, gemini, deepseek, openrouter, custom), модель как «провайдер:модель» (`split_model`), `model_for(role)` с `auto` по первому ключу в `PROVIDER_ORDER`, клиенты (ленивые, `reset_clients`), три цикла с инструментами: `_anthropic_loop` (Messages, кэш промпта), `_openai_loop` (Responses API), `_chat_loop` (Chat Completions + function calling — Gemini/DeepSeek/OpenRouter/свой), `list_models`, `explain_error`; `on_event` — потоковые события во всех трёх циклах |
| `advisor.py` | Системный промпт, инструменты `search_lore`/`read_page`, `Registry` ссылок, форматирование контекста и тактики, `ask(kb, question, ctx, history, role)` с предварительным поиском |
| `bible.py` | Библия кампании: `build()` (квенты + партия + итоги + база → постоянное/текущее), `update()` (новое «Текущее положение» по итогам), `prompt_block()` — текст в системный промпт (без «Предложений») |
| `prep.py` | «К игре»: сводка перед сессией по последним итогам, заметкам, активной сцене и базе (`prepare()`) |
| `session.py` | Итоги: шкала «события + голос», фильтры, map-reduce для длинных логов, `summarize()` |
| `sessions.py` | `SessionStore`: сессии по паузе 6 ч, `append_events` (пакетно), расшифровки, `list` (сводка из meta), `archive_old` |
| `transcribe.py` | CLI и `process_source`: zip Craig → дорожки (без ботов из ignore) → faster-whisper на CUDA (fallback CPU) или готовый `transcription.vtt`; прогресс `GMW_PROGRESS`, результат `GMW_RESULT` |
| `inbox.py` | `CraigInbox`: кандидаты (кэш 30 с, обход в потоке), `sync` по кнопке / `scan` раз в минуту, подпроцесс расшифровки с таймаутом 4 ч, статус задач |
| `filters.py` | `voice_ignored`, `chat_ignored` по `ignore.json` |
| `usage.py` | Цены, `Usage`, лог `usage.jsonl` с ротацией, сводка за сегодня / с запуска |
| `evaluate.py` | Контрольный набор (`config/eval.json`): поиск бесплатно, `--llm` платно, `--save` в `data/logs` |
| `tray.py`, `__main__.py` | Консольный режим, трей (`--tray`), `--transcribe` для exe |

Конфигурация: `server/.env` (секреты и настройки; образец `.env.example`), `server/config/sources.json` (веса и исключения источников), `speakers.json`, `ignore.json`.

## 4. Потоки данных

**Вопрос советнику.** Панель → `gatherContext` → `POST /ask {question, context, history, role}` → предварительный `search_lore` по вопросу и именам NPC → цикл с моделью (до 4 кругов, инструменты параллельно) → ответ с `[S#]` → `citations` с uuid страниц → панель рендерит ссылки. Роли: `lore` (сильная модель), `tactics` (+ `tacticalSnapshot`), `fast` (1 круг, 800 токенов).

**База знаний.** «База» → `collectAllPages` (журналы мира + компендиумы) → `POST /kb/import` → `rebuild` (10–15 с, в потоке) → `kb.json`. Правка журнала → хук → `POST /kb/upsert` → инкрементально (~20 мс) → запись через 20 с.

**Журнал сессии.** Хуки → очередь → `POST /session/events` → `data/sessions/<id>/events.jsonl` + `meta.json`. Новая сессия после паузы 6 ч.

**Голос.** Craig → облако → папка `GMW_CRAIG_INBOX` → «Итоги» с галочкой → `POST /craig/sync` → подпроцесс `gmw.transcribe` → `transcript.json/.txt` в сессии; панель опрашивает `GET /craig/jobs` раз в 5 с (прогресс). Вручную: перетащить zip на `transcribe.bat`.

**Итоги.** `POST /session/summarize {session, messages, notes, party, previous}` → `build_timeline` (события + голос, фильтры) → одна модель или map-reduce (части по 45k символов, до 4 параллельно) → markdown + citations → журнал в Foundry → `/kb/upsert`.

**Настройки.** Окно ⚙ → `GET /settings` → форма → `POST /settings` → `.env`/json → `reload()` → `reset_clients()`, `inbox.configure()`. Без перезапуска, кроме `GMW_ALLOWED_ORIGINS`, host, port.

## 5. HTTP API (все с заголовком `X-GMW-Token`, кроме `/`)

| Метод и путь | Назначение |
|---|---|
| `GET /` | Страница «работает» без данных (для трея) |
| `GET /health` | Версия, база, модели (`raw` и разрешённые), провайдер, ключ, Craig, расход, срок хранения |
| `GET/POST /settings` | Настройки (см. `settings_store.FIELDS`, `speakers`, `ignore`) |
| `POST /settings/models` | `{provider, api_key?}` → список моделей (проверка ключа) |
| `POST /kb/import` | `{world, pages[{uuid, entry, page, folder, html}]}` → полная пересборка |
| `POST /kb/upsert` | `{pages}`; пустой `html` = удалить страницу |
| `POST /ask/stream` | То же, но NDJSON-поток: `status` / `delta` / `reset` / `done` (= результат /ask) / `error` / `ping` |
| `POST /ask` | `{question, context?, history?, role}` → `{answer, citations, usage, seconds}` |
| `POST /session/summarize` | → `{markdown, citations, stats, usage}` |
| `POST /bible/build` | `{quentas[{name,text}], party, summaries[], lang}` → `{permanent, current}` |
| `POST /bible/update` | `{permanent, current, summary, lang}` → `{current}` |
| `POST /session/prep` | `{summaries[], notes, party, scene, lang}` → `{markdown, citations, usage, seconds}` |
| `POST /session/events` | `{events[{ts, kind, text, who?, whisper?}]}` |
| `GET /session/list` | Последние 30 сессий |
| `POST /session/{sid}/transcript` | Загрузка txt/srt/vtt; `sid=new` создаёт сессию |
| `GET /craig/pending?fresh=` | Новые архивы в папке (кэш 30 с) + задачи |
| `GET /craig/jobs` | Только задачи (лёгкий опрос прогресса) |
| `POST /craig/sync` | Забрать новые записи |

## 6. Безопасность и ограничения

- Сервер только на 127.0.0.1; CORS только для localhost-страниц (и явных `GMW_ALLOWED_ORIGINS`); токен сравнивается timing-safe.
- Ключи API (шесть провайдеров) живут в `.env`, наружу уходит «задан / …1234». Свой провайдер: `CUSTOM_BASE_URL`, `CUSTOM_API_KEY`, `CUSTOM_MODEL`, `CUSTOM_NAME`. В логах и баннере ключей нет; в `/usage.jsonl` — текст вопроса (первые 200 символов).
- Провайдеру модели уходят: журналы мира (включая скрытые от игроков), чат, расшифровка, имена учёток и персонажей.
- Текст модели и данных мира всегда экранируется; в дневнике энричеры создаются только из `citations`.
- Модуль не может запускать сервер: это ограничение Foundry (код модуля живёт в браузере).

## 7. Где что лежит на ПК Di

- Проект: `H:\Cowork\GM_Whispers` (копия для разработки в контейнере: `/mnt/user-data/outputs/GM_Whispers`, в контейнер попадает через `device_stage_files`, обратно — `device_commit_files`).
- Foundry: `H:\Foundry_14`, миры `Data\worlds\dod` (боевой) и `dod-test`; модуль подключён junction-ссылкой `Data\modules\gm-whispers → H:\Cowork\GM_Whispers\foundry-module\gm-whispers`.
- Python venv `server\.venv` (Windows, из контейнера не запускается); все `.bat`/`.vbs` в CRLF.
- Записи Craig: `D:\Google Drive\Craig`. Модель распознавания: `data\models\faster-whisper-large-v3-turbo`.
- Тестовые выгрузки для контейнера: `data\test\export.json` (376 страниц мира), `data\test\packs.json` (компендиумы).

## 8. Как проверять

- Сервер: в контейнере `fastapi.testclient` против `gmw.app` с временным `.env` и `data/test/export.json` (импорт, upsert, поиск, настройки, CORS). Модели — заглушки или пропуск.
- Модуль: `node --check` на все файлы; окно настроек и панель — макет Foundry на jsdom (`ApplicationV2`, `game.settings`, `fetch`), см. историю в чате 8–9.10.
- Тактика: мок канваса (стены, двери, регионы, токены) — путь, укрытие.
- Вживую: только Di в Foundry; всё, что не проверено вживую, помечается в ROADMAP.
