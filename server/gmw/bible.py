"""«Библия кампании» (D3): выжимка, которая подкладывается в каждый запрос к модели.

Две части (две страницы журнала «GM Whispers · Библия кампании» в Foundry):
- Постоянное — пишет и правит мастер: партия и игроки, ключевые NPC и фракции, правила стола. Модуль не трогает.
- Текущее положение — обновляется сервером после каждых «Итогов»: где партия, что делает, долги, нити, отношения.
  В конце — «Предложения в постоянное»: что, по мнению модели, стоит перенести наверх.

Сервер библию не хранит: модуль присылает текст с каждым запросом (`bible` в /ask, /session/summarize, /session/prep),
а сюда — для сборки первой версии и обновления текущей части.
"""

from __future__ import annotations

import re
import time

from . import campaign
from . import prompts_en as en
from .advisor import TOOLS, make_tools
from .kb import KnowledgeBase
from .llm import model_for, run_tool_loop
from .usage import Usage

MAX_BIBLE_CHARS = 18_000   # сколько библии уходит в промпт (постоянное целиком, текущее — хвост)
PERMANENT_MARK = "=== ПОСТОЯННОЕ ==="
CURRENT_MARK = "=== ТЕКУЩЕЕ ==="
SUGGEST_HEAD = "## Предложения в постоянное"
# Английские промпты (prompts_en.py) используют свои маркеры — разбор понимает оба варианта.
PERMANENT_MARKS = (PERMANENT_MARK, "=== PERMANENT ===")
CURRENT_MARKS = (CURRENT_MARK, "=== CURRENT ===")
SUGGEST_HEADS = (SUGGEST_HEAD, "## Suggestions for Permanent")

BUILD_SYSTEM = """Ты — помощник мастера настольной ролевой игры. Собери «Библию кампании»: краткую выжимку, которую модель будет получать с каждым вопросом мастера, чтобы не путать персонажей и держать тон. Читает только мастер, спойлеры допустимы.

{campaign}

Что у тебя есть: квенты персонажей игроков (присланы целиком — главный источник о партии), состав партии из Foundry, итоги сыгранных сессий (если есть), база знаний (search_lore / read_page — для фракций, ключевых NPC, мест).

Правила:
- Сжато: всё вместе 1500–3000 слов. Списки и короткие строки, не абзацы. Без ссылок [S#] — это справка, а не ответ.
- Только то, что есть в материалах. Чего нет — не выдумывай и не пиши «неизвестно», просто пропусти.
- Квенты: для каждого персонажа — имя и игрок, кто он, откуда, чего хочет, кого боится/любит, тайна или крючок, как говорит, что важно знать мастеру (чем зацепить, чего не делать). 5–10 строк на персонажа.
- Механика персонажей (уровень, класс, подкласс, хиты, характеристики, заклинания, снаряжение) в квентах устарела — её из квент НЕ бери. Класс и происхождение — только из «Партия в Foundry» (это актуальные листы). Уровень и хиты в библию не пиши вовсе: они меняются, модель получает их с листов при каждом вопросе.
- Ключевые NPC и фракции: по 1–3 строки — кто, чего хочет, как настроен к партии (на старте).
- Поищи в базе 3–6 раз: фракции, главные NPC из квент, стартовую локацию.

Формат ответа — ровно две части с такими маркерами:

=== ПОСТОЯННОЕ ===
## Партия
(по персонажу: имя (игрок) — …)
## Ключевые NPC
## Фракции
## Правила стола и договорённости
(что известно из материалов; если ничего — одна строка «пока не заполнено»)
## Как мастер хочет, чтобы отвечал помощник
(1–3 строки из профиля кампании)

=== ТЕКУЩЕЕ ===
## Где партия и что делает
## Долги, обещания, нити
## Отношения с NPC и фракциями
(если итогов нет — «Кампания только начинается» и 1–2 строки о стартовой ситуации по материалам)"""

UPDATE_SYSTEM = """Ты — помощник мастера настольной ролевой игры. Обнови «Текущее положение» в Библии кампании по итогам только что сыгранной сессии.

{campaign}

Тебе даны: постоянная часть библии (её менять нельзя — только учитывать), прежнее «Текущее положение» и итоги новой сессии.

Правила:
- Перепиши «Текущее положение» целиком: оставь то, что ещё актуально, обнови изменившееся, убери закрытое. 300–700 слов, списки.
- Только факты из итогов и прежнего текста. Ничего не выдумывай. Спорное помечай «(неясно)».
- Уровни, хиты и прочую механику персонажей не пиши: они берутся с листов при каждом вопросе.
- В конце добавь раздел «## Предложения в постоянное»: 0–5 строк, которые мастеру стоит перенести в постоянную часть (новый важный NPC, изменившееся правило стола, факт о персонаже, который теперь всегда верен). Если предлагать нечего — раздел без строк не пиши.

Формат: только текст текущей части, начиная с «## Где партия и что делает» (без маркеров и без постоянной части)."""


