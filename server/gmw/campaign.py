"""Профиль кампании: название, система, мир, тон, особые правила, язык ответов.

Хранится в server/config/campaign.json, правится из окна «Настройки сервера». Из него собирается
общий блок для всех промптов — чтобы модуль работал с любой кампанией, а не только с одной.
"""

from __future__ import annotations

import json

from .config import SERVER_DIR

CAMPAIGN_PATH = SERVER_DIR / "config" / "campaign.json"

DEFAULT = {
    "name": "",
    "system": "",          # например «D&D 5e (правила 2024)»; модуль подсказывает название системы Foundry
    "description": "",     # мир и сюжет в 2–5 предложениях
    "tone": "",            # как отвечать: тон, стиль NPC, что любит стол
    "special_rules": "",   # домашние и особые правила, которые важнее общих
    "lang": "auto",        # язык ответов: auto (язык Foundry) или код ru/en/…
    # Стиль ответов советника (D1): длина и три переключателя.
    "answer_length": "normal",   # short / normal / long
    "lines_only": "0",           # 1 — на просьбу о реплике давать только реплики, без пояснений
    "no_improv": "0",            # 1 — не предлагать импровизацию, если в материалах нет ответа (только сказать, что нет)
    "player_names": "0",         # 1 — рядом с именем персонажа упоминать игрока: «Мира (Лера)»
}

LENGTH_RULES = {
    "short": "Отвечай очень коротко: 1–3 предложения или до 4 пунктов списка. Без вступлений и повторов вопроса. Детали — только если мастер попросит.",
    "normal": "Отвечай коротко и по делу: сначала суть (2–6 предложений или короткий список), детали — после, только если они нужны.",
    "long": "Отвечай полно: суть, затем детали, варианты и нюансы из материалов, со ссылками. Структурируй заголовками и списками.",
}

LANG_NAMES = {"ru": "русский", "en": "English", "uk": "українська", "de": "Deutsch", "fr": "français", "es": "español",
              "pl": "polski", "it": "italiano", "pt": "português", "cs": "čeština", "ja": "日本語", "zh": "中文", "ko": "한국어"}


def load() -> dict:
    try:
        data = json.loads(CAMPAIGN_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    out = dict(DEFAULT)
    for k in DEFAULT:
        v = data.get(k)
        if isinstance(v, bool):
            v = "1" if v else "0"
        if isinstance(v, str):
            out[k] = v.strip()
    if out["answer_length"] not in LENGTH_RULES:
        out["answer_length"] = "normal"
    return out


def save(data: dict) -> dict:
    cur = load()
    for k in DEFAULT:
        if k in data and isinstance(data[k], bool):
            cur[k] = "1" if data[k] else "0"
        elif k in data and isinstance(data[k], str):
            cur[k] = data[k].strip()
    if cur["answer_length"] not in LENGTH_RULES:
        cur["answer_length"] = "normal"
    if cur["lang"] and cur["lang"] != "auto" and not cur["lang"].isalpha():
        cur["lang"] = "auto"
    CAMPAIGN_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = CAMPAIGN_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(cur, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(CAMPAIGN_PATH)
    return cur


def resolve_lang(request_lang: str | None) -> str:
    """Язык ответа: из профиля, если задан явно, иначе язык Foundry из запроса, иначе русский."""
    p = load()
    if p["lang"] and p["lang"] != "auto":
        return p["lang"].lower()
    return (request_lang or "ru").split("-")[0].lower() or "ru"


def lang_name(code: str) -> str:
    return LANG_NAMES.get(code, code)


def is_english(request_lang: str | None = None) -> bool:
    """Английские промпты — когда язык ответа английский. Для остальных языков — русские промпты + строка «Язык ответов: …»."""
    return resolve_lang(request_lang) == "en"


def block(request_lang: str | None = None, style: bool = True) -> str:
    """Текст о кампании для системного промпта. style=False — без правил длины/стиля (итоги, «К игре», библия: у них свой формат)."""
    p = load()
    lang = resolve_lang(request_lang)
    if lang == "en":
        return _block_en(p, style)
    lines = []
    title = f"«{p['name']}»" if p["name"] else "(название не задано)"
    lines.append(f"Кампания: {title}." + (f" Система: {p['system']}." if p["system"] else ""))
    if p["description"]:
        lines.append(f"О мире и сюжете: {p['description']}")
    if p["tone"]:
        lines.append(f"Тон и стиль ответов: {p['tone']}")
    if p["special_rules"]:
        lines.append(f"Особые и домашние правила (важнее общих правил системы): {p['special_rules']}")
    lines.append(f"Язык ответов: {lang_name(lang)}. Имена и названия — как в материалах кампании.")
    if not style:
        return "\n".join(lines)
    lines.append(LENGTH_RULES.get(p["answer_length"], LENGTH_RULES["normal"]))
    if p["lines_only"] == "1":
        lines.append("Если мастер просит реплику NPC — давай только сами реплики (1–3 варианта), без пояснений и советов.")
    if p["no_improv"] == "1":
        lines.append("Если в материалах ответа нет — скажи это одной строкой и остановись; импровизацию предлагай только если мастер прямо попросил.")
    if p["player_names"] == "1":
        lines.append("Рядом с именем персонажа игрока при первом упоминании указывай игрока: «Мира (Лера)».")
    return "\n".join(lines)


def _block_en(p: dict, style: bool) -> str:
    from . import prompts_en as en

    lines = []
    title = f"\"{p['name']}\"" if p["name"] else "(no title set)"
    lines.append(f"Campaign: {title}." + (f" System: {p['system']}." if p["system"] else ""))
    if p["description"]:
        lines.append(f"World and plot: {p['description']}")
    if p["tone"]:
        lines.append(f"Tone and style of answers: {p['tone']}")
    if p["special_rules"]:
        lines.append(f"Special and house rules (override the system's general rules): {p['special_rules']}")
    lines.append("Answer in English. Names and titles as in the campaign materials.")
    if not style:
        return "\n".join(lines)
    lines.append(en.LENGTH_RULES.get(p["answer_length"], en.LENGTH_RULES["normal"]))
    if p["lines_only"] == "1":
        lines.append(en.STYLE_LINES_ONLY)
    if p["no_improv"] == "1":
        lines.append(en.STYLE_NO_IMPROV)
    if p["player_names"] == "1":
        lines.append(en.STYLE_PLAYER_NAMES)
    return "\n".join(lines)


def render(template, request_lang: str | None = None, bible: dict | None = None, style: bool = True) -> str:
    """Подставить {campaign} и {lang} в шаблон промпта; с библией — добавить её в конец (одним блоком, он кэшируется).
    template — строка или {"ru": ..., "en": ...}: английский шаблон берётся, когда язык ответа английский."""
    if isinstance(template, dict):
        template = template.get("en" if is_english(request_lang) else "ru") or template["ru"]
    out = template.replace("{campaign}", block(request_lang, style)).replace("{lang}", lang_name(resolve_lang(request_lang)))
    if bible:
        from .bible import prompt_block

        extra = prompt_block(bible, english=is_english(request_lang))
        if extra:
            out = out + "\n\n" + extra
    return out
