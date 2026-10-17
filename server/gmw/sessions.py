"""Хранилище сессий: события Foundry, расшифровка голоса, загруженные тексты.

data/sessions/<id>/
  meta.json            — первое/последнее событие, счётчики
  events.jsonl         — события из Foundry (чат, бой, ХП, сцены, добыча), пишет модуль в реальном времени
  transcript.json/.txt — расшифровка голоса (Craig → transcribe.bat) или загруженный текст

Сессия — непрерывный кусок времени: если между событиями прошло больше 6 часов, начинается новая.
Поэтому чистка чата в Foundry (chatlog-prune) на итоги уже не влияет.
"""

from __future__ import annotations

import json
import re
import time
from datetime import datetime
from pathlib import Path

from .config import DATA_DIR

GAP_MS = 6 * 3600 * 1000
SESSIONS_DIR = DATA_DIR / "sessions"


def _local(ts_ms: int, fmt: str) -> str:
    return datetime.fromtimestamp(ts_ms / 1000).strftime(fmt)


class SessionStore:
    def __init__(self, root: Path = SESSIONS_DIR):
        self.root = Path(root)

    # ---------------------------------------------------------------- служебное

    def _dir(self, sid: str) -> Path:
        if not re.fullmatch(r"[0-9A-Za-z_\-]+", sid or ""):
            raise ValueError(f"Некорректный id сессии: {sid!r}")
        return self.root / sid

    def _meta(self, sid: str) -> dict:
        p = self._dir(sid) / "meta.json"
        if p.exists():
            try:
                return json.loads(p.read_text(encoding="utf-8"))
            except ValueError:
                pass
        return {"id": sid, "first": None, "last": None, "events": 0}

    def _save_meta(self, sid: str, meta: dict) -> None:
        d = self._dir(sid)
        d.mkdir(parents=True, exist_ok=True)
        (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")

    def ids(self) -> list[str]:
        if not self.root.exists():
            return []
        return sorted(p.name for p in self.root.iterdir() if p.is_dir() and not p.name.startswith("_"))

    def _new_id(self, ts: int) -> str:
        base = _local(ts, "%Y-%m-%d_%H%M")
        sid, n = base, 2
        while (self.root / sid).exists():
            sid = f"{base}_{n}"
            n += 1
        return sid

    def session_for(self, ts: int, create: bool = True) -> str | None:
        """Сессия, к которой относится момент ts (±6 ч от её событий), иначе новая."""
        best = None
        for sid in reversed(self.ids()):
            m = self._meta(sid)
            if m.get("first") is None:
                continue
            if m["first"] - GAP_MS <= ts <= m["last"] + GAP_MS:
                best = sid
                break
        if best or not create:
            return best
        sid = self._new_id(ts)
        self._save_meta(sid, {"id": sid, "first": ts, "last": ts, "events": 0})
        return sid

    # ---------------------------------------------------------------- события

    def append_events(self, events: list[dict]) -> dict:
        """Пакет событий → файлы сессий. Листинг каталога и meta.json читаются/пишутся один раз на сессию, не на событие."""
        counts: dict[str, int] = {}
        ids = self.ids()
        last_sid = ids[-1] if ids else None
        metas: dict[str, dict] = {}
        handles: dict[str, list[str]] = {}
        for ev in sorted(events, key=lambda e: e.get("ts") or 0):
            ts = int(ev.get("ts") or time.time() * 1000)
            sid = None
            if last_sid:
                m = metas.get(last_sid) or self._meta(last_sid)
                metas[last_sid] = m
                if m.get("last") is not None and 0 <= ts - m["last"] < GAP_MS:
                    sid = last_sid
            if sid is None:
                sid = self.session_for(ts)
                last_sid = sid
            m = metas.get(sid) or self._meta(sid)
            m["first"] = ts if m.get("first") is None else min(m["first"], ts)
            m["last"] = ts if m.get("last") is None else max(m["last"], ts)
            m["events"] = int(m.get("events") or 0) + 1
            metas[sid] = m
            handles.setdefault(sid, []).append(json.dumps({**ev, "ts": ts}, ensure_ascii=False))
            counts[sid] = counts.get(sid, 0) + 1
        for sid, lines in handles.items():
            d = self._dir(sid)
            d.mkdir(parents=True, exist_ok=True)
            with open(d / "events.jsonl", "a", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")
            self._save_meta(sid, metas[sid])
        return counts

    def load_events(self, sid: str) -> list[dict]:
        p = self._dir(sid) / "events.jsonl"
        if not p.exists():
            return []
        out = []
        for line in p.read_text(encoding="utf-8").splitlines():
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
        return sorted(out, key=lambda e: e.get("ts") or 0)

    # ---------------------------------------------------------------- расшифровка

    def save_transcript(self, sid: str, data: dict) -> None:
        d = self._dir(sid)
        d.mkdir(parents=True, exist_ok=True)
        (d / "transcript.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        lines = []
        for ln in data.get("lines", []):
            t = _local(ln["ts"], "%H:%M:%S") if ln.get("ts") else _hms(ln.get("off", 0))
            lines.append(f"[{t}] {ln.get('who', '?')}: {ln.get('text', '')}")
        (d / "transcript.txt").write_text("\n".join(lines), encoding="utf-8")
        m = self._meta(sid)
        if m.get("first") is None and data.get("start"):
            m["first"] = m["last"] = data["start"]
        # Сводка расшифровки в meta — список сессий не читает многомегабайтные transcript.json.
        m["transcript"] = len(data.get("lines", []))
        m["transcriptSource"] = data.get("source")
        self._save_meta(sid, m)

    def load_transcript(self, sid: str) -> dict | None:
        p = self._dir(sid) / "transcript.json"
        if not p.exists():
            return None
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except ValueError:
            return None

    def save_upload(self, sid: str, filename: str, text: str, start_ms: int | None = None) -> dict:
        """Загруженный текст расшифровки (txt / srt / vtt). Время выравнивается по началу сессии (≈)."""
        lines = parse_transcript_text(text, filename)
        m = self._meta(sid)
        start = start_ms or m.get("first")
        for ln in lines:
            ln["ts"] = int(start + ln["off"] * 1000) if (start and ln.get("off") is not None) else None
        data = {"source": f"upload:{filename}", "start": start, "approx": start_ms is None, "lines": lines}
        self.save_transcript(sid, data)
        return {"lines": len(lines)}

    # ---------------------------------------------------------------- очистка

    def archive_old(self, keep_days: int) -> list[str]:
        """Сессии старше keep_days упаковать в data/archive/<id>.zip и убрать из списка. Самую свежую не трогаем.
        Возвращает id заархивированных."""
        if keep_days <= 0:
            return []
        import shutil
        import zipfile

        cutoff = (time.time() - keep_days * 86400) * 1000
        archive = self.root.parent / "archive"
        done = []
        ids = self.ids()
        for sid in ids[:-1]:
            m = self._meta(sid)
            last = m.get("last") or m.get("first")
            if last is None:
                try:
                    last = (self._dir(sid) / "meta.json").stat().st_mtime * 1000
                except OSError:
                    continue
            if last >= cutoff:
                continue
            d = self._dir(sid)
            archive.mkdir(parents=True, exist_ok=True)
            target = archive / f"{sid}.zip"
            try:
                with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
                    for f in sorted(d.iterdir()):
                        if f.is_file():
                            z.write(f, f.name)
                shutil.rmtree(d)
                done.append(sid)
            except OSError as e:
                print(f"[sessions] не удалось заархивировать {sid}: {e}")
        return done

    # ---------------------------------------------------------------- обзор

    def list(self) -> list[dict]:
        out = []
        for sid in reversed(self.ids()):
            m = self._meta(sid)
            if "transcript" not in m and (self._dir(sid) / "transcript.json").exists():
                tr = self.load_transcript(sid)  # сессия, записанная до появления сводки в meta
                m["transcript"] = len(tr["lines"]) if tr else 0
                m["transcriptSource"] = tr.get("source") if tr else None
                self._save_meta(sid, m)
            out.append({
                "id": sid,
                "first": m.get("first"),
                "last": m.get("last"),
                "events": m.get("events", 0),
                "transcript": m.get("transcript", 0),
                "transcriptSource": m.get("transcriptSource"),
                "label": _label(m, sid),
            })
        return out


def _label(m: dict, sid: str) -> str:
    if m.get("first"):
        a = _local(m["first"], "%d.%m.%Y %H:%M")
        b = _local(m["last"], "%H:%M") if m.get("last") else ""
        return f"{a}–{b}" if b else a
    return sid


def _hms(sec: float) -> str:
    sec = int(sec or 0)
    return f"+{sec // 3600:02d}:{sec % 3600 // 60:02d}:{sec % 60:02d}"


_TS = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?")


def _to_sec(s: str) -> float | None:
    m = _TS.fullmatch(s.strip())
    if not m:
        return None
    h, mi, se, ms = m.groups()
    return int(h or 0) * 3600 + int(mi) * 60 + int(se) + (int((ms or "0").ljust(3, "0")) / 1000)


def parse_transcript_text(text: str, filename: str = "") -> list[dict]:
    """SRT / WebVTT / простой текст ([чч:мм:сс] Имя: реплика) → [{off, who, text}]."""
    text = text.replace("\r\n", "\n").replace("﻿", "")
    out: list[dict] = []
    if "-->" in text:
        for block in re.split(r"\n\s*\n", text):
            rows = [r for r in block.strip().split("\n") if r.strip()]
            idx = next((i for i, r in enumerate(rows) if "-->" in r), None)
            if idx is None:
                continue
            start = _to_sec(rows[idx].split("-->")[0].strip().split(" ")[0])
            body = " ".join(rows[idx + 1:]).strip()
            who = ""
            mv = re.match(r"<v\s+([^>]+)>(.*)", body)
            if mv:
                who, body = mv.group(1).strip(), mv.group(2)
            body = re.sub(r"<[^>]+>", "", body).strip()
            if not who:
                ms = re.match(r"^\[?([^\]:]{1,40})\]?:\s+(.*)", body)
                if ms:
                    who, body = ms.group(1).strip(), ms.group(2)
            if body:
                out.append({"off": start, "who": who or "?", "text": body})
        return out
    for row in text.split("\n"):
        row = row.strip()
        if not row:
            continue
        off = None
        mt = re.match(r"^\[?\+?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)\]?\s*(.*)", row)
        if mt:
            off = _to_sec(mt.group(1) if mt.group(1).count(":") == 2 else "0:" + mt.group(1))
            row = mt.group(2)
        who = "?"
        ms = re.match(r"^([^:]{1,40}):\s+(.*)", row)
        if ms:
            who, row = ms.group(1).strip(), ms.group(2)
        if row:
            out.append({"off": off, "who": who, "text": row})
    return out