def split_sections(text: str) -> tuple[str, str]:
    """Ответ сборки → (постоянное, текущее)."""
    t = text or ""
    for pm, cm in zip(PERMANENT_MARKS, CURRENT_MARKS):
        if pm in t and cm in t:
            perm = t.split(pm, 1)[1].split(cm, 1)[0]
            cur = t.split(cm, 1)[1]
            return perm.strip(), cur.strip()
    # Модель не поставила маркеры: всё — в постоянное, текущее пустое.
    return t.strip(), ""


def prompt_block(bible: dict | None, english: bool = False) -> str:
    """Текст библии для системного промпта (или пусто). bible = {"permanent": str, "current": str}."""
    if not bible:
        return ""
    perm = (bible.get("permanent") or "").strip()
    cur = (bible.get("current") or "").strip()
    cur = re.split("^(?:" + "|".join(re.escape(h) for h in SUGGEST_HEADS) + ")", cur, maxsplit=1, flags=re.M)[0].strip()  # предложения модели — не факты
    if not perm and not cur:
        return ""
    if len(perm) > MAX_BIBLE_CHARS * 2 // 3:
        perm = perm[: MAX_BIBLE_CHARS * 2 // 3] + "\n…"
    room = MAX_BIBLE_CHARS - len(perm)
    if len(cur) > room:
        cur = "…\n" + cur[-room:]
    if english:
        from . import prompts_en as en
        head, cur_head = en.BIBLE_HEADER, en.BIBLE_CURRENT_HEADER
    else:
        head = "=== БИБЛИЯ КАМПАНИИ (составлена мастером; при расхождении с базой знаний верь библии; уровни и хиты персонажей — в контексте запроса, не здесь) ==="
        cur_head = "--- Текущее положение (после последней сессии) ---"
    parts = [head]
    if perm:
        parts.append(perm)
    if cur:
        parts.append(cur_head + "\n" + cur)
    return "\n\n".join(parts)


def _trim(s: str, n: int) -> str:
    s = (s or "").strip()
    return s if len(s) <= n else s[:n] + "\n…[обрезано]"


async def build(kb: KnowledgeBase, quentas: list[dict], party: list | None, summaries: list[str], lang: str | None) -> dict:
    """Первая версия библии. quentas = [{"name": str, "text": str}]."""
    from .session import _party_text

    t0 = time.time()
    model = model_for("lore")
    usage = Usage(model)
    run_tool, reg, tool_log = make_tools(kb, english=campaign.is_english(lang))
    parts = []
    if party:
        parts.append(f"Партия в Foundry: {_party_text(party)}")
    if quentas:
        parts.append("Квенты персонажей:\n\n" + "\n\n".join(f"--- {q.get('name', '?')} ---\n{_trim(q.get('text', ''), 9000)}" for q in quentas[:8]))
    else:
        parts.append("Квент нет — опиши партию по составу из Foundry и материалам базы.")
    if summaries:
        parts.append("Итоги сыгранных сессий (старые → новые):\n\n" + "\n\n".join(_trim(s, 5000) for s in summaries[-4:]))
    else:
        parts.append("Итогов сессий пока нет.")
    user_text = "\n\n".join(parts) + "\n\nСобери Библию кампании."
    answer = await run_tool_loop(model, campaign.render({"ru": BUILD_SYSTEM, "en": en.BUILD_SYSTEM}, lang, style=False), [], user_text, TOOLS, run_tool, usage, max_rounds=6, max_tokens=5000)
    perm, cur = split_sections(answer)
    elapsed = round(time.time() - t0, 1)
    usage.log("bible_build", {"quentas": len(quentas), "summaries": len(summaries), "seconds": elapsed, "tools": len(tool_log)})
    return {"permanent": perm, "current": cur, "usage": usage.as_dict(), "seconds": elapsed}


async def update(permanent: str, current: str, summary: str, lang: str | None) -> dict:
    """Новое «Текущее положение» по итогам сессии (без инструментов — всё уже в тексте)."""
    t0 = time.time()
    model = model_for("lore")
    usage = Usage(model)
    user_text = (
        f"Постоянная часть (только для сведения):\n{_trim(permanent, 12000)}\n\n"
        f"Прежнее «Текущее положение»:\n{_trim(current, 6000) or '(пусто — первая сессия)'}\n\n"
        f"Итоги новой сессии:\n{_trim(summary, 14000)}\n\nНапиши новое «Текущее положение»."
    )
    answer = await run_tool_loop(model, campaign.render({"ru": UPDATE_SYSTEM, "en": en.UPDATE_SYSTEM}, lang, style=False), [], user_text, [], lambda *_: "", usage, max_rounds=1, max_tokens=2500)
    elapsed = round(time.time() - t0, 1)
    usage.log("bible_update", {"seconds": elapsed})
    return {"current": answer.strip(), "usage": usage.as_dict(), "seconds": elapsed}
