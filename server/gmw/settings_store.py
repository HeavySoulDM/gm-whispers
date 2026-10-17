"""Настройки, которые меняются из окна «Настройки сервера» в Foundry, без правки файлов.

Хранилище прежнее — server/.env (ключи, модели, папка Craig) и server/config/*.json
(словарь говорящих, исключения). Здесь: безопасная выдача (ключи маскируются), запись
в .env с сохранением чужих строк и комментариев, перечитывание настроек на лету.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from dotenv import load_dotenv

from . import config
from . import campaign
from .config import ENV_PATH, IGNORE_PATH, SOURCES_PATH, SPEAKERS_PATH, settings
from .kb import KINDS

# Поле настроек → переменная в .env. Секреты помечены отдельно: наружу уходит только «задан/не задан».
FIELDS = {
    "anthropic_api_key": "ANTHROPIC_API_KEY",
    "openai_api_key": "OPENAI_API_KEY",
    "gemini_api_key": "GEMINI_API_KEY",
    "deepseek_api_key": "DEEPSEEK_API_KEY",
    "openrouter_api_key": "OPENROUTER_API_KEY",
    "custom_api_key": "CUSTOM_API_KEY",
    "custom_base_url": "CUSTOM_BASE_URL",
    "custom_model": "CUSTOM_MODEL",
    "custom_name": "CUSTOM_NAME",
    "model_lore": "GMW_MODEL_LORE",
    "model_tactics": "GMW_MODEL_TACTICS",
    "model_fast": "GMW_MODEL_FAST",
    "openai_reasoning": "GMW_OPENAI_REASONING",
    "openai_reasoning_fast": "GMW_OPENAI_REASONING_FAST",
    "craig_inbox": "GMW_CRAIG_INBOX",
    "craig_auto": "GMW_CRAIG_AUTO",
    "whisper_model": "GMW_WHISPER_MODEL",
    "whisper_language": "GMW_WHISPER_LANGUAGE",
    "sessions_keep_days": "GMW_SESSIONS_KEEP_DAYS",
    "allowed_origins": "GMW_ALLOWED_ORIGINS",
}
SECRETS = {"anthropic_api_key", "openai_api_key", "gemini_api_key", "deepseek_api_key", "openrouter_api_key", "custom_api_key"}
REASONING = {"", "none", "low", "medium", "high"}

_KEY_RE = re.compile(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")


def _mask(value: str) -> dict:
    """Ключ наружу не отдаём — только факт наличия и хвост, чтобы отличить один ключ от другого."""
    v = (value or "").strip()
    return {"set": bool(v), "hint": ("…" + v[-4:]) if len(v) >= 12 else ""}


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def public() -> dict:
    """Всё, что показывает окно настроек. Секретов здесь нет."""
    speakers = {k: v for k, v in _read_json(SPEAKERS_PATH).items() if not k.startswith("_")}
    ignore = _read_json(IGNORE_PATH)
    return {
        "keys": {
            "anthropic": _mask(settings.anthropic_api_key),
            "openai": _mask(settings.openai_api_key),
            "gemini": _mask(settings.gemini_api_key),
            "deepseek": _mask(settings.deepseek_api_key),
            "openrouter": _mask(settings.openrouter_api_key),
            "custom": _mask(settings.custom_api_key),
        },
        "custom": {"base_url": settings.custom_base_url, "model": settings.custom_model, "name": settings.custom_name},
        "models": {"lore": settings.model_lore, "tactics": settings.model_tactics, "fast": settings.model_fast},
        "openai_reasoning": settings.openai_reasoning,
        "openai_reasoning_fast": settings.openai_reasoning_fast,
        "craig_inbox": settings.craig_inbox,
        "craig_inbox_exists": bool(settings.craig_inbox and Path(settings.craig_inbox).is_dir()),
        "craig_auto": settings.craig_auto,
        "whisper_model": os.getenv("GMW_WHISPER_MODEL", "large-v3-turbo"),
        "whisper_language": settings.whisper_language,
        "sessions_keep_days": settings.sessions_keep_days,
        "allowed_origins": settings.allowed_origins,
        "speakers": speakers,
        "ignore": {
            "voice": [str(x) for x in ignore.get("voice", ["kenku"])],
            "chat": [str(x) for x in ignore.get("chat", ["Подсказки"])],
        },
        "env_path": str(ENV_PATH),
        "campaign": campaign.load(),
    }


def source_rules() -> list[dict]:
    """Правила sources.json для модуля: по ним окно настроек подсказывает вид папки, пока мастер не задал его сам."""
    cfg = _read_json(SOURCES_PATH)
    out = []
    for r in cfg.get("rules", []):
        if isinstance(r, dict) and r.get("match"):
            kind = "exclude" if r.get("exclude") else str(r.get("source", "other"))
            if kind not in KINDS and kind != "exclude":
                kind = "rules" if "rule" in kind else "other"
            out.append({"match": r["match"], "kind": kind})
    return out


def write_env(changes: dict[str, str]) -> None:
    """Обновить переменные в .env: существующие строки заменяются на месте, новые дописываются в конец.
    Комментарии и незнакомые строки сохраняются; перевод строк — как в файле."""
    raw = ENV_PATH.read_bytes() if ENV_PATH.exists() else b""
    nl = "\r\n" if b"\r\n" in raw else "\n"
    lines = raw.decode("utf-8", errors="replace").splitlines()
    pending = dict(changes)
    for i, line in enumerate(lines):
        m = _KEY_RE.match(line)
        if m and m.group(1) in pending:
            key = m.group(1)
            lines[i] = f"{key}={pending.pop(key)}"
    if pending:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append("# Задано из окна «Настройки сервера» в Foundry.")
        lines.extend(f"{k}={v}" for k, v in pending.items())
    tmp = ENV_PATH.with_suffix(".env.tmp")
    tmp.write_bytes((nl.join(lines) + nl).encode("utf-8"))
    tmp.replace(ENV_PATH)
    for k, v in changes.items():
        os.environ[k] = v


def reload() -> None:
    """Перечитать .env и обновить объект settings на месте — все модули держат ссылку на него."""
    load_dotenv(ENV_PATH, override=True)
    fresh = config.Settings()
    settings.__dict__.update(fresh.__dict__)


def _env_value(field: str, value) -> str:
    if field == "craig_auto":
        return "1" if value in (True, 1, "1", "true", "yes") else "0"
    v = str(value if value is not None else "").strip()
    if field in ("openai_reasoning", "openai_reasoning_fast") and v not in REASONING:
        raise ValueError(f"Глубина размышлений: допустимы none / low / medium / high, получено «{v}»")
    if field == "craig_inbox":
        v = v.strip('"')
    if field == "custom_base_url":
        v = v.rstrip("/")
        if v and not re.match(r"^https?://", v):
            raise ValueError("Адрес API своего провайдера должен начинаться с http:// или https://")
    if field == "sessions_keep_days":
        try:
            v = str(max(0, int(float(v or 0))))
        except ValueError:
            raise ValueError("Срок хранения сессий — целое число дней (0 — не очищать)")
    if field == "whisper_language":
        v = (v or "ru").lower()
        if v != "auto" and not re.fullmatch(r"[a-z]{2,3}", v):
            raise ValueError("Язык расшифровки — код из двух букв (ru, en, uk…) или auto")
    if field.startswith("model_"):
        v = v or "auto"
    return v


def apply(body: dict) -> dict:
    """Принять изменения из окна настроек. Поля, которых нет в body (или None), не трогаются.
    Для ключей пустая строка = удалить ключ, непустая = записать новый."""
    env_changes: dict[str, str] = {}
    for field, var in FIELDS.items():
        if field not in body or body[field] is None:
            continue
        env_changes[var] = _env_value(field, body[field])
    if env_changes:
        write_env(env_changes)
        reload()

    if isinstance(body.get("speakers"), dict):
        cur = _read_json(SPEAKERS_PATH)
        keep = {k: v for k, v in cur.items() if k.startswith("_")}
        clean = {str(k).strip(): str(v).strip() for k, v in body["speakers"].items() if str(k).strip()}
        _write_json(SPEAKERS_PATH, {**keep, **clean})

    if isinstance(body.get("campaign"), dict):
        campaign.save(body["campaign"])

    if isinstance(body.get("ignore"), dict):
        cur = _read_json(IGNORE_PATH)
        keep = {k: v for k, v in cur.items() if k.startswith("_")}
        out = {}
        for part in ("voice", "chat"):
            vals = body["ignore"].get(part, cur.get(part, []))
            if isinstance(vals, str):
                vals = re.split(r"[,\n;]+", vals)
            out[part] = sorted({str(x).strip() for x in vals if str(x).strip()})
        _write_json(IGNORE_PATH, {**keep, **out})

    return public()
