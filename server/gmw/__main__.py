"""Запуск: python -m gmw (консоль, start.bat), python -m gmw --tray (значок в трее, без окна),
python -m gmw --transcribe <архив> (то же, что -m gmw.transcribe; нужно собранному exe)."""

import sys

from . import __version__
from .config import settings
from .llm import has_key, model_for


def banner() -> None:
    lore = model_for("lore")
    auto = " (авто)" if settings.model_lore.lower() == "auto" else ""
    print("=" * 60)
    print(f" GM Whispers Core {__version__}")
    print(f" Адрес для модуля Foundry: http://{settings.host}:{settings.port}")
    print(f" Локальный токен:          {settings.local_token}")
    print(f" Модели{auto}: лор={lore} · тактика={model_for('tactics')} · фон={model_for('fast')}")
    if not has_key(lore):
        print(" ВНИМАНИЕ: ключ API не задан — впиши его в Foundry: панель GM Whispers → «Настройки сервера».")
    print(" Остановить: Ctrl+C")
    print("=" * 60)


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["--transcribe"]:
        from .transcribe import main as transcribe_main

        return transcribe_main(argv[1:])
    from .config import FROZEN

    if argv[:1] == ["--tray"] or (FROZEN and not argv):
        try:
            from .tray import run_tray
        except ImportError as e:
            print(f"Режим трея недоступен ({e}); запускаю в консоли. Установить: pip install pystray pillow")
        else:
            return run_tray()
    import uvicorn

    banner()
    uvicorn.run("gmw.app:app", host=settings.host, port=settings.port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
