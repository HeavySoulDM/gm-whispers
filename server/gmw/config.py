"""Настройки сервера: читаются из server/.env.

Секреты (ключ Claude, токен Discord) живут только в .env и никуда не передаются,
кроме самих сервисов Anthropic и Discord.
"""

from __future__ import annotations

import os
import secrets
import sys
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

FROZEN = bool(getattr(sys, "frozen", False))  # собрано в exe (PyInstaller): данные лежат рядом с exe
SERVER_DIR = Path(sys.executable).resolve().parent if FROZEN else Path(__file__).resolve().parent.parent
ROOT_DIR = SERVER_DIR.parent
DATA_DIR = ROOT_DIR / "data"
ENV_PATH = SERVER_DIR / ".env"
SOURCES_PATH = SERVER_DIR / "config" / "sources.json"
SPEAKERS_PATH = SERVER_DIR / "config" / "speakers.json"
IGNORE_PATH = SERVER_DIR / "config" / "ignore.json"

load_dotenv(ENV_PATH, override=False)


def _ensure_local_token() -> str:
    """Токен, которым модуль Foundry подтверждает, что говорит именно он.

    Если в .env его нет — генерируем и дописываем в конец файла.
    """
    token = os.getenv("GMW_LOCAL_TOKEN", "").strip()
    if token:
        return token
    token = secrets.token_urlsafe(24)
    try:
        with open(ENV_PATH, "a", encoding="utf-8") as f:
            f.write(
                "\n# Локальный токен для модуля Foundry (вставить в настройки модуля GM Whispers).\n"
                f"GMW_LOCAL_TOKEN={token}\n"
            )
    except OSError:
        pass
    os.environ["GMW_LOCAL_TOKEN"] = token
    return token


@dataclass
class Settings:
    host: str = field(default_factory=lambda: os.getenv("GMW_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(os.getenv("GMW_PORT", "8765")))
    local_token: str = field(default_factory=_ensure_local_token)

    anthropic_api_key: str = field(default_factory=lambda: os.getenv("ANTHROPIC_API_KEY", "").strip())
    openai_api_key: str = field(default_factory=lambda: os.getenv("OPENAI_API_KEY", "").strip())
    gemini_api_key: str = field(default_factory=lambda: os.getenv("GEMINI_API_KEY", "").strip())
    deepseek_api_key: str = field(default_factory=lambda: os.getenv("DEEPSEEK_API_KEY", "").strip())
    openrouter_api_key: str = field(default_factory=lambda: os.getenv("OPENROUTER_API_KEY", "").strip())
    # Свой провайдер, совместимый с OpenAI API (RouterAI и т. п.): адрес, ключ, модель по умолчанию.
    custom_api_key: str = field(default_factory=lambda: os.getenv("CUSTOM_API_KEY", "").strip())
    custom_base_url: str = field(default_factory=lambda: os.getenv("CUSTOM_BASE_URL", "").strip().rstrip("/"))
    custom_model: str = field(default_factory=lambda: os.getenv("CUSTOM_MODEL", "").strip())
    custom_name: str = field(default_factory=lambda: os.getenv("CUSTOM_NAME", "").strip())
    # Глубина «размышлений» моделей OpenAI: none (только у luna) / low / medium / high. Пусто — по умолчанию модели.
    openai_reasoning: str = field(default_factory=lambda: os.getenv("GMW_OPENAI_REASONING", "low").strip())
    # Для быстрого режима (модель GMW_MODEL_FAST). "none" поддерживает gpt-6-luna.
    openai_reasoning_fast: str = field(default_factory=lambda: os.getenv("GMW_OPENAI_REASONING_FAST", "none").strip())

    # Модель для каждой роли (меняется в окне «Настройки сервера» или в .env).
    # claude-… → Claude API, gpt-… → OpenAI. «auto» — подобрать по тому, какой ключ задан (см. llm.DEFAULT_MODELS).
    model_lore: str = field(default_factory=lambda: os.getenv("GMW_MODEL_LORE", "auto").strip() or "auto")
    model_tactics: str = field(default_factory=lambda: os.getenv("GMW_MODEL_TACTICS", "auto").strip() or "auto")
    model_fast: str = field(default_factory=lambda: os.getenv("GMW_MODEL_FAST", "auto").strip() or "auto")

    # Папка, куда облако (Google Drive / Dropbox / OneDrive) синхронизирует записи Craig. Пусто — не следить.
    craig_inbox: str = field(default_factory=lambda: os.getenv("GMW_CRAIG_INBOX", "").strip().strip('"'))
    # 1 — проверять папку самому раз в минуту; по умолчанию запись забирается по кнопке в «Итогах».
    craig_auto: bool = field(default_factory=lambda: os.getenv("GMW_CRAIG_AUTO", "0").strip() in ("1", "true", "yes"))

    # Язык распознавания речи (код ISO: ru, en, uk…; auto — определить по записи).
    whisper_language: str = field(default_factory=lambda: os.getenv("GMW_WHISPER_LANGUAGE", "ru").strip() or "ru")
    # Старые сессии (журнал событий, расшифровка) через N дней упаковываются в data/archive/<id>.zip. 0 — не трогать.
    sessions_keep_days: int = field(default_factory=lambda: int(os.getenv("GMW_SESSIONS_KEEP_DAYS", "0") or 0))
    # Дополнительные origin (хостинг Foundry вроде forge-vtt.com), через запятую. localhost разрешён всегда.
    allowed_origins: str = field(default_factory=lambda: os.getenv("GMW_ALLOWED_ORIGINS", "").strip())

    discord_bot_token: str = field(default_factory=lambda: os.getenv("DISCORD_BOT_TOKEN", "").strip())
    discord_guild_id: str = field(default_factory=lambda: os.getenv("DISCORD_GUILD_ID", "").strip())
    discord_voice_channel_id: str = field(default_factory=lambda: os.getenv("DISCORD_TEST_VOICE_CHANNEL_ID", "").strip())
    discord_owner_id: str = field(default_factory=lambda: os.getenv("DISCORD_OWNER_ID", "").strip())

    @property
    def kb_dir(self) -> Path:
        return DATA_DIR / "kb"

    @property
    def logs_dir(self) -> Path:
        return DATA_DIR / "logs"


settings = Settings()
