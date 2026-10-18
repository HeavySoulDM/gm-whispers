"""Советник по приключению (F1): модель + поиск по базе знаний + ссылки на страницы."""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field

from .config import settings
from . import campaign
from . import prompts_en as en
from .kb import KnowledgeBase
from .llm import Tool, model_for, run_tool_loop
from .usage import Usage

SYSTEM = """Ты — GM Whispers, помощник мастера (ГМа) в Foundry VTT. Тебя видит только мастер, поэтому спойлеры допустимы и нужны.

{campaign}

Как отвечать:
- Мастер читает тебя прямо во время игры: длина и стиль — по правилам выше.
- Факты о мире, сюжете, NPC, фракциях, местах и механиках приключения бери из базы знаний через инструменты search_lore и read_page. Каждый факт из базы помечай ссылкой на фрагмент в квадратных скобках: [S3]. Ставь только те ссылки, которые реально видел в результатах инструментов.
- В сообщении мастера уже есть результаты предварительного поиска. Если их хватает — отвечай сразу, без новых поисков. Если нужно искать ещё — делай все нужные запросы за один ход (несколько вызовов search_lore одновременно), а не по одному.
- Ищи несколькими короткими запросами, если первый не дал ответа: имена и названия пробуй в разных формах и вариантах написания (переводы и транскрипции бывают разные). Если фрагмент обрывается на важном, читай страницу целиком через read_page.
- Если в материалах ответа нет — прямо скажи «в материалах не нашёл». Можешь предложить импровизацию, но явно пометь её словом «Импровизация:».
- Источник «Правила» — книги правил системы из компендиумов. На вопросы о механике (действия, состояния, укрытие, заклинания) отвечай по ним со ссылкой, а не по памяти; особые правила кампании (см. выше) важнее общих.
- «Дневник кампании» — итоги уже сыгранных сессий этой группы. На вопросы о том, что было в игре (кого встречали, что обещали, что нашли), отвечай прежде всего по нему.
- Приоритет источников при расхождениях: «Дневник кампании» (что реально произошло) > «Материалы ГМа» > «Книга приключения» > «Справочник мира». Если источники противоречат друг другу, отметь это.
- Учитывай текущее состояние игры (сцена, партия, бой) — ответ должен быть применим прямо сейчас.
- Сторона каждого токена указана в контексте: «враг», «союзник», «нейтрал», «персонаж игрока». Это решение мастера на текущий момент, и оно важнее лора: если NPC отмечен как враг, он говорит и действует как враг партии, даже если по книге мог бы быть союзником. Не путай стороны.
- Если мастер просит реплику или поведение NPC, давай готовые фразы от лица NPC (1–3 варианта), в его манере, если она описана в материалах.
- Не пересказывай мастеру очевидное и не давай общих советов по вождению, если о них не спрашивали."""

TOOLS = [
    Tool(
        name="search_lore",
        description=(
            "Поиск по базе знаний кампании: журналы Foundry — материалы ГМа (шпаргалки, база НПС, фракции, квенты игроков), "
            "книга приключения, справочник мира, правила. Возвращает фрагменты с идентификаторами [S#] для ссылок. "
            "Запросы лучше короткие: имена, названия мест, ключевые слова."
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Поисковый запрос"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 10, "description": "Сколько фрагментов вернуть (по умолчанию 6)"},
            },
            "required": ["query"],
        },
    ),
    Tool(
        name="read_page",
        description="Прочитать страницу журнала целиком (до ~12 тыс. символов). Аргумент — идентификатор фрагмента с этой страницы (например S3) или uuid страницы.",
        parameters={
            "type": "object",
            "properties": {"ref": {"type": "string", "description": "S# или uuid страницы"}},
            "required": ["ref"],
        },
    ),
]

MAX_ROUNDS = 4  # последний круг — всегда финальный ответ без инструментов
_CITE_GROUP = re.compile(r"\[(S\d+(?:\s*[,;]\s*S\d+)*)\]")


