"""HTTP API для модуля Foundry. Слушает только 127.0.0.1."""

from __future__ import annotations

import asyncio
import json
import secrets
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import __version__, advisor, bible, prep, session, settings_store
from .config import settings
from .inbox import CraigInbox
from .kb import KINDS, KnowledgeBase
from .llm import DEFAULT_MODELS, PROVIDERS, LLMError, has_key, list_models, model_for, provider_for, reset_clients
from .sessions import SessionStore
from .usage import usage_summary

kb = KnowledgeBase(settings.kb_dir)
store = SessionStore()
inbox = CraigInbox(settings.craig_inbox, settings.craig_auto)
_kb_lock = asyncio.Lock()      # одно изменение базы за раз
ASK_TIMEOUT = 170               # с: чуть меньше таймаута модуля (180), чтобы сервер не тратил токены впустую


async def _housekeeping() -> None:
    """Раз в сутки: старые сессии в архив (если включено в настройках)."""
    while True:
        try:
            days = settings.sessions_keep_days
            if days > 0:
                done = await asyncio.to_thread(store.archive_old, days)
                if done:
                    print(f"[sessions] в архив (старше {days} дн.): {', '.join(done)}")
        except Exception as e:  # noqa: BLE001
            print(f"[sessions] очистка не удалась: {e}")
        await asyncio.sleep(24 * 3600)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    inbox.start()
    task = asyncio.create_task(_housekeeping())
    yield
    task.cancel()
    kb.flush()  # отложенные изменения базы — на диск


app = FastAPI(title="GM Whispers Core", version=__version__, lifespan=lifespan)

