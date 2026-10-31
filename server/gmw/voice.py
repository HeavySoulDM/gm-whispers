"""Распознавание речи на компьютере мастера: что установлено и установка из Foundry.

Сам движок (faster-whisper, CPU) входит в сборку.
- Модель распознавания пользователь кладёт сам в data/models/faster-whisper-<имя>/ (0,5–3 ГБ, см. MODELS):
  автоматическую закачку убрали (решение Di 31.10) — Hugging Face и зеркала из России не отдают большие файлы,
  а полуживая кнопка хуже честной инструкции. Настройки показывают путь к папке и ссылку.
- Библиотеки CUDA для ускорения на видеокарте NVIDIA докачиваются по кнопке: data/cuda/nvidia/<cublas|cudnn>/bin/*.dll
  (~1,3 ГБ; колёса с PyPI — files.pythonhosted.org доступен — распаковываются без pip, для exe и для исходников).

Одна задача за раз; ход — в status()["job"], панель опрашивает GET /voice/status.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
import zipfile
from pathlib import Path

from .config import DATA_DIR

MODELS_DIR = DATA_DIR / "models"
CUDA_DIR = DATA_DIR / "cuda"
MODEL_FILES = ["config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.*"]

# Каталог моделей: имя → репозиторий Hugging Face, размер, пояснение. Порядок — как показывать в списке.
MODELS = [
    {"name": "small", "repo": "Systran/faster-whisper-small", "gb": 0.5,
     "ru": "Быстрая, качество заметно ниже — для слабого компьютера без видеокарты, если ждать часами не хочется.",
     "en": "Fast, noticeably lower quality — for a weak computer without a GPU when you don't want to wait for hours."},
    {"name": "medium", "repo": "Systran/faster-whisper-medium", "gb": 1.5,
     "ru": "Середина: качество приличное, на процессоре примерно вдвое быстрее turbo.",
     "en": "Middle ground: decent quality, roughly twice as fast as turbo on the CPU."},
    {"name": "large-v3-turbo", "repo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo", "gb": 1.6, "default": True,
     "ru": "Рекомендуется: качество почти как у large-v3, в несколько раз быстрее. Для видеокарты и для процессора.",
     "en": "Recommended: quality close to large-v3, several times faster. Good for both GPU and CPU."},
    {"name": "large-v3", "repo": "Systran/faster-whisper-large-v3", "gb": 3.1,
     "ru": "Максимальное качество, вдвое медленнее turbo. Имеет смысл только с видеокартой NVIDIA.",
     "en": "Best quality, twice as slow as turbo. Only worth it with an NVIDIA GPU."},
]
DEFAULT_MODEL = "large-v3-turbo"
CUDA_GB = 1.3

# Колёса NVIDIA с PyPI: пакет → ограничение версии и подпапки с DLL внутри (nvidia/<sub>/bin).
CUDA_PACKAGES = [
    ("nvidia-cublas-cu12", "12.", "cublas"),
    ("nvidia-cudnn-cu12", "9.", "cudnn"),
]

_lock = threading.Lock()
_job: dict | None = None   # {"state": running|done|error, "step": model|cuda, "pct", "done_mb", "total_mb", "message", "model", "cuda"}


# ---------------------------------------------------------------- что есть


def model_info(name: str) -> dict:
    for m in MODELS:
        if m["name"] == name:
            return m
    return {"name": name, "repo": f"Systran/faster-whisper-{name}", "gb": 1.5, "ru": "", "en": ""}


def model_dir(name: str) -> Path:
    return MODELS_DIR / f"faster-whisper-{name}"


def model_installed(name: str) -> bool:
    d = model_dir(name)
    return (d / "model.bin").exists() and (d / "config.json").exists()


def engine_available() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:  # noqa: BLE001 — не только ImportError: битая установка тоже «нет»
        return False


_gpu_cache: bool | None = None


def gpu_present() -> bool:
    """Есть ли видеокарта NVIDIA с драйвером (nvidia-smi ставится вместе с драйвером). Проверяется один раз."""
    global _gpu_cache
    if _gpu_cache is None:
        _gpu_cache = _detect_gpu()
    return _gpu_cache


def _detect_gpu() -> bool:
    if os.name != "nt" and not shutil.which("nvidia-smi"):
        return False
    exe = shutil.which("nvidia-smi") or (Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "nvidia-smi.exe")
    if not exe or not Path(exe).exists():
        return False
    try:
        out = subprocess.run([str(exe), "-L"], capture_output=True, text=True, timeout=8,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return out.returncode == 0 and "GPU" in out.stdout
    except (OSError, subprocess.SubprocessError):
        return False


def cuda_dirs() -> list[Path]:
    """Папки с DLL CUDA: скачанные в data/cuda и установленные pip в окружение (setup.bat старых версий)."""
    out = []
    for base in [CUDA_DIR, *[Path(p) for p in sys.path]]:
        nv = base / "nvidia"
        if not nv.is_dir():
            continue
        for sub in ("cublas", "cudnn", "cuda_runtime", "cuda_nvrtc"):
            b = nv / sub / "bin"
            if b.is_dir() and any(b.glob("*.dll")):
                out.append(b)
    return out


def cuda_installed() -> bool:
    have = {d.parent.name for d in cuda_dirs()}
    return {"cublas", "cudnn"} <= have


def current_model() -> str:
    return os.getenv("GMW_WHISPER_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL


def status() -> dict:
    gpu = gpu_present()
    cuda = cuda_installed()
    cur = current_model()
    return {
        "modelsDir": str(MODELS_DIR),
        "available": engine_available(),
        "gpu": gpu,
        "cuda": cuda,
        "cudaGb": CUDA_GB,
        "device": "cuda" if (gpu and cuda) else "cpu",
        "cpuThreads": os.cpu_count() or 1,
        "model": cur,
        "modelInstalled": model_installed(cur),
        "models": [{"name": m["name"], "gb": m["gb"], "installed": model_installed(m["name"]), "repo": m["repo"],
                    "dir": str(model_dir(m["name"])), "default": m.get("default", False), "ru": m["ru"], "en": m["en"]} for m in MODELS],
        "job": dict(_job) if _job else None,
    }


# ---------------------------------------------------------------- установка


def _set(**kw) -> None:
    if _job is not None:
        _job.update(kw)


def missing_model_message(name: str) -> str:
    """Что делать, если модели нет: куда положить файлы и откуда их взять."""
    info = model_info(name)
    return (
        f"Модель распознавания «{name}» не найдена. Положи её файлы в папку:\n  {model_dir(name)}\n"
        f"Скачать: https://huggingface.co/{info['repo']}/tree/main — нужны config.json, preprocessor_config.json, "
        f"model.bin, tokenizer.json и vocabulary.json (или vocabulary.txt). Если Hugging Face не открывается — через VPN. "
        f"Потом нажми «Проверить» в Foundry: ⚙ → Транскрибация."
    )


def _pypi_wheel(package: str, version_prefix: str) -> tuple[str, str, int]:
    """Адрес последнего колеса win_amd64 пакета с PyPI: (версия, url, размер)."""
    import httpx

    data = httpx.get(f"https://pypi.org/pypi/{package}/json", timeout=30, follow_redirects=True).json()
    versions = sorted((v for v in data["releases"] if v.startswith(version_prefix) and data["releases"][v]),
                      key=lambda v: [int(x) if x.isdigit() else 0 for x in v.split(".")], reverse=True)
    for v in versions:
        for f in data["releases"][v]:
            if f["filename"].endswith("win_amd64.whl") and not f.get("yanked"):
                return v, f["url"], int(f.get("size") or 0)
    raise RuntimeError(f"На PyPI нет колеса {package} {version_prefix}* для Windows")


def _download(url: str, dst: Path, size: int, base_mb: int, total_mb: int, log=print, attempts: int = 5) -> None:
    """Скачать файл с докачкой после обрыва (Range)."""
    import httpx

    part = dst.with_suffix(dst.suffix + ".part")
    last = None
    for attempt in range(1, attempts + 1):
        have = part.stat().st_size if part.exists() else 0
        headers = {"Range": f"bytes={have}-"} if have else {}
        try:
            with httpx.stream("GET", url, headers=headers, timeout=60, follow_redirects=True) as r:
                if r.status_code == 416:  # уже всё скачано
                    break
                if r.status_code not in (200, 206):
                    raise RuntimeError(f"HTTP {r.status_code}")
                mode = "ab" if r.status_code == 206 else "wb"
                if mode == "wb":
                    have = 0
                with open(part, mode) as f:
                    for chunk in r.iter_bytes(1 << 20):
                        f.write(chunk)
                        have += len(chunk)
                        done_mb = base_mb + have // (1024 * 1024)
                        _set(done_mb=done_mb, pct=min(99, int(done_mb * 100 / max(1, total_mb))))
            if size and have < size:
                raise RuntimeError(f"обрыв: {have} из {size} байт")
            break
        except Exception as e:  # noqa: BLE001
            last = e
            log(f"   попытка {attempt}/{attempts} ({dst.name}): {str(e)[:200]}")
            time.sleep(min(30, 5 * attempt))
    else:
        raise RuntimeError(f"Не удалось скачать {url}: {last}")
    part.replace(dst)


def install_cuda(log=print) -> None:
    """Скачать cuBLAS и cuDNN (колёса PyPI) и распаковать DLL в data/cuda/nvidia/<sub>/bin."""
    if cuda_installed():
        return
    if os.name != "nt":
        raise RuntimeError("Докачка библиотек CUDA поддерживается только на Windows; на Linux установи пакеты nvidia-cublas-cu12 и nvidia-cudnn-cu12 через pip.")
    CUDA_DIR.mkdir(parents=True, exist_ok=True)
    plan = []
    for package, prefix, sub in CUDA_PACKAGES:
        v, url, size = _pypi_wheel(package, prefix)
        plan.append((package, v, url, size, sub))
    total_mb = max(1, sum(p[3] for p in plan) // (1024 * 1024))
    _set(step="cuda", pct=0, done_mb=0, total_mb=total_mb, message="Скачиваю библиотеки CUDA для видеокарты")
    base = 0
    for package, v, url, size, sub in plan:
        wheel = CUDA_DIR / f"{package}-{v}.whl"
        log(f"Скачиваю {package} {v} ({size // (1024 * 1024)} МБ) …")
        if not wheel.exists():
            _download(url, wheel, size, base, total_mb, log)
        base += size // (1024 * 1024)
        dst = CUDA_DIR / "nvidia" / sub / "bin"
        dst.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(wheel) as z:
            for name in z.namelist():
                if name.startswith(f"nvidia/{sub}/bin/") and name.lower().endswith(".dll"):
                    (dst / Path(name).name).write_bytes(z.read(name))
        wheel.unlink(missing_ok=True)
        log(f"   распаковано в {dst}")
    if not cuda_installed():
        raise RuntimeError("Библиотеки скачаны, но нужных DLL не нашлось — пришли лог в issues.")
    log("Библиотеки CUDA установлены.")


def add_cuda_dlls() -> None:
    """Добавить DLL CUDA (из data/cuda и из pip-пакетов) в путь поиска — перед загрузкой модели на видеокарту."""
    if os.name != "nt":
        return
    for b in cuda_dirs():
        try:
            os.add_dll_directory(str(b))
        except OSError:
            pass
        os.environ["PATH"] = str(b) + os.pathsep + os.environ.get("PATH", "")


def start_install(cuda: bool) -> dict:
    """Запустить докачку библиотек CUDA в фоне (модели пользователь кладёт в data/models сам). Одна задача за раз."""
    global _job
    with _lock:
        if _job and _job["state"] == "running":
            return {"started": False, "message": "Установка уже идёт.", "job": dict(_job)}
        if not cuda or cuda_installed():
            return {"started": False, "message": "Всё уже установлено.", "job": None}
        if not engine_available():
            raise RuntimeError("В этой сборке нет движка распознавания (faster-whisper). Для установки из исходников запусти server\\setup.bat.")
        _job = {"state": "running", "step": "cuda", "pct": 0, "done_mb": 0, "total_mb": 0, "message": "Начинаю",
                "cuda": True, "started": int(time.time() * 1000)}
        threading.Thread(target=_run, daemon=True).start()
        return {"started": True, "job": dict(_job)}


def open_models_dir() -> str:
    """Открыть папку моделей в проводнике (Windows); возвращает путь."""
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        os.startfile(str(MODELS_DIR))  # noqa: S606 — локальная папка, запрос только с кодом доступа
    return str(MODELS_DIR)


def _run() -> None:
    log_path = DATA_DIR / "logs" / "voice-install.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "a", encoding="utf-8") as lf:
        def log(msg: str) -> None:
            line = f"{time.strftime('%H:%M:%S')} {msg}"
            print("[voice] " + msg, flush=True)
            lf.write(line + "\n")
            lf.flush()

        try:
            install_cuda(log)
            _set(state="done", pct=100, message="Готово", finished=int(time.time() * 1000))
        except Exception as e:  # noqa: BLE001
            log(f"ОШИБКА: {e}")
            _set(state="error", message=str(e)[:400], finished=int(time.time() * 1000))