@dataclass
class Registry:
    by_key: dict = field(default_factory=dict)
    items: dict = field(default_factory=dict)  # "S3" -> {...}

    def add(self, key, uuid: str, title: str, label: str) -> str:
        if key in self.by_key:
            return self.by_key[key]
        sid = f"S{len(self.items) + 1}"
        self.by_key[key] = sid
        self.items[sid] = {"id": sid, "uuid": uuid, "title": title, "source": label}
        return sid


SIDES = {
    "hostile": "враг",
    "friendly": "союзник",
    "neutral": "нейтрал",
    "pc": "персонаж игрока",
    "secret": "сторона скрыта",
    "unknown": "сторона не указана",
}
SIDE_ORDER = ["hostile", "neutral", "friendly", "pc", "secret", "unknown"]


def _token_line(t: dict) -> str:
    bits = [t.get("name", "?")]
    if t.get("actor"):
        bits[0] += f" (актёр «{t['actor']}»)"
    if t.get("count", 1) > 1:
        bits[0] += f" ×{t['count']}"
    bits.append(SIDES.get(t.get("side", "unknown"), t.get("side", "")))
    hp = t.get("hp") or {}
    if hp.get("max"):
        bits.append(f"ХП {hp.get('value')}/{hp.get('max')}")
    if t.get("conditions"):
        bits.append("состояния: " + ", ".join(t["conditions"]))
    if t.get("defeated"):
        bits.append("повержен")
    if t.get("hidden"):
        bits.append("скрыт от игроков")
    return ", ".join(bits)


def _grouped(title: str, items: list) -> list[str]:
    out = [f"{title}:"]
    for side in SIDE_ORDER:
        group = [t for t in items if isinstance(t, dict) and t.get("side", "unknown") == side]
        if group:
            out.append(f"  {SIDES[side].capitalize()}:")
            out += [f"    - {_token_line(t)}" for t in group[:25]]
    out += [f"  - {t}" for t in items if not isinstance(t, dict)]
    return out if len(out) > 1 else []


def format_context(ctx: dict | None, kb: KnowledgeBase) -> str:
    if not ctx:
        return ""
    lines = []
    scene = ctx.get("scene") or {}
    if scene.get("name"):
        lines.append(f"Сцена: {scene['name']}")
        if scene.get("notes"):
            lines.append("Заметки на карте: " + "; ".join(scene["notes"][:25]))
        pages = [kb.pages[u] for u in scene.get("pageUuids", []) if u in kb.pages][:15]
        if pages:
            lines.append("Страницы журналов, привязанные к сцене (можно читать через read_page по uuid):")
            lines += [f"  - {p.entry} › {p.page} — uuid: {p.uuid}" for p in pages]
    party = ctx.get("party") or []
    if party:
        lines.append("Партия:")
        for m in party:
            hp = m.get("hp") or {}
            bits = [m.get("name", "?")]
            if m.get("player"):
                bits.append(f"игрок {m['player']}")
            if m.get("classes"):
                bits.append(m["classes"])
            if hp.get("max"):
                bits.append(f"ХП {hp.get('value')}/{hp.get('max')}")
            if m.get("conditions"):
                bits.append("состояния: " + ", ".join(m["conditions"]))
            lines.append("  - " + ", ".join(bits))
    combat = ctx.get("combat")
    if combat:
        cur = combat.get("current") or {}
        cur_text = _token_line(cur) if isinstance(cur, dict) else str(cur)
        lines.append(f"Идёт бой, раунд {combat.get('round')}. Сейчас ходит: {cur_text}")
        if isinstance(cur, dict) and cur.get("bio"):
            lines.append(f"  Описание ходящего: {cur['bio']}")
        if isinstance(cur, dict):
            lines += _statblock_lines(cur.get("statblock"), "  ", brief=True)
        lines += _grouped("Участники боя", combat.get("combatants") or [])
    tokens = ctx.get("tokens") or []
    if tokens and not combat:
        lines += _grouped("Токены на сцене", tokens)
    selected = ctx.get("selected") or []
    if selected:
        lines.append("Выделенные мастером токены:")
        for t in selected:
            if isinstance(t, dict):
                lines.append("  - " + _token_line(t) + (f". Описание: {t['bio']}" if t.get("bio") else ""))
                lines += _statblock_lines(t.get("statblock"), "      ", brief=True)
            else:
                lines.append(f"  - {t}")
    return "\n".join(lines)


