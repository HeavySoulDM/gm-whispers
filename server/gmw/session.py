"""Итоги сессии (F3) по логу чата Foundry и заметкам мастера → черновик для «Дневника кампании»."""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime

from . import campaign
from . import prompts_en as en
from .advisor import TOOLS, collect_citations, make_tools
from .kb import KnowledgeBase
from .llm import model_for, run_tool_loop
from .filters import chat_ignored, load_ignore, voice_ignored
from .sessions import SessionStore
from .config import SPEAKERS_PATH
from .usage import Usage

SUMMARY_SYSTEM = """Ты — летописец кампании и помощник мастера. Пишешь итоги сыгранной сессии для «Дневника кампании». Читает только мастер, спойлеры допустимы.

{campaign}

Источники, сведённые на одну шкалу времени:
- 🎙 расшифровка голоса из Discord (основа: отыгрыш, решения, разговоры с NPC). Это автоматическое распознавание: возможны ошибки в словах и именах, есть болтовня не по игре (техника, перерывы, шутки) — её пропускай. Мастер (ГМ) озвучивает NPC и описывает мир;
- 💬 чат Foundry, 🎲 броски, ⚔ ход боя, ❤ изменения хитов, 🗺 смена сцены, 🎒 добыча — точные события из Foundry;
- заметки мастера — самый надёжный источник, важнее всего остального.
Пробелы не заполняй выдумкой.

Правила:
- Пиши сжато и конкретно: кто, что, с кем, чем кончилось. Героев называй по именам персонажей.
- Только факты из лога и заметок. Если что-то неясно — помечай «(неясно по логу)», а не додумывай.
- Имена NPC, мест и фракций при сомнении сверяй с базой знаний через search_lore и ставь ссылку [S#] на найденное (одна ссылка на сущность, при первом упоминании).
- Не пересказывай механику бросков, если она не повлияла на сюжет; итог боя важнее списка атак.

Формат (Markdown, разделы без данных пропускай):
# <Короткое название сессии, 2–5 слов>
**Кратко:** 2–3 предложения.
## Хроника
Нумерованный список событий по порядку.
## Бои
С кем, где, итог, заметные моменты, потери и потраченные ресурсы.
## NPC и фракции
Кого встретили, что о них узнали, как изменилось отношение.
## Находки и добыча
## Обещания, долги, договорённости
## Открытые крючки и вопросы
## К следующей сессии
3–5 пунктов: что мастеру подготовить."""

PART_SYSTEM = """Ты помогаешь мастеру настольной ролевой игры составить итоги сессии. Тебе дан фрагмент общей шкалы времени: расшифровка голоса (🎙, с ошибками распознавания), чат и события Foundry.
{campaign}
Перескажи его как подробную хронику (язык: {lang}): события по порядку, решения партии, разговоры с NPC (кто что сказал по сути), бои и их итоги, находки, договорённости, важные броски.
Болтовню не по игре пропускай. Только факты из фрагмента, без выдумки, без вступлений."""

PART_CHARS = 45_000
SINGLE_LIMIT = 70_000
PARALLEL = 4


def _transcript(messages: list[dict]) -> str:
    lines = []
    ignore = load_ignore()
    for m in messages:
        text = (m.get("text") or "").strip()
        if not text or chat_ignored(m.get("who") or "", ignore=ignore):
            continue
        who = m.get("who") or "?"
        t = m.get("t") or ""
        kind = f"[{m['kind']}] " if m.get("kind") and m["kind"] not in ("base", "") else ""
        wh = f" (шёпот → {m['whisper']})" if m.get("whisper") else ""
        lines.append(f"{t} {kind}{who}{wh}: {text}")
    return "\n".join(lines)


ICONS = {"chat": "💬", "roll": "🎲", "combat": "⚔", "hp": "❤", "scene": "🗺", "loot": "🎒", "voice": "🎙"}


def _hhmm(ts: int) -> str:
    return datetime.fromtimestamp(ts / 1000).strftime("%H:%M")


