"""Папка-«входящие» для записей Craig.

Craig умеет сам выгружать запись в Google Drive / Dropbox / OneDrive (облачная копия в настройках
my.craig.chat). Приложение облака синхронизирует её на этот ПК, а сервер забирает каждый новый zip
в нужную сессию по кнопке в «Итогах» (или сам раз в минуту, если включено автонаблюдение):
готовую расшифровку Craig берёт как есть, иначе распознаёт на видеокарте.

Все обходы папки идут в отдельном потоке и кэшируются (CANDIDATES_TTL), чтобы опрос из панели
не нагружал диск и не блокировал сервер.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
import zipfile
from collections import deque
from pathlib import Path

from .config import DATA_DIR, FROZEN, SERVER_DIR

STATE_PATH = DATA_DIR / "craig_inbox.json"
SCAN_SECONDS = 60          # автонаблюдение: как часто смотреть в папку
CANDIDATES_TTL = 30.0      # с: результат обхода папки переиспользуется для частых опросов из панели
PROCESS_TIMEOUT = 4 * 3600  # с: дольше этого расшифровка считается зависшей и прерывается
MAX_JOBS = 50
MAX_CACHE = 500

AUDIO_EXT = (".flac", ".ogg", ".opus", ".m4a", ".aac", ".mp3", ".wav")
_zip_cache: dict[str, tuple[int, float, bool]] = {}  # путь → (размер, mtime, похож ли на запись Craig)


def is_craig_zip(p: Path) -> bool:
    """Архив похож на запись Craig: внутри info.txt «Recording …» или аудиодорожки. Чужие zip пропускаем.
    Читается только список файлов и первые байты info.txt, не сам архив."""
    try:
        st = p.stat()
    except OSError:
        return False
    cached = _zip_cache.get(str(p))
    if cached and cached[0] == st.st_size and cached[1] == st.st_mtime:
        return cached[2]
    ok = False
    try:
        with zipfile.ZipFile(p) as z:
            names = z.namelist()
            if "info.txt" in names:
                ok = z.read("info.txt")[:200].decode("utf-8", errors="ignore").startswith("Recording")
            if not ok:
                ok = sum(1 for n in names if n.lower().endswith(AUDIO_EXT)) >= 1 and len(names) <= 64
    except (zipfile.BadZipFile, OSError):
        return False  # ещё докачивается или не zip — не кэшируем, проверим в следующий раз
    if len(_zip_cache) >= MAX_CACHE:
        _zip_cache.pop(next(iter(_zip_cache)))
    _zip_cache[str(p)] = (st.st_size, st.st_mtime, ok)
    return ok


class CraigInbox:
    def __init__(self, path: str, auto: bool = False):
        self.path = Path(path) if path else None
        self.auto = auto
        self.jobs: deque[dict] = deque(maxlen=MAX_JOBS)
        self.state = self._load_state()
        self._seen_size: dict[str, tuple[int, float]] = {}
        self._task: asyncio.Task | None = None
        self._task_sync: asyncio.Task | None = None
        self._cand: tuple[float, list[Path]] | None = None

    # ---------------------------------------------------------------- состояние

    def _load_state(self) -> dict:
        try:
            st = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            st = {}
        # Старые записи в облачной папке при первом включении не трогаем.
        st.setdefault("since", time.time() if not os.getenv("GMW_CRAIG_INBOX_ALL") else 0)
        st.setdefault("done", {})
        return st

    def _save_state(self) -> None:
        try:
            STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
            STATE_PATH.write_text(json.dumps(self.state, ensure_ascii=False, indent=1), encoding="utf-8")
        except OSError as e:
            print(f"[craig] не удалось сохранить состояние: {e}")

    @property
    def enabled(self) -> bool:
        return bool(self.path)

    @property
    def running(self) -> dict | None:
        return next((j for j in self.jobs if j["state"] == "running"), None)

    def status(self) -> dict:
        return {
            "enabled": self.enabled,
            "auto": self.auto,
            "path": str(self.path) if self.path else None,
            "exists": bool(self.path and self.path.exists()),
            "jobs": list(self.jobs)[-5:],
        }

    # ---------------------------------------------------------------- запуск и перенастройка

    def start(self) -> None:
        if not self.enabled:
            return
        self._save_state()
        if self.auto:
            if self._task is None or self._task.done():
                self._task = asyncio.create_task(self._loop())
            print(f"[craig] слежу за папкой {self.path} (проверка раз в минуту)")
        else:
            print(f"[craig] папка записей: {self.path} (забираются по кнопке в «Итогах»)")

    def configure(self, path: str, auto: bool) -> None:
        """Применить новые настройки без перезапуска сервера."""
        new_path = Path(path) if path else None
        if new_path != self.path:
            self.path = new_path
            self._cand = None
            self._seen_size.clear()
        self.auto = auto
        if not auto and self._task and not self._task.done():
            self._task.cancel()
            self._task = None
        if self.enabled:
            self.start()

    # ---------------------------------------------------------------- поиск новых записей

    def _imported_names(self) -> set[str]:
        """Имена архивов, уже лежащих в расшифровках сессий (в т. ч. импортированные вручную через transcribe.bat)."""
        names: set[str] = set()
        for tr in (DATA_DIR / "sessions").glob("*/transcript.json"):
            try:
                src = json.loads(tr.read_text(encoding="utf-8")).get("source") or ""
            except (OSError, ValueError):
                continue
            if ":" in src:
                names.add(src.split(":", 1)[1])
        return names

    def _scan_dir(self) -> list[Path]:
        """Обход папки (дисковые операции). Вызывать только из потока."""
        if not self.path or not self.path.exists():
            return []
        imported = self._imported_names()
        out = []
        for p in self.path.rglob("*.zip"):
            try:
                st = p.stat()
            except OSError:
                continue
            if st.st_mtime < self.state["since"]:
                continue
            if f"{p.name}|{st.st_size}" in self.state["done"] or p.name in imported:
                continue
            if not is_craig_zip(p):
                continue
            out.append((st.st_mtime, p))
        return [p for _, p in sorted(out)]

    async def candidates(self, fresh: bool = False) -> list[Path]:
        """Новые записи. Результат живёт CANDIDATES_TTL секунд, чтобы частые опросы не трогали диск."""
        if not fresh and self._cand and time.time() - self._cand[0] < CANDIDATES_TTL:
            return self._cand[1]
        files = await asyncio.to_thread(self._scan_dir)
        self._cand = (time.time(), files)
        return files

    def invalidate(self) -> None:
        self._cand = None

    async def pending(self, fresh: bool = False) -> list[dict]:
        out = []
        for p in await self.candidates(fresh):
            try:
                st = p.stat()
            except OSError:
                continue
            out.append({"file": p.name, "size": st.st_size, "mtime": int(st.st_mtime * 1000)})
        return out

    # ---------------------------------------------------------------- обработка

    async def sync(self) -> dict:
        """Забрать все новые записи (в фоне, по очереди). Ход — в status()['jobs']."""
        if self.running:
            return {"started": False, "message": "Обработка уже идёт."}
        files = await self.candidates(fresh=True)
        if not files:
            return {"started": False, "message": "Новых записей Craig в папке нет."}
        self._task_sync = asyncio.create_task(self._sync_all(files))
        return {"started": True, "files": [p.name for p in files]}

    async def _sync_all(self, files: list[Path]) -> None:
        for p in files:
            try:
                # Если облако ещё докачивает файл — подождём, пока размер перестанет меняться.
                for _ in range(60):
                    a = p.stat().st_size
                    await asyncio.sleep(3)
                    if p.stat().st_size == a:
                        break
                await self.process(p, f"{p.name}|{p.stat().st_size}")
            except Exception as e:  # noqa: BLE001 — файл исчез/переименован облаком и т. п.
                self.jobs.append({"file": p.name, "state": "error", "started": int(time.time() * 1000),
                                  "finished": int(time.time() * 1000), "session": None, "message": f"{type(e).__name__}: {e}"})
                print(f"[craig] ошибка: {p.name}: {e}")
        self.invalidate()

    async def _loop(self) -> None:
        while True:
            try:
                await self.scan()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                print(f"[craig] ошибка проверки папки: {e}")
            await asyncio.sleep(SCAN_SECONDS)

    async def scan(self) -> None:
        if self.running:
            return
        for p in await self.candidates(fresh=True):
            try:
                st = p.stat()
            except OSError:
                continue
            prev = self._seen_size.get(str(p))
            self._seen_size[str(p)] = (st.st_size, st.st_mtime)
            if len(self._seen_size) > MAX_CACHE:
                self._seen_size.pop(next(iter(self._seen_size)))
            # Файл ещё докачивается облаком — ждём, пока размер перестанет меняться.
            if prev != (st.st_size, st.st_mtime):
                continue
            await self.process(p, f"{p.name}|{st.st_size}")
            return  # по одному за проход: видеокарта одна

    async def process(self, path: Path, key: str) -> None:
        job = {"file": path.name, "state": "running", "started": int(time.time() * 1000), "session": None, "message": "",
               "progress": {"phase": "start", "pct": 0, "at": int(time.time() * 1000)}}
        self.jobs.append(job)
        safe_stem = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in path.stem)[:80]
        log_path = DATA_DIR / "logs" / f"craig-{safe_stem}.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        print(f"[craig] новая запись: {path.name} → обрабатываю (лог: {log_path.name})")
        env = {**os.environ, "PYTHONIOENCODING": "utf-8", "GMW_PROGRESS_JSON": "1"}

        def run() -> tuple[int, dict | None]:
            # Обычный процесс в потоке: на Windows асинхронные подпроцессы работают не со всеми циклами событий.
            result = None
            deadline = time.time() + PROCESS_TIMEOUT
            with open(log_path, "w", encoding="utf-8") as log:
                proc = subprocess.Popen(
                    [sys.executable, "--transcribe", str(path)] if FROZEN else [sys.executable, "-m", "gmw.transcribe", str(path)],
                    cwd=str(SERVER_DIR), env=env,
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                assert proc.stdout is not None
                try:
                    for raw in proc.stdout:
                        if time.time() > deadline:
                            proc.kill()
                            job["message"] = f"расшифровка не закончилась за {PROCESS_TIMEOUT // 3600} ч — прервана"
                            break
                        line = raw.decode("utf-8", errors="ignore").rstrip()
                        if line.startswith("GMW_PROGRESS "):
                            # Прогресс распознавания — в статус задачи (его показывает панель), в лог не пишем.
                            try:
                                job["progress"] = json.loads(line[len("GMW_PROGRESS "):])
                            except ValueError:
                                pass
                            continue
                        log.write(line + "\n")
                        log.flush()
                        if line.startswith("GMW_RESULT "):
                            try:
                                result = json.loads(line[len("GMW_RESULT "):])
                            except ValueError:
                                pass
                        elif line.strip():
                            job["message"] = line.strip()[:200]
                finally:
                    proc.stdout.close()
                try:
                    return proc.wait(timeout=60), result
                except subprocess.TimeoutExpired:
                    proc.kill()
                    return proc.wait(), result

        code, result = await asyncio.to_thread(run)
        job["finished"] = int(time.time() * 1000)
        if result and result.get("ok"):
            job.update(state="done", session=result.get("session"), message=result.get("message", ""))
            self.state["done"][key] = {"session": result.get("session"), "at": job["finished"]}
            print(f"[craig] готово: {path.name} → сессия {result.get('session')}")
        else:
            job.update(state="error", message=(result or {}).get("message") or job["message"] or f"код {code}")
            # Чтобы не зациклиться на битом файле: помечаем как обработанный с ошибкой.
            self.state["done"][key] = {"error": job["message"], "at": job["finished"]}
            print(f"[craig] ошибка: {path.name}: {job['message']}")
        self._save_state()
        self.invalidate()