def _tok_brief(t: dict) -> str:
    bits = [t.get("name", "?"), SIDES.get(t.get("side", "unknown"), "")]
    if t.get("distance") is not None:
        bits.append(f"дистанция {t['distance']} фт")
    w = t.get("walk")
    if isinstance(w, dict):
        if w.get("ft") is not None:
            bits.append(f"путь пешком до соседней клетки {w['ft']} фт ({w.get('reach', '')})")
        else:
            bits.append(f"не дойти до ближнего боя ({w.get('reach', '')})")
    if t.get("los") is False:
        bits.append("НЕ видно (стена)")
    elif t.get("los") is True:
        bits.append("видно")
    if t.get("cover"):
        bits.append(f"укрытие: {t['cover']}")
    if t.get("through"):
        bits.append("на линии существа: " + ", ".join(t["through"]) + " (½ укрытие)")
    if t.get("pathBlocked"):
        bits.append("прямой путь перекрыт")
    if t.get("ac"):
        bits.append(f"КД {t['ac']}")
    hp = t.get("hp") or {}
    if hp.get("max"):
        bits.append(f"ХП {hp.get('value')}/{hp.get('max')}")
    if t.get("concentrating"):
        bits.append("КОНЦЕНТРАЦИЯ")
    if t.get("conditions"):
        bits.append("состояния: " + ", ".join(t["conditions"]))
    if t.get("elevation"):
        bits.append(f"высота {t['elevation']} фт")
    if t.get("size"):
        bits.append(t["size"])
    if t.get("cell"):
        bits.append(f"клетка ({t['cell']['x']},{t['cell']['y']})")
    if t.get("hidden"):
        bits.append("скрыт от игроков")
    return ", ".join(b for b in bits if b)


def _statblock_lines(sb: dict | None, pad: str, brief: bool = False) -> list[str]:
    if not sb:
        return []
    out = []
    head = ", ".join(x for x in [
        sb.get("classes") or "",
        f"скорость: {sb['speed']}" if sb.get("speed") and not brief else "",
        f"ПО {sb['cr']}" if sb.get("cr") not in (None, "") else "",
    ] if x)
    if head:
        out.append(pad + head)
    if sb.get("traits"):
        out.append(pad + "Особенности: " + "; ".join(sb["traits"]))
    if sb.get("abilities"):
        out.append(pad + ("Умения: " if brief else "Действия и умения: ") + "; ".join(sb["abilities"]))
    if sb.get("spells"):
        out.append(pad + "Заклинания: " + " | ".join(sb["spells"]))
    return out


def format_tactics(t: dict | None) -> str:
    if not t or t.get("error"):
        return ""
    sc = t.get("scene") or {}
    f = t.get("focus") or {}
    lines = [
        "Тактическая обстановка (рассчитано Foundry). «Дистанция» — по прямой между ближайшими клетками (для досягаемости и дальности атак). "
        "«Путь пешком» — реальная длина перемещения до свободной соседней с целью клетки с обходом стен, существ и с учётом трудной местности; "
        "для планирования движения используй именно его. Видимость и укрытие — по стенам сцены.",
        f"Сцена: {sc.get('name', '?')}; {sc.get('grid', '')}; освещение: {sc.get('light', '?')}."
        + (f" Раунд {t['round']}." if t.get("round") else ""),
        f"Думаем за: {_tok_brief(f)}" + (f", скорость {f['speedFt']} фт" if f.get("speedFt") else ""),
    ]
    if f.get("vision"):
        lines.append(f"  Зрение: {f['vision']}")
    lines += _statblock_lines(f.get("statblock"), "  ")
    others = t.get("others") or []
    if others:
        lines.append("Остальные (от ближнего к дальнему):")
        for o in others[:20]:
            lines.append(f"  - {_tok_brief(o)}")
            lines += _statblock_lines(o.get("statblock"), "      ", brief=True)
    if t.get("doors"):
        lines.append("Двери рядом: " + "; ".join(t["doors"]))
    if t.get("regions"):
        lines.append("Зоны сцены: " + "; ".join(t["regions"]))
    return "\n".join(lines)


