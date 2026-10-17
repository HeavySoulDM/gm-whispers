"""Режим «в трее»: сервер работает без консольного окна, значок в области уведомлений Windows.

Запуск: pythonw -m gmw --tray (start_quiet.vbs / автозагрузка). Если pystray или Pillow не установлены —
__main__ запускает обычный консольный режим.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import webbrowser

from . import __version__
from .config import DATA_DIR, ENV_PATH, SERVER_DIR, settings


def _icon_image():
    from PIL import Image, ImageDraw

    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((4, 4, 60, 60), fill=(32, 30, 40, 255), outline=(185, 164, 106, 255), width=4)
    # шляпа волшебника: конус и поля
    d.polygon([(32, 12), (20, 42), (44, 42)], fill=(185, 164, 106, 255))
    d.ellipse((14, 38, 50, 48), fill=(185, 164, 106, 255))
    return img


def _open_folder(path) -> None:
    try:
        if sys.platform == "win32":
            os.startfile(str(path))  # noqa: S606
        else:
            subprocess.Popen(["xdg-open", str(path)])
    except OSError:
        pass


def run_tray() -> int:
    import pystray
    import uvicorn

    url = f"http://{settings.host}:{settings.port}"
    config = uvicorn.Config("gmw.app:app", host=settings.host, port=settings.port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, name="gmw-server", daemon=True)
    thread.start()

    def quit_(icon, _item=None):
        server.should_exit = True
        thread.join(timeout=10)
        icon.stop()

    menu = pystray.Menu(
        pystray.MenuItem(f"GM Whispers Core {__version__} — {url}", lambda *_: webbrowser.open(url), default=True),
        pystray.MenuItem("Открыть папку данных (журналы, сессии)", lambda *_: _open_folder(DATA_DIR)),
        pystray.MenuItem("Открыть папку настроек (.env)", lambda *_: _open_folder(ENV_PATH.parent)),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Выход", quit_),
    )
    icon = pystray.Icon("gm-whispers", _icon_image(), f"GM Whispers Core — {url}", menu)
    icon.run()
    return 0