# Страница Foundry открыта с localhost (порт любой); хостинг Foundry (forge-vtt.com и т. п.) — через GMW_ALLOWED_ORIGINS.
# Остальным вкладкам сервер не отвечает даже на preflight.
_LOCAL_ORIGIN = r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$"
_EXTRA_ORIGINS = [o.strip().rstrip("/") for o in settings.allowed_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=_LOCAL_ORIGIN,
    allow_origins=_EXTRA_ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.middleware("http")
async def private_network(request: Request, call_next):
    """Разрешаем странице Foundry обращаться к локальному адресу (Private Network Access в Chromium)."""
    response = await call_next(request)
    if request.headers.get("access-control-request-private-network"):
        import re

        origin = request.headers.get("origin", "")
        if re.match(_LOCAL_ORIGIN, origin) or origin.rstrip("/") in _EXTRA_ORIGINS:
            response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


def auth(x_gmw_token: str = Header(default="")) -> None:
    if not x_gmw_token or not secrets.compare_digest(x_gmw_token, settings.local_token):
        raise HTTPException(status_code=401, detail="Неверный локальный токен. Скопируй GMW_LOCAL_TOKEN из server/.env в настройки модуля.")


class PageIn(BaseModel):
    uuid: str
    entry: str = ""
    page: str = ""
    folder: str = ""
    html: str = ""
    kind: str | None = None  # вид источника из настроек модуля; None — по правилам sources.json


class ImportIn(BaseModel):
    world: str = ""
    pages: list[PageIn]


class UpsertIn(BaseModel):
    pages: list[PageIn]


class EventsIn(BaseModel):
    events: list[dict]


class TranscriptIn(BaseModel):
    filename: str = "transcript.txt"
    text: str
    start: int | None = None


class SummaryIn(BaseModel):
    session: str | None = None
    messages: list[dict] = []
    notes: str = ""
    period: str = ""
    party: list[dict] | None = None
    previous: str = ""
    lang: str | None = None
    bible: dict | None = None


class PrepIn(BaseModel):
    summaries: list[str] = []
    notes: str = ""
    party: list[dict] | None = None
    scene: dict | None = None
    lang: str = "ru"
    bible: dict | None = None


class BibleBuildIn(BaseModel):
    quentas: list[dict] = []
    party: list[dict] | None = None
    summaries: list[str] = []
    lang: str | None = None


class BibleUpdateIn(BaseModel):
    permanent: str = ""
    current: str = ""
    summary: str
    lang: str | None = None


class AskIn(BaseModel):
    question: str
    context: dict | None = None
    history: list[dict] | None = None
    role: str = "lore"
    lang: str | None = None
    bible: dict | None = None


class SettingsIn(BaseModel):
    anthropic_api_key: str | None = None
    openai_api_key: str | None = None
    gemini_api_key: str | None = None
    deepseek_api_key: str | None = None
    openrouter_api_key: str | None = None
    custom_api_key: str | None = None
    custom_base_url: str | None = None
    custom_model: str | None = None
    custom_name: str | None = None
    model_lore: str | None = None
    model_tactics: str | None = None
    model_fast: str | None = None
    openai_reasoning: str | None = None
    openai_reasoning_fast: str | None = None
    craig_inbox: str | None = None
    craig_auto: bool | None = None
    whisper_model: str | None = None
    whisper_language: str | None = None
    sessions_keep_days: int | None = None
    allowed_origins: str | None = None
    speakers: dict[str, str] | None = None
    ignore: dict[str, list[str] | str] | None = None
    campaign: dict[str, str | bool] | None = None


class ModelsIn(BaseModel):
    provider: str = "anthropic"
    api_key: str | None = None   # проверить ещё не сохранённый ключ
    base_url: str | None = None  # для своего провайдера


def _models_status() -> dict:
    return {
        "lore": model_for("lore"), "tactics": model_for("tactics"), "fast": model_for("fast"),
        "raw": {"lore": settings.model_lore, "tactics": settings.model_tactics, "fast": settings.model_fast},
    }


@app.get("/", include_in_schema=False)
async def index():
    """Страница для человека (ссылка из трея): без токена — только факт, что сервер жив."""
    from fastapi.responses import HTMLResponse

    return HTMLResponse(
        "<!doctype html><meta charset='utf-8'><title>GM Whispers Core</title>"
        "<body style='font:15px/1.5 system-ui;max-width:40em;margin:3em auto;color:#eee;background:#1e1c22'>"
        f"<h2>GM Whispers Core {__version__} работает</h2>"
        "<p>Сервер ждёт запросов от модуля Foundry на этом компьютере. Панель советника — в Foundry (Alt+G).</p>"
        "<p>Настройки, ключи и модели — там же: панель → ⚙ «Настройки сервера».</p></body>"
    )


@app.get("/health", dependencies=[Depends(auth)])
async def health():
    lore = model_for("lore")
    return {
        "ok": True,
        "version": __version__,
        "kb": kb.stats(),
        "models": _models_status(),
        "provider": provider_for(lore),
        "apiKey": has_key(lore),
        "craig": inbox.status(),
        "usage": usage_summary(),
        "sessionsKeepDays": settings.sessions_keep_days,
    }


# ---------------------------------------------------------------- настройки


@app.get("/settings", dependencies=[Depends(auth)])
async def settings_get():
    return {**settings_store.public(), "resolved": _models_status(),
            "kinds": {k: v["label"] for k, v in KINDS.items()},
            "source_rules": settings_store.source_rules(),
            "providers": {p: {"title": v["title"], "base_url": v.get("base_url")} for p, v in PROVIDERS.items()}}


@app.post("/settings", dependencies=[Depends(auth)])
async def settings_post(body: SettingsIn):
    try:
        out = await asyncio.to_thread(settings_store.apply, body.model_dump(exclude_none=True))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except OSError as e:
        raise HTTPException(500, f"Не удалось записать настройки: {e}")
    reset_clients()
    inbox.configure(settings.craig_inbox, settings.craig_auto)
    print(f"[settings] обновлены: модели лор={model_for('lore')} тактика={model_for('tactics')} фон={model_for('fast')}; Craig: {settings.craig_inbox or '—'}")
    return {**out, "resolved": _models_status()}


@app.post("/settings/models", dependencies=[Depends(auth)])
async def settings_models(body: ModelsIn):
    """Проверка ключа: если провайдер отдал список моделей — ключ рабочий."""
    provider = body.provider if body.provider in PROVIDERS else "anthropic"
    try:
        ids = await asyncio.wait_for(list_models(provider, body.api_key, body.base_url), 40)
    except LLMError as e:
        raise HTTPException(e.status, e.message)
    except asyncio.TimeoutError:
        raise HTTPException(504, "Провайдер не ответил за 40 с")
    return {"provider": provider, "models": ids, "defaults": DEFAULT_MODELS[provider]}


# ---------------------------------------------------------------- база знаний


@app.post("/kb/import", dependencies=[Depends(auth)])
async def kb_import(body: ImportIn):
    async with _kb_lock:
        stats = await asyncio.to_thread(kb.rebuild, [p.model_dump() for p in body.pages], body.world)
    print(f"[kb] база обновлена: {stats.get('pages')} страниц, {stats.get('chunks')} фрагментов")
    return stats


@app.post("/kb/upsert", dependencies=[Depends(auth)])
async def kb_upsert(body: UpsertIn):
    async with _kb_lock:
        stats = await asyncio.to_thread(kb.upsert, [p.model_dump() for p in body.pages])
    print(f"[kb] обновлено страниц: {len(body.pages)}; всего фрагментов {stats.get('chunks')}")
    return stats


# ---------------------------------------------------------------- советник


@app.post("/ask", dependencies=[Depends(auth)])
async def ask(body: AskIn):
    q = body.question.strip()
    if not q:
        raise HTTPException(400, "Пустой вопрос")
    if not kb.chunks:
        raise HTTPException(409, "База знаний пуста. Нажми «База» в панели GM Whispers.")
    if not has_key(model_for(body.role)):
        raise HTTPException(409, "Ключ API не задан. Открой «Настройки сервера» в панели GM Whispers и впиши ключ.")
    try:
        result = await asyncio.wait_for(advisor.ask(kb, q, body.context, body.history, body.role, body.lang, body.bible), ASK_TIMEOUT)
    except LLMError as e:
        raise HTTPException(e.status, e.message)
    except asyncio.TimeoutError:
        raise HTTPException(504, f"Модель не уложилась в {ASK_TIMEOUT} с. Попробуй «быстро» или вопрос короче.")
    u = result["usage"]
    print(f"[ask] {result['seconds']} с · {u['model']} · ~${u['cost_usd']:.3f} · {q[:80]}")
    return result


@app.post("/ask/stream", dependencies=[Depends(auth)])
async def ask_stream(body: AskIn):
    """То же, что /ask, но ответ приходит по мере генерации: строки JSON (NDJSON).
    {"type":"status","text"} · {"type":"delta","text"} · {"type":"reset"} · {"type":"done", ...результат /ask} · {"type":"error","message"}"""
    from fastapi.responses import StreamingResponse

    q = body.question.strip()
    if not q:
        raise HTTPException(400, "Пустой вопрос")
    if not kb.chunks:
        raise HTTPException(409, "База знаний пуста. Нажми «База» в панели GM Whispers.")
    if not has_key(model_for(body.role)):
        raise HTTPException(409, "Ключ API не задан. Открой «Настройки сервера» в панели GM Whispers и впиши ключ.")

    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def on_event(ev: dict) -> None:
        try:
            if asyncio.get_running_loop() is loop:
                queue.put_nowait(ev)  # из самого цикла — сразу, чтобы не обогнать «done»
                return
        except RuntimeError:
            pass
        loop.call_soon_threadsafe(queue.put_nowait, ev)

    async def work():
        try:
            result = await asyncio.wait_for(advisor.ask(kb, q, body.context, body.history, body.role, body.lang, body.bible, on_event), ASK_TIMEOUT)
            u = result["usage"]
            print(f"[ask] {result['seconds']} с · {u['model']} · ~${u['cost_usd']:.3f} · {q[:80]}")
            await asyncio.sleep(0)  # дать уйти событиям, поставленным из других потоков
            await queue.put({"type": "done", **result})
        except LLMError as e:
            await queue.put({"type": "error", "message": e.message, "status": e.status})
        except asyncio.TimeoutError:
            await queue.put({"type": "error", "message": f"Модель не уложилась в {ASK_TIMEOUT} с.", "status": 504})
        except Exception as e:  # noqa: BLE001
            await queue.put({"type": "error", "message": f"{type(e).__name__}: {e}", "status": 500})

    async def gen():
        task = asyncio.create_task(work())
        try:
            while True:
                try:
                    ev = await asyncio.wait_for(queue.get(), 20)
                except asyncio.TimeoutError:
                    yield '{"type":"ping"}\n'  # чтобы соединение не считалось зависшим
                    continue
                yield json.dumps(ev, ensure_ascii=False) + "\n"
                if ev.get("type") in ("done", "error"):
                    break
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(gen(), media_type="application/x-ndjson", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------- сессии


@app.post("/session/summarize", dependencies=[Depends(auth)])
async def session_summarize(body: SummaryIn):
    if not body.session and not body.messages and not body.notes.strip():
        raise HTTPException(400, "Нет ни сообщений чата за период, ни заметок мастера.")
    if not has_key(model_for("lore")):
        raise HTTPException(409, "Ключ API не задан. Открой «Настройки сервера» в панели GM Whispers и впиши ключ.")
    try:
        result = await session.summarize(kb, body.messages, body.notes, body.period, body.party, body.previous, body.session, body.lang, body.bible)
    except LLMError as e:
        raise HTTPException(e.status, e.message)
    u = result["usage"]
    print(f"[session] итоги: {len(body.messages)} сообщ. · {result['seconds']} с · ~${u['cost_usd']:.3f}")
    return result


@app.post("/session/prep", dependencies=[Depends(auth)])
async def session_prep(body: PrepIn):
    """«К игре»: сводка перед сессией."""
    if not kb.chunks:
        raise HTTPException(409, "База знаний пуста. Нажми «База» в панели GM Whispers.")
    if not has_key(model_for("lore")):
        raise HTTPException(409, "Ключ API не задан. Открой «Настройки сервера» в панели GM Whispers и впиши ключ.")
    try:
        result = await asyncio.wait_for(prep.prepare(kb, body.summaries, body.notes, body.party, body.scene, body.lang, body.bible), 600)
    except LLMError as e:
        raise HTTPException(e.status, e.message)
    except asyncio.TimeoutError:
        raise HTTPException(504, "Сводка не уложилась в 10 минут.")
    u = result["usage"]
    print(f"[prep] {result['seconds']} с · {u['model']} · ~${u['cost_usd']:.3f}")
    return result


@app.post("/bible/build", dependencies=[Depends(auth)])
async def bible_build(body: BibleBuildIn):
    """Первая версия Библии кампании по квентам, партии и итогам."""
    if not has_key(model_for("lore")):
        raise HTTPException(409, "Ключ API не задан. Открой «Настройки сервера» в панели GM Whispers и впиши ключ.")
    try:
        result = await asyncio.wait_for(bible.build(kb, body.quentas, body.party, body.summaries, body.lang), 600)
    except LLMError as e:
        raise HTTPException(e.status, e.message)
    except asyncio.TimeoutError:
        raise HTTPException(504, "Сборка библии не уложилась в 10 минут.")
    print(f"[bible] собрана: {result['seconds']} с · ~${result['usage']['cost_usd']:.3f}")
    return result


@app.post("/bible/update", dependencies=[Depends(auth)])
async def bible_update(body: BibleUpdateIn):
    """Новое «Текущее положение» после итогов сессии."""
    if not has_key(model_for("lore")):
        raise HTTPException(409, "Ключ API не задан.")
    try:
        result = await asyncio.wait_for(bible.update(body.permanent, body.current, body.summary, body.lang), 300)
    except LLMError as e:
        raise HTTPException(e.status, e.message)
    except asyncio.TimeoutError:
        raise HTTPException(504, "Обновление библии не уложилось в 5 минут.")
    print(f"[bible] текущее положение обновлено: {result['seconds']} с · ~${result['usage']['cost_usd']:.3f}")
    return result


@app.post("/session/events", dependencies=[Depends(auth)])
async def session_events(body: EventsIn):
    return {"ok": True, "sessions": await asyncio.to_thread(store.append_events, body.events)}


@app.get("/session/list", dependencies=[Depends(auth)])
async def session_list():
    return {"sessions": (await asyncio.to_thread(store.list))[:30]}


@app.post("/session/{sid}/transcript", dependencies=[Depends(auth)])
async def session_transcript(sid: str, body: TranscriptIn):
    if sid == "new":
        sid = store.session_for(body.start or int(time.time() * 1000))
    try:
        res = await asyncio.to_thread(store.save_upload, sid, body.filename, body.text, body.start)
        res["session"] = sid
    except ValueError as e:
        raise HTTPException(400, str(e))
    inbox.invalidate()
    print(f"[session] {sid}: загружена расшифровка «{body.filename}», реплик: {res['lines']}")
    return res


# ---------------------------------------------------------------- Craig


@app.get("/craig/pending", dependencies=[Depends(auth)])
async def craig_pending(fresh: bool = False):
    """Новые записи в папке. Обход диска кэшируется; ?fresh=1 — посмотреть заново."""
    if not inbox.enabled:
        return {"enabled": False, "pending": [], "jobs": []}
    return {"enabled": True, "pending": await inbox.pending(fresh), "jobs": inbox.status()["jobs"]}


@app.get("/craig/jobs", dependencies=[Depends(auth)])
async def craig_jobs():
    """Лёгкий опрос хода обработки (без обращения к диску) — для прогресса в панели."""
    return {"enabled": inbox.enabled, "jobs": inbox.status()["jobs"]}


@app.post("/craig/sync", dependencies=[Depends(auth)])
async def craig_sync():
    if not inbox.enabled:
        raise HTTPException(400, "Папка записей Craig не задана. Открой «Настройки сервера» в панели GM Whispers.")
    return await inbox.sync()
