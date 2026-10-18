"""«К игре»: сводка перед сессией — где остановились, незакрытые нити, NPC и фракции впереди, что из книги пригодится.

Источники: последние итоги из дневника (присылает модуль), заметки мастера, страницы активной сцены (boost в поиске),
база знаний через инструменты search_lore / read_page.
"""

from __future__ import annotations

import time

from . import campaign
from . import prompts_en as en
from .advisor import TOOLS, collect_citations, make_tools
from .kb import KnowledgeBase
from .llm import model_for, run_tool_loop
from .session import _party_text
from .usage import Usage

PREP_SYSTEM = """Ты — помощник мастера настольной ролевой игры. Мастер садится готовиться к ближайшей сессии.

{campaign}
 Составь для него сводку «К игре»: одна страница, которую он прочитает вместо перечитывания трёх журналов. Читает только мастер, спойлеры допустимы.

Что у тебя есть:
- итоги последних сессий из «Дневника кампании» (самое свежее — внизу); это главный источник о том, где партия сейчас;
- заметки мастера к этой сессии — важнее всего остального;
- страницы активной сцены (если мастер её открыл) — скорее всего, туда партия и пойдёт;
- база знаний: книга приключения, справочник мира, шпаргалки мастера, правила — ищи через search_lore, читай целиком через read_page.

Правила:
- Героев называй по именам персонажей, игроков — как в итогах.
- Ищи активно: 3–6 поисков. Сначала то, что названо в последних итогах (места, NPC, фракции, предметы), потом ближайшие локации по книге. Поиски делай параллельно.
- Каждое утверждение из книги или справочника — со ссылкой [S#] при первом упоминании. Что взято из итогов — без ссылки, но помечай «(по итогам)».
- Не выдумывай. Если по книге дальше несколько вариантов — перечисли, не выбирай за мастера. Если чего-то нет в материалах — так и скажи одной строкой и предложи заготовку с пометкой «Импровизация:».
- Коротко: мастер читает это за 5 минут. Списки, не абзацы.

Формат (Markdown):
# К игре — <короткое название, 2–5 слов>
## Где остановились
3–5 строк: место, время суток/дата кампании если известны, состояние партии (ресурсы, раненые, настрой), что собирались делать.
## Незакрытые нити
Обещания, долги, неразрешённые вопросы, за кем партия охотится и кто охотится за ней. Каждая — одной строкой, с тем, кто вовлечён.
## Кто впереди
NPC и фракции, с которыми партия почти наверняка столкнётся: чего хочет, как говорит, что знает о партии, как настроен сейчас. По 2–3 строки на каждого.
## Что пригодится из книги
Локации и сцены, к которым партия ближе всего: ключевые описания, ловушки, встречи, награды — со ссылками. Статблоки не переписывай, только название и ссылка.
## Правила, которые могут всплыть
2–4 пункта: что в этой части игры часто спрашивают (особые правила кампании, конкретные заклинания, домашние правила), со ссылками.
## Если партия пойдёт не туда
2–3 запасных варианта: куда ещё логично отправиться и что там есть.
## Чек-лист мастера
3–6 пунктов: что подготовить (карты, раздатки, музыка, имена), что помнить про хитрости игроков."""


async def prepare(kb: KnowledgeBase, summaries: list[str], notes: str = "", party: list | None = None,
                  scene: dict | None = None, lang: str = "ru", bible: dict | None = None) -> dict:
    t0 = time.time()
    model = model_for("lore")
    usage = Usage(model)
    boost = set((scene or {}).get("pageUuids", []))
    run_tool, reg, tool_log = make_tools(kb, boost, english=campaign.is_english(lang))

    header = []
    if party:
        header.append(f"Партия: {_party_text(party)}")
    if scene and scene.get("name"):
        pages = ", ".join(f"{kb.pages[u].entry} › {kb.pages[u].page}" for u in scene.get("pageUuids", [])[:10] if u in kb.pages)
        header.append(f"Активная сцена: {scene['name']}" + (f" (страницы: {pages})" if pages else ""))
        if scene.get("notes"):
            header.append("Заметки сцены:\n" + "\n".join(f"- {n}" for n in scene["notes"][:15]))
    if notes.strip():
        header.append(f"Заметки мастера к этой сессии (важнее всего):\n{notes.strip()}")
    if summaries:
        parts = [f"--- Итоги {i + 1} из {len(summaries)} ---\n{s.strip()[-6000:]}" for i, s in enumerate(summaries) if s.strip()]
        header.append("Итоги последних сессий (самое свежее — последнее):\n\n" + "\n\n".join(parts))
    else:
        header.append("Итогов прошлых сессий нет — это начало кампании или дневник пуст: опирайся на заметки мастера и первую главу книги.")
    user_text = "\n\n".join(header) + "\n\nСоставь сводку «К игре»."

    answer = await run_tool_loop(model, campaign.render({"ru": PREP_SYSTEM, "en": en.PREP_SYSTEM}, lang, bible, style=False), [], user_text, TOOLS, run_tool, usage,
                                 max_rounds=6, max_tokens=3500)
    cited = collect_citations(answer, reg)
    elapsed = round(time.time() - t0, 1)
    usage.log("prep", {"summaries": len(summaries), "seconds": elapsed, "tools": len(tool_log)})
    return {"markdown": answer, "citations": cited, "usage": usage.as_dict(), "seconds": elapsed, "tools": tool_log}