TACTICS_TASK = """Задача: предложи 2–3 варианта хода для «{name}» в этом раунде.
Для каждого варианта: перемещение (куда и сколько футов — по «пути пешком», а не по дистанции), действие, бонусное действие или реакция (если есть), и одна строка — почему так.
Опирайся на рассчитанные расстояния, видимость и укрытия; учитывай концентрацию, раненых, состояния и сторону каждого токена.
Используй только способности и заклинания из статблока, с их бонусами атаки, уроном и СЛ; учитывай сопротивления и реакции противников (например, Щит у мага); если их нет — стандартные действия системы (для D&D: атака, Рывок, Отход, Уклонение, Помощь, Засада, Поиск; для другой системы — её базовые действия).
Учитывай характер существа: зверь действует инстинктивно, умный враг — расчётливо; если в материалах описано поведение, следуй ему.
Формат: «Вариант 1 — название», затем 2–4 строки. В конце одна строка: какой вариант больше всего в характере существа."""


# Подписи источников для английских промптов (в базе они хранятся по-русски).
LABEL_EN = {"Дневник кампании": "Campaign Diary", "Материалы ГМа": "GM notes", "Книга приключения": "Adventure book",
            "Справочник мира": "Setting reference", "Правила": "Rules", "Прочие журналы": "Other journals"}


def make_tools(kb: KnowledgeBase, boost: set | None = None, english: bool = False):
    """Исполнитель инструментов search_lore / read_page с реестром ссылок [S#]. english — подписи источников и служебные ответы по-английски."""
    reg = Registry()
    tool_log: list = []
    boost = boost or set()
    lbl = (lambda s: LABEL_EN.get(s, s)) if english else (lambda s: s)

    def run_tool(name: str, args: dict) -> str:
        if name == "search_lore":
            q = str(args.get("query", "")).strip()
            try:
                limit = max(1, min(10, int(args.get("limit") or 6)))
            except (TypeError, ValueError):
                limit = 6
            hits = kb.search(q, limit=limit, boost_pages=boost)
            tool_log.append({"tool": name, "query": q, "hits": len(hits)})
            if not hits:
                return f"Nothing found for \"{q}\". Try other words or forms." if english else f"По запросу «{q}» ничего не найдено. Попробуй другие слова или формы."
            parts = []
            for c, _score in hits:
                sid = reg.add(("chunk", c.id), c.page_uuid, c.title, c.label)
                parts.append(f"[{sid}] {lbl(c.label)} · {c.title}\n{c.text}")
            return "\n\n---\n\n".join(parts)
        if name == "read_page":
            ref = str(args.get("ref", "")).strip()
            uuid = reg.items.get(ref, {}).get("uuid") if ref.upper().startswith("S") else ref
            page = kb.page_text(uuid or "")
            tool_log.append({"tool": name, "ref": ref, "found": bool(page)})
            if not page:
                return f"Page \"{ref}\" not found." if english else f"Страница «{ref}» не найдена."
            sid = reg.add(("page", page.uuid), page.uuid, f"{page.entry} › {page.page}", page.label)
            return f"[{sid}] {lbl(page.label)} · {page.entry} › {page.page}\n{page.text}"
        return f"Unknown tool {name}" if english else f"Неизвестный инструмент {name}"

    return run_tool, reg, tool_log


def collect_citations(answer: str, reg: Registry) -> list[dict]:
    """Источники в порядке первого упоминания; несколько S# с одной страницы → один источник."""
    cited: list[dict] = []
    by_uuid: dict[str, dict] = {}
    for g in _CITE_GROUP.findall(answer):
        for sid in re.findall(r"S\d+", g):
            item = reg.items.get(sid)
            if not item:
                continue
            c = by_uuid.get(item["uuid"])
            if c is None:
                c = {"uuid": item["uuid"], "title": item["title"], "source": item["source"], "ids": []}
                by_uuid[item["uuid"]] = c
                cited.append(c)
            if sid not in c["ids"]:
                c["ids"].append(sid)
    return cited


