"""Данные каждого мира Foundry — отдельно.

data/worlds/<id мира>/
  kb/kb.json       — база знаний (журналы этого мира)
  campaign.json    — профиль кампании (название, система, тон, стиль ответов)
  sessions/<id>/   — события, расшифровки, загруженные тексты
  archive/         — старые сессии (если включена очистка)
  speakers.json    — кто есть кто в записи голоса (в разных кампаниях играют разные люди)
  ignore.json      — чьи дорожки и сообщения чата не учитывать

Общие для всех миров: ключи API и модели (.env), правила источников (config/sources.json),
папка Craig и её состояние, стоимость запросов, логи, модели распознавания.

Модуль присылает id мира в заголовке X-GMW-World. Без заголовка (старый модуль) данные лежат там же,
где раньше: data/kb, data/sessions, config/campaign.json, config/speakers.json, config/ignore.json.

Переезд: при обновлении с версии без разделения старые данные один раз переносятся в папку мира.
Если в kb.json записано, из какого мира собрана база, — в его папку сразу при старте сервера;
иначе — в папку первого мира, который обратится к серверу.
"""

from __future__ import annotations

import contextvars
import json
import re
import shutil
import threading
import time
from pathlib import Path

from .config import DATA_DIR, SERVER_DIR
from .kb import KnowledgeBase
from .sessions import SessionStore

WORLDS_DIR = DATA_DIR / "worlds"
ACTIVE_PATH = DATA_DIR / "active_world.json"   # последний мир, обратившийся к серверу (для Craig и transcribe.bat)

# Старое расположение (до разделения по мирам) — оно же для запросов без заголовка.
LEGACY_KB_DIR = DATA_DIR / "kb"
LEGACY_SESSIONS_DIR = DATA_DIR / "sessions"
LEGACY_ARCHIVE_DIR = DATA_DIR / "archive"
LEGACY_CAMPAIGN_PATH = SERVER_DIR / "config" / "campaign.json"
LEGACY_SPEAKERS_PATH = SERVER_DIR / "config" / "speakers.json"
LEGACY_IGNORE_PATH = SERVER_DIR / "config" / "ignore.json"

_ID_RE = re.compile(r"^[0-9A-Za-z_\-.]{1,64}$")


def safe_id(world_id: str | None) -> str:
    """id мира как имя папки; пусто — старое общее расположение."""
    w = (world_id or "").strip()
    if not w:
        return ""
    if _ID_RE.match(w) and w not in (".", ".."):
        return w
    return re.sub(r"[^0-9A-Za-z_\-.]+", "_", w)[:64] or "world"


class World:
    """Хранилища одного мира: база знаний, сессии, путь к профилю кампании."""

    def __init__(self, world_id: str):
        self.id = world_id
        if world_id:
            self.dir = WORLDS_DIR / world_id
            self.kb = KnowledgeBase(self.dir / "kb")
            self.store = SessionStore(self.dir / "sessions")
            self.campaign_path = self.dir / "campaign.json"
            self.speakers_path = self.dir / "speakers.json"
            self.ignore_path = self.dir / "ignore.json"
        else:
            self.dir = DATA_DIR
            self.kb = KnowledgeBase(LEGACY_KB_DIR)
            self.store = SessionStore(LEGACY_SESSIONS_DIR)
            self.campaign_path = LEGACY_CAMPAIGN_PATH
            self.speakers_path = LEGACY_SPEAKERS_PATH
            self.ignore_path = LEGACY_IGNORE_PATH

    def __repr__(self) -> str:
        return f"World({self.id or 'legacy'!r})"


_worlds: dict[str, World] = {}
_lock = threading.Lock()
_current: contextvars.ContextVar[World | None] = contextvars.ContextVar("gmw_world", default=None)


def get(world_id: str | None) -> World:
    """Хранилища мира (создаются при первом обращении). Пустой id — старое общее расположение."""
    wid = safe_id(world_id)
    with _lock:
        w = _worlds.get(wid)
        if w is None:
            if wid:
                _migrate_legacy_into(wid)
            w = World(wid)
            _worlds[wid] = w
            if wid:
                _remember_active(wid)
        elif wid and wid != _read_active():
            _remember_active(wid)
    return w


def loaded() -> list[World]:
    with _lock:
        return list(_worlds.values())


def known_ids() -> list[str]:
    """Миры, у которых есть папка на диске."""
    if not WORLDS_DIR.exists():
        return []
    return sorted(p.name for p in WORLDS_DIR.iterdir() if p.is_dir() and not p.name.startswith("_"))


# ---------------------------------------------------------------- текущий мир запроса


