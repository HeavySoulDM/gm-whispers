"""Расшифровка записи Craig (по дорожке на каждого участника) на видеокарте.

Запуск: перетащи zip (или папку) с записью Craig на server\\transcribe.bat
  или: python -m gmw.transcribe <zip|папка> [--session ID] [--start "2026-10-07 19:00"] [--model large-v3-turbo]

Результат: data/sessions/<сессия>/transcript.txt и transcript.json — их подхватывают «Итоги» в Foundry.
Имена говорящих берутся из имён файлов Craig и переводятся через server/config/speakers.json.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import time
import zipfile
from datetime import datetime
from pathlib import Path

from .config import DATA_DIR, SERVER_DIR, SPEAKERS_PATH, settings
from .filters import load_ignore, voice_ignored
from .sessions import SessionStore, parse_transcript_text

# Новый способ раздачи файлов Hugging Face (Xet) иногда обрывается — качаем обычным HTTP с докачкой.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
MODELS_DIR = DATA_DIR / "models"
MODEL_FILES = ["config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.*"]

AUDIO_EXT = {".flac", ".ogg", ".opus", ".m4a", ".aac", ".mp3", ".wav"}

# Типичные «галлюцинации» Whisper на тишине и шуме в русском.
HALLUCINATIONS = re.compile(
    r"субтитр|продолжение следует|спасибо за просмотр|подписывайтесь|редактор|корректор|dimatorzok|amara\.org",
    re.IGNORECASE,
)


def _add_cuda_dlls() -> None:
    """На Windows библиотеки CUDA из pip-пакетов nvidia-* нужно явно добавить в путь поиска DLL."""
    if os.name != "nt":
        return
    for base in sys.path:
        nv = Path(base) / "nvidia"
        if not nv.is_dir():
            continue
        for sub in ("cublas", "cudnn", "cuda_runtime", "cuda_nvrtc"):
            b = nv / sub / "bin"
            if b.is_dir():
                os.add_dll_directory(str(b))
                os.environ["PATH"] = str(b) + os.pathsep + os.environ.get("PATH", "")


class ModelDownloadError(Exception):
    pass


def ensure_model(name: str) -> str:
    """Модель в data/models/faster-whisper-<name>. Если её нет — скачивает (с повторами и докачкой)."""
    if Path(name).is_dir():
        return name
    from faster_whisper.utils import _MODELS

    repo = _MODELS.get(name, name)
    local = MODELS_DIR / f"faster-whisper-{name}"
    if (local / "model.bin").exists() and (local / "config.json").exists():
        return str(local)
    from huggingface_hub import snapshot_download

    local.mkdir(parents=True, exist_ok=True)
    print(f"Скачиваю модель распознавания {name} (~1.6 ГБ, один раз) в {local} …", flush=True)
    last = None
    for attempt in range(1, 6):
        try:
            snapshot_download(repo, local_dir=str(local), allow_patterns=MODEL_FILES)
            if (local / "model.bin").exists():
                print("Модель скачана.", flush=True)
                return str(local)
        except Exception as e:  # noqa: BLE001
            last = e
            msg = str(e).split("\n")[0][:200]
            print(f"   попытка {attempt}/5 не удалась: {msg}", flush=True)
            time.sleep(min(30, 5 * attempt))
    raise ModelDownloadError(
        f"Не удалось скачать модель {repo}: {last}\n"
        f"Можно скачать вручную: https://huggingface.co/{repo}/tree/main — файлы "
        "config.json, preprocessor_config.json, model.bin, tokenizer.json, vocabulary.json — "
        f"и положить их в папку {local}"
    )


def _patch_av() -> None:
    """faster-whisper 1.2 вызывает av.open(..., metadata_errors=…), а в PyAV 16+ этого параметра нет.
    Убираем его, если текущая версия PyAV его не знает (старые колёса PyAV под Python 3.14 не ставятся)."""
    import av

    if getattr(av.open, "_gmw_patched", False):
        return
    orig = av.open

    def open_compat(*args, **kwargs):
        try:
            return orig(*args, **kwargs)
        except TypeError as e:
            if "metadata_errors" not in str(e):
                raise
            kwargs.pop("metadata_errors", None)
            return orig(*args, **kwargs)

    open_compat._gmw_patched = True
    av.open = open_compat


def load_model(name: str):
    path = ensure_model(name)
    _add_cuda_dlls()
    _patch_av()
    from faster_whisper import WhisperModel

    try:
        model = WhisperModel(path, device="cuda", compute_type="float16")
        print(f"Модель {name} загружена на видеокарту.")
        return model
    except Exception as e:  # noqa: BLE001
        print(f"!! Видеокарта недоступна ({str(e)[:300]}).")
        print("   Перехожу на процессор — будет в разы медленнее. Пришли этот текст, разберёмся с CUDA.")
        return WhisperModel(path, device="cpu", compute_type="int8")


def speaker_from_file(path: Path) -> str:
    stem = path.stem
    stem = re.sub(r"^\d+-", "", stem)              # «1-username» → «username»
    stem = re.sub(r"[_#]\d{1,4}$", "", stem)        # хвост дискриминатора
    return stem or path.stem


def load_speakers() -> dict:
    try:
        return json.loads(SPEAKERS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_speakers(d: dict) -> None:
    SPEAKERS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SPEAKERS_PATH.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")


def parse_start(info: str) -> int | None:
    """Время начала записи из info.txt Craig (строка вида «Start time: 2026-10-07T16:02:11.123Z»)."""
    m = re.search(r"start(?:ed)?(?: time)?\s*[:=]\s*(\S+(?:\s\S+)?)", info, re.IGNORECASE)
    if not m:
        return None
    raw = m.group(1).strip()
    for cand in (raw, raw.split(" ")[0]):
        try:
            return int(datetime.fromisoformat(cand.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            continue
    return None


def vocabulary_prompt(limit: int = 70) -> str:
    """Подсказка распознаванию: имена NPC, мест и фракций из базы знаний + персонажи."""
    names: list[str] = []
    kb_path = settings.kb_dir / "kb.json"
    try:
        data = json.loads(kb_path.read_text(encoding="utf-8"))
        for p in data.get("pages", []):
            entry, page = p.get("entry", ""), p.get("page", "")
            if entry.startswith("База НПС") or "фракции" in entry.lower() or entry.startswith("Квенты"):
                n = re.sub(r"^[^\wА-Яа-яЁё]+", "", page).strip()
                if n and len(n) < 40 and n not in names:
                    names.append(n)
    except (OSError, ValueError):
        pass
    for k, v in load_speakers().items():
        if k.startswith("_"):
            continue
        m = re.search(r"\(([^)]+)\)", str(v))
        if m and m.group(1) not in names:
            names.insert(0, m.group(1))
    base = "Настольная ролевая игра Dungeons & Dragons, кампания «Драккенхейм». Делириум, Хранители Пламени, Королева Воров."
    return base + (" Имена: " + ", ".join(names[:limit]) + "." if names else "")


def collect_audio(src: Path, tmp: Path) -> tuple[list[Path], str, Path | None]:
    """Распаковывает zip при необходимости. Возвращает дорожки, текст info.txt и файл расшифровки Craig (если есть)."""
    if src.is_file() and src.suffix.lower() == ".zip":
        with zipfile.ZipFile(src) as z:
            z.extractall(tmp)
        root = tmp
    elif src.is_file():
        root = src.parent
    else:
        root = src
    tracks = [src] if src.is_file() and src.suffix.lower() in AUDIO_EXT else sorted(p for p in root.rglob("*") if p.suffix.lower() in AUDIO_EXT)
    info = ""
    for p in root.rglob("info.txt"):
        info = p.read_text(encoding="utf-8", errors="ignore")
        break
    craig_tr = None
    for ext in ("vtt", "srt", "txt"):
        found = sorted(root.rglob(f"transcription.{ext}"))
        if found:
            craig_tr = found[0]
            break
    return tracks, info, craig_tr


def parse_notes(info: str) -> list[dict]:
    """Заметки, сделанные во время записи командой Craig /note: «\t01:23:45.67: текст»."""
    out = []
    m = re.search(r"Notes:\s*\n(.*)", info, re.DOTALL)
    if not m:
        return out
    for row in m.group(1).splitlines():
        mm = re.match(r"\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?):\s*(.*)", row)
        if mm:
            h, mi, se, text = mm.groups()
            out.append({"off": int(h) * 3600 + int(mi) * 60 + float(se), "end": None, "who": "📝 Заметка ГМа (Craig)", "text": text.strip()})
    return out


def merge_segments(segs: list[dict], gap: float = 1.5, max_len: int = 400) -> list[dict]:
    segs = sorted(segs, key=lambda s: s["off"])
    out: list[dict] = []
    for s in segs:
        last = out[-1] if out else None
        if last and last["who"] == s["who"] and s["off"] - last["end"] <= gap and len(last["text"]) < max_len:
            last["text"] += " " + s["text"]
            last["end"] = s["end"]
        else:
            out.append(dict(s))
    return out


def _duration(path: Path) -> float:
    """Длительность дорожки в секундах без декодирования (по заголовку файла). 0 — если не удалось."""
    try:
        import av

        with av.open(str(path)) as c:
            if c.duration:
                return c.duration / 1_000_000
            st = c.streams.audio[0]
            if st.duration and st.time_base:
                return float(st.duration * st.time_base)
    except Exception:  # noqa: BLE001
        pass
    return 0.0


def _fmt_left(sec: float | None) -> str:
    if sec is None:
        return "оцениваю…"
    sec = int(sec)
    if sec < 90:
        return f"~{max(sec, 5)} с"
    if sec < 3600:
        return f"~{round(sec / 60)} мин"
    return f"~{sec // 3600} ч {round(sec % 3600 / 60)} мин"


class Progress:
    """Прогресс распознавания по всем дорожкам: доля обработанного звука и оценка оставшегося времени.

    Для сервера (GMW_PROGRESS_JSON=1) печатает строки «GMW_PROGRESS {json}» раз в пару секунд,
    в окне transcribe.bat — полоску раз в 15 с.
    """

    def __init__(self, tracks: list[Path], names: list[str]):
        self.durs = [_duration(p) for p in tracks]
        self.names = names
        self.total = sum(self.durs)
        self.done_before = 0.0  # звук предыдущих дорожек
        self.track = 0
        self.t0 = time.time()  # начало распознавания (без загрузки модели)
        self.json = os.getenv("GMW_PROGRESS_JSON") == "1"
        self.last = 0.0

    def start_track(self, n: int, dur: float | None = None) -> None:
        if n > 1:
            self.done_before += self.durs[n - 2]
        self.track = n
        if dur and not self.durs[n - 1]:
            self.durs[n - 1] = dur
            self.total = sum(self.durs)
        self.emit("read", 0.0, force=True)

    def emit(self, phase: str, pos: float, force: bool = False) -> None:
        now = time.time()
        if not force and now - self.last < (2 if self.json else 15):
            return
        self.last = now
        done = self.done_before + pos
        frac = min(done / self.total, 1.0) if self.total else None
        elapsed = now - self.t0
        eta = None
        if frac and frac > 0.02 and elapsed > 20:
            eta = elapsed * (1 - frac) / frac
        n, total = self.track, len(self.durs)
        name = self.names[n - 1] if 0 < n <= len(self.names) else ""
        if self.json:
            data = {"phase": phase, "track": n, "tracks": total, "name": name,
                    "pct": None if frac is None else round(frac * 100, 1),
                    "eta": None if eta is None else int(eta), "at": int(now * 1000)}
            print("GMW_PROGRESS " + json.dumps(data, ensure_ascii=False), flush=True)
        elif phase == "speech":
            pct = int((frac or 0) * 100)
            bar = "█" * (pct // 5) + "░" * (20 - pct // 5)
            print(f"    [{bar}] {pct}% · дорожка {n}/{total} · осталось {_fmt_left(eta)}", flush=True)

    def finish(self) -> None:
        if self.json:
            print("GMW_PROGRESS " + json.dumps({"phase": "save", "track": len(self.durs), "tracks": len(self.durs),
                                                "pct": 100, "eta": 0, "at": int(time.time() * 1000)}), flush=True)


def transcribe_tracks(model, tracks: list[Path], prompt: str, speakers: dict) -> list[dict]:
    segs: list[dict] = []
    names = [speakers.get(speaker_from_file(p)) or speaker_from_file(p) for p in tracks]
    prog = Progress(tracks, names)
    if prog.total:
        print(f"Звука всего: {_fmt_left(prog.total).lstrip('~')} на {len(tracks)} дорожках.", flush=True)
    for n, path in enumerate(tracks, 1):
        raw = speaker_from_file(path)
        who = speakers.get(raw) or raw
        t0 = time.time()
        print(f"[{n}/{len(tracks)}] {path.name} → «{who}» …", flush=True)
        prog.start_track(n)
        segments, info = model.transcribe(
            str(path),
            language=None if settings.whisper_language == "auto" else settings.whisper_language,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            beam_size=5,
            initial_prompt=prompt,
            condition_on_previous_text=False,
        )
        if not prog.durs[n - 1] and getattr(info, "duration", 0):
            prog.durs[n - 1] = info.duration
            prog.total = sum(prog.durs)
        prog.emit("speech", 0.0, force=True)
        count = 0
        for s in segments:
            prog.emit("speech", s.end)
            text = (s.text or "").strip()
            if not text or HALLUCINATIONS.search(text):
                continue
            if getattr(s, "no_speech_prob", 0) > 0.6 and getattr(s, "avg_logprob", 0) < -1.0:
                continue
            segs.append({"off": round(s.start, 2), "end": round(s.end, 2), "who": who, "spk": raw, "text": text})
            count += 1
        print(f"    готово: {count} фраз за {int(time.time() - t0)} с", flush=True)
    prog.finish()
    return merge_segments(segs)


def process_source(src: Path, session: str | None = None, start_text: str | None = None,
                   model_name: str | None = None, local: bool = False, log=print) -> dict:
    """Импорт записи Craig в сессию. Возвращает {"ok", "session", "lines", "source", "message"}."""
    store = SessionStore()
    model_name = model_name or os.getenv("GMW_WHISPER_MODEL", "large-v3-turbo")
    with tempfile.TemporaryDirectory(prefix="gmw_craig_") as tmpd:
        tracks, info, craig_tr = collect_audio(src, Path(tmpd))
        if not tracks and not craig_tr:
            return {"ok": False, "message": "В архиве/папке нет ни дорожек (flac/ogg/m4a/mp3/wav), ни расшифровки Craig."}
        start = parse_start(info) if info else None
        if start_text:
            start = int(datetime.fromisoformat(start_text).timestamp() * 1000)
        approx = False
        if start is None:
            files = tracks or [craig_tr]
            start = int(min(p.stat().st_mtime for p in files) * 1000)
            approx = True
            log("!! В архиве нет времени начала записи (info.txt — он есть только в многодорожечном zip). "
                "Беру время файлов — сверка с событиями Foundry будет примерной.")
            log('   Точнее: transcribe.bat <архив> --start "2026-10-07 19:00"')
        sid = session or store.session_for(start)
        log(f"Сессия: {sid} · начало записи {datetime.fromtimestamp(start / 1000):%d.%m.%Y %H:%M:%S} · дорожек: {len(tracks)}")

        speakers = load_speakers()
        ignore = load_ignore()
        names = {speaker_from_file(p) for p in tracks}
        notes = parse_notes(info) if info else []
        skipped = [p for p in tracks if voice_ignored(speaker_from_file(p), speakers.get(speaker_from_file(p), ""), ignore=ignore)]
        if skipped:
            tracks = [p for p in tracks if p not in skipped]
            log(f"Пропускаю дорожки (config/ignore.json): {', '.join(p.name for p in skipped)}")

        if craig_tr and not local:
            # Готовая расшифровка Craig (тариф с транскрипцией): распознавать заново не нужно.
            lines = parse_transcript_text(craig_tr.read_text(encoding="utf-8", errors="ignore"), craig_tr.name)
            for ln in lines:
                raw = re.sub(r"#\d{1,4}$", "", ln.get("who") or "?")
                ln["spk"] = raw
                names.add(raw)
                ln["end"] = None
            lines = [ln for ln in lines if ln.get("off") is not None and not HALLUCINATIONS.search(ln.get("text", ""))
                     and not voice_ignored(ln["spk"], speakers.get(ln["spk"], ""), ignore=ignore)]
            source = f"craig-transcript:{src.name}"
            log(f"Взята готовая расшифровка Craig ({craig_tr.name}): {len(lines)} реплик.")
        else:
            if not tracks:
                return {"ok": False, "message": "Нет аудиодорожек для распознавания."}
            new = sorted(names - set(speakers))
            if new:
                for raw in new:
                    speakers[raw] = raw
                save_speakers(speakers)
            prompt = vocabulary_prompt()
            if os.getenv("GMW_PROGRESS_JSON") == "1":
                print("GMW_PROGRESS " + json.dumps({"phase": "model", "tracks": len(tracks), "pct": 0,
                                                    "at": int(time.time() * 1000)}), flush=True)
            try:
                model = load_model(model_name)
            except ModelDownloadError as e:
                return {"ok": False, "message": str(e)}
            lines = transcribe_tracks(model, tracks, prompt, speakers)
            source = f"craig:{src.name}"

        new = sorted(n for n in names - set(speakers) if n and n != "?")
        if new:
            for raw in new:
                speakers[raw] = raw
            save_speakers(speakers)
            log(f"Новые участники добавлены в {SPEAKERS_PATH.name}: {', '.join(new)}")
            log('   Впиши там, кто есть кто, например "dimko": "Дима (ГМ)", "lera_m": "Лера (Мира)".')

    lines = sorted(lines + notes, key=lambda x: x["off"])
    for ln in lines:
        ln["ts"] = int(start + ln["off"] * 1000)
    store.save_transcript(sid, {"source": source, "start": start, "approx": approx, "lines": lines})
    out = store._dir(sid) / "transcript.txt"
    msg = f"{len(lines)} реплик{f' (из них заметок /note: {len(notes)})' if notes else ''} → {out}"
    log("Готово: " + msg)
    return {"ok": True, "session": sid, "lines": len(lines), "source": source, "message": msg}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Расшифровка записи Craig для GM Whispers")
    ap.add_argument("source", help="zip-архив Craig или папка с дорожками")
    ap.add_argument("--session", help="id сессии (папка в data/sessions); по умолчанию — по времени записи")
    ap.add_argument("--start", help="время начала записи, если в архиве нет info.txt: «2026-10-07 19:00»")
    ap.add_argument("--model", default=os.getenv("GMW_WHISPER_MODEL", "large-v3-turbo"))
    ap.add_argument("--local", action="store_true", help="распознать заново на видеокарте, даже если в архиве есть расшифровка Craig")
    args = ap.parse_args(argv)

    src = Path(args.source.strip('"'))
    if not src.exists():
        print(f"Не найдено: {src}")
        return 1
    t0 = time.time()
    res = process_source(src, args.session, args.start, args.model, args.local)
    print("GMW_RESULT " + json.dumps(res, ensure_ascii=False), flush=True)
    if not res["ok"]:
        print(f"\n!! {res['message']}")
        return 1
    print(f"Заняло {int(time.time() - t0)} с. Теперь в Foundry: панель GM Whispers → «Итоги» → выбери эту сессию.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