async def ask(kb: KnowledgeBase, question: str, ctx: dict | None = None, history: list | None = None, role: str = "lore",
              lang: str | None = None, bible: dict | None = None, on_event=None) -> dict:
    t0 = time.time()
    model = model_for(role)
    usage = Usage(model)
    boost = set(((ctx or {}).get("scene") or {}).get("pageUuids", []))
    run_tool, reg, tool_log = make_tools(kb, boost, english=campaign.is_english(lang))

    hist = [(h["q"], h["a"]) for h in (history or [])[-3:] if h.get("q") and h.get("a")]
    try:
        ctx_text = format_context(ctx, kb)
    except (KeyError, TypeError, AttributeError) as e:
        print(f"[ask] контекст сцены не разобран ({e}) — отвечаю без него")
        ctx_text = ""
    # Предварительный поиск: по вопросу и по именам NPC, о которых, скорее всего, речь (ходящий в бою, выделенные).
    # Часто модели этого хватает, и экономится целый круг обращения к ней.
    fast = role == "fast"
    names = []
    cur = ((ctx or {}).get("combat") or {}).get("current")
    tac = (ctx or {}).get("tactics") or None
    focus = (tac or {}).get("focus") if isinstance(tac, dict) else None
    for t in ([focus] if isinstance(focus, dict) else []) + ([cur] if isinstance(cur, dict) else []) + list((ctx or {}).get("selected") or []):
        n = t.get("name") if isinstance(t, dict) else None
        if n and n not in names and t.get("side") != "pc":
            names.append(n)
    tactics = role == "tactics"
    # Для тактики общий вопрос («как сходить») ищет мусор — ищем только по имени существа.
    if on_event:
        on_event({"type": "status", "text": "ищу в базе…"})
    pre_parts = [] if tactics else [run_tool("search_lore", {"query": question, "limit": 6 if fast else 4})]
    for n in names[:3]:
        r = run_tool("search_lore", {"query": n, "limit": 3 if tactics else 2})
        if not r.startswith("По запросу"):
            pre_parts.append(r)
    pre = "\n\n---\n\n".join(pre_parts) or "ничего не найдено"
    user_text = (
        (f"Текущее состояние игры:\n{ctx_text}\n\n" if ctx_text else "")
        + f"Предварительный поиск по вопросу (если этого мало — ищи сам):\n{pre}\n\n"
        + f"Вопрос мастера: {question}"
    )
    tac_text = format_tactics(tac) if isinstance(tac, dict) else ""
    if tac_text:
        user_text = f"{tac_text}\n\n{user_text}"
        if role == "tactics":
            user_text += "\n\n" + (en.TACTICS_TASK if campaign.is_english(lang) else TACTICS_TASK).format(name=(focus or {}).get("name", "?"))
    if fast:
        user_text += "\n\n(Быстрый режим: ответь коротко, только по найденному выше, без новых поисков.)"
        answer = await run_tool_loop(
            model, campaign.render({"ru": SYSTEM, "en": en.ADVISOR_SYSTEM}, lang, bible), hist, user_text, TOOLS, run_tool, usage,
            max_rounds=1, max_tokens=800, reasoning=settings.openai_reasoning_fast, on_event=on_event,
        )
    else:
        answer = await run_tool_loop(model, campaign.render({"ru": SYSTEM, "en": en.ADVISOR_SYSTEM}, lang, bible), hist, user_text, TOOLS, run_tool, usage, max_rounds=MAX_ROUNDS, on_event=on_event)

    answer = answer or "Не удалось сформулировать ответ."
    cited = collect_citations(answer, reg)

    elapsed = round(time.time() - t0, 1)
    usage.log("ask", {"question": question[:200], "seconds": elapsed, "tools": len(tool_log), "role": role})
    return {"answer": answer, "citations": cited, "usage": usage.as_dict(), "seconds": elapsed, "tools": tool_log}
