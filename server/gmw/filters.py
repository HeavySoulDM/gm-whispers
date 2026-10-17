"""Что не учитывать в итогах: музыкальные боты в записи голоса и служебные сообщения модулей в чате.

Список в server/config/ignore.json — совпадение по части имени, регистр не важен.
"""

from __future__ import annotations

import json

from .config import IGNORE_PATH
DEFAULT = {"voice": ["kenku"], "chat": ["Подсказки"]}


def load_ignore() -> dict:
    try:
        data = json.loads(IGNORE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return dict(DEFAULT)
    return {k: [str(x) for x in data.get(k, []) if str(x).strip()] for k in ("voice", "chat")}


def _match(names, patterns: list[str]) -> bool:
    for name in names:
        n = (name or "").casefold()
        if n and any(p.casefold() in n for p in patterns):
            return True
    return False


def voice_ignored(*names: str, ignore: dict | None = None) -> bool:
    """Дорожка или реплика голоса от бота (музыка и т. п.)."""
    return _match(names, (ignore or load_ignore())["voice"])


def chat_ignored(who: str, ignore: dict | None = None) -> bool:
    """Сообщение чата от служебного «говорящего» (подсказки модулей и т. п.)."""
    return _match([who], (ignore or load_ignore())["chat"])