def _speakers() -> dict:
    try:
        return json.loads(SPEAKERS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def build_timeline(events: list[dict], transcript: dict | None) -> tuple[str, dict]:
    """События Foundry и голос на одной шкале времени. Возвращает текст и статистику."""
    rows: list[tuple[int, str]] = []
    tail: list[str] = []
    ignore = load_ignore()
    skipped_chat = skipped_voice = 0
    for e in events:
        ts = int(e.get("ts") or 0)
        icon = ICONS.get(e.get("kind", ""), "•")
        who = f"{e['who']}" if e.get("who") else ""
        wh = f" (шёпот → {e['whisper']})" if e.get("whisper") else ""
        text = (e.get("text") or "").strip()
        if not text:
            continue
        if e.get("kind") in ("chat", "roll") and chat_ignored(who, ignore=ignore):
            skipped_chat += 1
            continue
        prefix = f"[{_hhmm(ts)}] " if ts else ""
        rows.append((ts, f"{prefix}{icon} {who}{wh}{': ' if who else ''}{text}"))
    spk = _speakers()
    voice = 0
    if transcript:
        approx = "≈" if transcript.get("approx") else ""
        for ln in transcript.get("lines", []):
            who = spk.get(ln.get("spk", ""), ln.get("who", "?")) if ln.get("spk") else ln.get("who", "?")
            text = (ln.get("text") or "").strip()
            if not text:
                continue
            if voice_ignored(ln.get("spk", ""), ln.get("who", ""), ignore=ignore):
                skipped_voice += 1
                continue
            voice += 1
            if ln.get("ts"):
                rows.append((int(ln["ts"]), f"[{approx}{_hhmm(int(ln['ts']))}] 🎙 {who}: {text}"))
            else:
                tail.append(f"🎙 {who}: {text}")
    rows.sort(key=lambda r: r[0])
    text = "\n".join(r[1] for r in rows)
    if tail:
        text += "\n\nРасшифровка голоса без привязки ко времени:\n" + "\n".join(tail)
    return text, {"events": len(events) - skipped_chat, "voice": voice, "skipped": skipped_chat + skipped_voice}


def _split(text: str, size: int) -> list[str]:
    parts, cur, n = [], [], 0
    for line in text.splitlines():
        if n + len(line) > size and cur:
            parts.append("\n".join(cur))
            cur, n = [], 0
        cur.append(line)
        n += len(line) + 1
    if cur:
        parts.append("\n".join(cur))
    return parts


def _party_text(party: list[dict] | None) -> str:
    rows = []
    for m in party or []:
        bits = [m.get("name", "?")]
        if m.get("player"):
            bits.append(f"игрок {m['player']}")
        if m.get("race"):
            bits.append(m["race"])
        if m.get("classes"):
            bits.append(m["classes"])
        if m.get("level"):
            bits.append(f"{m['level']} ур.")
        if m.get("background"):
            bits.append(f"предыстория: {m['background']}")
        rows.append(" — ".join(bits))
    return "; ".join(rows)


async def summarize(
    kb: KnowledgeBase,
    messages: list[dict],
    notes: str = "",
    period: str = "",
    party: list | None = None,
    previous: str = "",
    session_id: str | None = None,
    lang: str | None = None,
    bible: dict | None = None,
) -> dict:
    t0 = time.time()
    model = model_for("lore")
    usage = Usage(model)
    run_tool, reg, tool_log = make_tools(kb, english=campaign.is_english(lang))

    stats = {"events": 0, "voice": 0, "messages": len(messages)}
    if session_id:
        store = SessionStore()
        events = store.load_events(session_id)
        tr = store.load_transcript(session_id)
        # Если журнал событий пуст (сессия до установки модуля) — берём присланный чат.
        if not events and messages:
            events = [{"ts": None, "kind": "chat", "who": m.get("who"), "text": f"[{m.get('t', '')}] {m.get('text', '')}", "whisper": m.get("whisper")} for m in messages]
        transcript, st = build_timeline(events, tr)
        stats.update(st)
    else:
        transcript = _transcript(messages)
    header = []
    if period:
        header.append(f"Период: {period}")
    if party:
        header.append(f"Партия: {_party_text(party)}")
    if previous:
        header.append(f"Конец итогов прошлой сессии (для связности):\n{previous[-2500:]}")
    if notes.strip():
        header.append(f"Заметки мастера (важнее лога):\n{notes.strip()}")
    head = "\n\n".join(header)

    # Длинный лог: сначала хроники по частям, потом общий итог.
    if len(transcript) > SINGLE_LIMIT:
        parts = _split(transcript, PART_CHARS)
        sem = asyncio.Semaphore(PARALLEL)

        async def one(i: int, part: str) -> str:
            async with sem:
                text = await run_tool_loop(
                    model, campaign.render({"ru": PART_SYSTEM, "en": en.PART_SYSTEM}, lang, style=False), [], (f"Fragment {i} of {len(parts)}:\n{part}" if campaign.is_english(lang) else f"Фрагмент {i} из {len(parts)}:\n{part}"), [], lambda *_: "", usage,
                    max_rounds=1, max_tokens=2500,
                )
                return f"### Часть {i}\n{text}"

        chronicles = await asyncio.gather(*(one(i, p) for i, p in enumerate(parts, 1)))
        body = "Хроника сессии по частям лога:\n\n" + "\n\n".join(chronicles)
    else:
        body = f"Шкала времени сессии:\n{transcript}" if transcript else "Лог пуст — опирайся на заметки мастера."

    user_text = (head + "\n\n" if head else "") + body + "\n\nСоставь итоги сессии по формату."
    answer = await run_tool_loop(model, campaign.render({"ru": SUMMARY_SYSTEM, "en": en.SUMMARY_SYSTEM}, lang, bible, style=False), [], user_text, TOOLS, run_tool, usage, max_rounds=3, max_tokens=3500)
    answer = answer or "Не удалось составить итоги."
    cited = collect_citations(answer, reg)

    elapsed = round(time.time() - t0, 1)
    usage.log("session_summary", {**stats, "chars": len(transcript), "seconds": elapsed, "session": session_id})
    return {"markdown": answer, "citations": cited, "usage": usage.as_dict(), "seconds": elapsed, "tools": tool_log, "stats": stats}
