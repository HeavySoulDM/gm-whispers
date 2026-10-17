# -*- mode: python -*-
# Сборка GM Whispers Core в папку с exe (PyInstaller). Запуск: tools\build_exe.bat
# Результат: server\dist\GM Whispers Core\GM Whispers Core.exe — рядом с ним .env, config\, data\.
# faster-whisper и библиотеки CUDA в сборку не входят (слишком большие): расшифровка в exe-версии
# берёт готовый transcription.vtt от Craig; локальное распознавание — из обычной установки (setup_audio.bat).
import os
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

hidden = collect_submodules("gmw") + ["uvicorn.logging", "uvicorn.loops.auto", "uvicorn.protocols.http.auto",
                                      "uvicorn.protocols.websockets.auto", "uvicorn.lifespan.on", "pystray._win32"]
datas = [("config/sources.json", "config"), ("config/speakers.json", "config"), ("config/ignore.json", "config"),
         (".env.example", ".")] + collect_data_files("snowballstemmer")

a = Analysis(["gmw/__main__.py"], pathex=["."], hiddenimports=hidden, datas=datas,
             excludes=["faster_whisper", "ctranslate2", "torch", "av", "huggingface_hub", "tkinter"])
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="GM Whispers Core", console=False, icon=None)
coll = COLLECT(exe, a.binaries, a.datas, name="GM Whispers Core")
