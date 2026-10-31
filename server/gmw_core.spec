# -*- mode: python -*-
# Сборка GM Whispers Core в папку с exe (PyInstaller). Запуск: tools\build_exe.bat (или GitHub Actions по тегу).
# Результат: server\dist\GM Whispers Core\ — внутри GM Whispers Core.exe и папка _internal.
# Рядом с exe при первом запуске появятся .env (с кодом доступа) и config\sources.json; данные — в ..\data\.
# Внутри: сервер и движок распознавания речи (faster-whisper на процессоре). Модель (0,5–3 ГБ) и библиотеки CUDA
# для видеокарты NVIDIA (~1 ГБ) в exe не входят — их докачивает сервер по кнопке в Foundry (gmw/voice.py).
from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

hidden = collect_submodules("gmw") + ["uvicorn.logging", "uvicorn.loops.auto", "uvicorn.protocols.http.auto",
                                      "uvicorn.protocols.websockets.auto", "uvicorn.lifespan.on"]
datas = [("config/sources.json", "config"), (".env.example", ".")] + collect_data_files("snowballstemmer")
binaries = []
for pkg in ("faster_whisper", "ctranslate2", "onnxruntime", "av", "tokenizers", "huggingface_hub"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hidden += h

a = Analysis(["gmw/__main__.py"], pathex=["."], hiddenimports=hidden, datas=datas, binaries=binaries,
             excludes=["torch", "tkinter", "pystray", "PIL", "matplotlib", "IPython"])
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="GM Whispers Core", console=True, icon=None)
coll = COLLECT(exe, a.binaries, a.datas, name="GM Whispers Core")