def set_current(world: World | None) -> contextvars.Token:
    return _current.set(world)


def reset_current(token: contextvars.Token) -> None:
    _current.reset(token)


def current() -> World | None:
    return _current.get()


def campaign_path() -> Path:
    """Путь к профилю кампании текущего запроса (или старый общий, если мир не задан)."""
    w = _current.get()
    return w.campaign_path if w else LEGACY_CAMPAIGN_PATH


def speakers_path() -> Path:
    w = _current.get()
    return w.speakers_path if w else LEGACY_SPEAKERS_PATH


def ignore_path() -> Path:
    w = _current.get()
    return w.ignore_path if w else LEGACY_IGNORE_PATH


def current_store() -> SessionStore:
    w = _current.get()
    return w.store if w else SessionStore(LEGACY_SESSIONS_DIR)


# ---------------------------------------------------------------- последний активный мир


def _remember_active(wid: str) -> None:
    try:
        ACTIVE_PATH.parent.mkdir(parents=True, exist_ok=True)
        ACTIVE_PATH.write_text(json.dumps({"world": wid, "at": int(time.time() * 1000)}), encoding="utf-8")
    except OSError:
        pass


def _read_active() -> str:
    try:
        return str(json.loads(ACTIVE_PATH.read_text(encoding="utf-8")).get("world") or "")
    except (OSError, ValueError):
        return ""


def active_id() -> str:
    """Мир, обращавшийся к серверу последним; пусто — ни один (или старая раскладка)."""
    return _read_active()


def for_transcribe(world_id: str | None = None) -> World:
    """Мир для расшифровки записи (transcribe.bat / Craig): явный, иначе последний активный, иначе старая раскладка."""
    return get(world_id or active_id())


def all_transcript_files():
    """transcript.json всех миров (и старой раскладки) — для списка уже импортированных записей Craig."""
    yield from LEGACY_SESSIONS_DIR.glob("*/transcript.json")
    if WORLDS_DIR.exists():
        yield from WORLDS_DIR.glob("*/sessions/*/transcript.json")


# ---------------------------------------------------------------- переезд старых данных


def _legacy_present() -> bool:
    """Есть ли что переносить: непустая база, сессии или профиль кампании старой раскладки."""
    kb = LEGACY_KB_DIR / "kb.json"
    if kb.exists():
        try:
            if json.loads(kb.read_text(encoding="utf-8")).get("pages"):
                return True
        except (OSError, ValueError, AttributeError):
            pass
    if LEGACY_SESSIONS_DIR.exists() and any(LEGACY_SESSIONS_DIR.iterdir()):
        return True
    return LEGACY_CAMPAIGN_PATH.exists()


def _legacy_world() -> str:
    """Мир, из которого собрана старая база (поле world в kb.json), если записан."""
    try:
        meta = json.loads((LEGACY_KB_DIR / "kb.json").read_text(encoding="utf-8")).get("meta") or {}
        return safe_id(meta.get("world") or "")
    except (OSError, ValueError, AttributeError):
        return ""


def _move(src: Path, dst: Path, log: list[str]) -> None:
    if not src.exists() or dst.exists():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    log.append(f"{src.relative_to(SERVER_DIR.parent)} → {dst.relative_to(SERVER_DIR.parent)}")


def _migrate_legacy_into(wid: str) -> None:
    """Перенести старые общие данные в папку мира wid — один раз, если у мира своей папки ещё нет."""
    if not wid or not _legacy_present():
        return
    target = WORLDS_DIR / wid
    if target.exists():
        return
    owner = _legacy_world()
    if owner and owner != wid:
        return  # база собрана из другого мира — ждём его (или перенесём при старте)
    log: list[str] = []
    _move(LEGACY_KB_DIR, target / "kb", log)
    _move(LEGACY_SESSIONS_DIR, target / "sessions", log)
    _move(LEGACY_ARCHIVE_DIR, target / "archive", log)
    _move(LEGACY_CAMPAIGN_PATH, target / "campaign.json", log)
    _move(LEGACY_SPEAKERS_PATH, target / "speakers.json", log)
    _move(LEGACY_IGNORE_PATH, target / "ignore.json", log)
    if log:
        print(f"[worlds] данные мира «{wid}» перенесены в data/worlds/{wid}:\n  " + "\n  ".join(log))
    # База в памяти старого мира (если успели загрузить) больше не актуальна.
    _worlds.pop("", None)


def migrate_on_start() -> None:
    """При старте: если старая база помнит свой мир — сразу переносим в его папку."""
    owner = _legacy_world()
    if owner and _legacy_present():
        with _lock:
            _migrate_legacy_into(owner)
