"""Проверка настройки: ключи моделей (Claude / OpenAI), Discord-бот, видеокарта.

Запуск: check_setup.bat. Ничего не меняет, секреты не печатает.
Проверочный вызов модели стоит доли цента.
"""

from __future__ import annotations

import os
import subprocess
import sys

OK, FAIL, WARN = "  [ OK ] ", "  [FAIL] ", "  [ !! ] "
problems = 0


def bad(msg: str) -> None:
    global problems
    problems += 1
    print(FAIL + msg)


def note(required: bool, msg: str) -> None:
    """Ошибка провайдера, который сейчас используется, — проблема; запасного — только предупреждение."""
    if required:
        bad(msg)
    else:
        print(WARN + msg + " (сейчас не используется)")


def check_anthropic(settings, required: bool, models: list[str]) -> None:
    print("\nClaude API")
    if not settings.anthropic_api_key:
        note(required, "ANTHROPIC_API_KEY пустой")
        return
    import anthropic

    c = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    probe = models[-1] if models else "claude-haiku-4-5-20251001"
    try:
        r = c.messages.create(model=probe, max_tokens=20, messages=[{"role": "user", "content": "Ответь одним словом: работает?"}])
        text = "".join(b.text for b in r.content if b.type == "text").strip()
        print(OK + f"ключ работает, {probe} ответила: «{text}»")
    except anthropic.AuthenticationError:
        note(required, "ключ не принят (неверный или отозван)")
        return
    except anthropic.PermissionDeniedError as e:
        note(required, f"доступ запрещён: {e.message}")
        return
    except anthropic.BadRequestError as e:
        note(required, f"запрос отклонён: {e.message}")
        return
    except anthropic.APIConnectionError:
        note(required, "нет связи с api.anthropic.com")
        return
    except anthropic.APIStatusError as e:
        note(required, f"ошибка {e.status_code}: {e.message}")
        return
    for m in models:
        try:
            c.models.retrieve(m)
            print(OK + f"модель {m} доступна")
        except anthropic.APIStatusError as e:
            note(required, f"модель {m}: {e.status_code} {e.message}")


def check_openai(settings, required: bool, models: list[str]) -> None:
    print("\nOpenAI API")
    if not settings.openai_api_key:
        note(required, "OPENAI_API_KEY пустой")
        return
    import openai

    c = openai.OpenAI(api_key=settings.openai_api_key)
    probe = models[-1] if models else "gpt-6-luna"
    try:
        r = c.responses.create(model=probe, input="Ответь одним словом: работает?", max_output_tokens=300, reasoning={"effort": "low"})
        print(OK + f"ключ работает, {probe} ответила: «{(r.output_text or '').strip()}»")
    except openai.AuthenticationError:
        note(required, "ключ не принят (неверный или отозван)")
        return
    except openai.PermissionDeniedError as e:
        note(required, f"доступ запрещён: {e.message}")
        return
    except openai.RateLimitError as e:
        note(required, f"лимит или нет денег на балансе: {e.message}  (platform.openai.com → Billing)")
        return
    except openai.APIConnectionError:
        note(required, "нет связи с api.openai.com")
        return
    except openai.APIStatusError as e:
        note(required, f"ошибка {e.status_code}: {e.message}")
        return
    for m in models:
        try:
            c.models.retrieve(m)
            print(OK + f"модель {m} доступна")
        except openai.APIStatusError as e:
            note(required, f"модель {m}: {e.status_code} {e.message}")


def main() -> int:
    print(f"\nPython {sys.version.split()[0]}")
    if sys.version_info < (3, 10):
        bad("нужен Python 3.10 или новее")

    try:
        from gmw.config import ENV_PATH, settings
    except Exception as e:  # noqa: BLE001
        bad(f"не удалось загрузить настройки: {e}")
        return 1
    print(f"Файл настроек: {ENV_PATH} — {'есть' if ENV_PATH.exists() else 'НЕТ'}")

    from gmw.llm import model_for, provider_for

    roles = {"лор": model_for("lore"), "тактика": model_for("tactics"), "фон": model_for("fast")}
    if settings.model_lore.lower() == "auto":
        print("Модели выбираются автоматически по заданному ключу (поменять: Foundry → панель GM Whispers → ⚙).")
    used = {provider_for(m) for m in roles.values()}
    print("\nМодели по ролям: " + ", ".join(f"{r}={m}" for r, m in roles.items()))

    # --- Claude API
    if "anthropic" in used or settings.anthropic_api_key:
        check_anthropic(settings, required="anthropic" in used, models=[m for m in roles.values() if provider_for(m) == "anthropic"])

    # --- OpenAI
    if "openai" in used or settings.openai_api_key:
        check_openai(settings, required="openai" in used, models=[m for m in roles.values() if provider_for(m) == "openai"])

    # --- Discord
    print("\nDiscord")
    import httpx

    if not settings.discord_bot_token:
        bad("DISCORD_BOT_TOKEN пустой")
    else:
        h = {"Authorization": f"Bot {settings.discord_bot_token}"}
        base = "https://discord.com/api/v10"
        try:
            with httpx.Client(headers=h, timeout=15) as d:
                r = d.get(f"{base}/users/@me")
                if r.status_code != 200:
                    bad(f"токен бота не принят ({r.status_code})")
                else:
                    print(OK + f"бот: {r.json().get('username')}")
                    if settings.discord_guild_id:
                        g = d.get(f"{base}/guilds/{settings.discord_guild_id}")
                        if g.status_code == 200:
                            print(OK + f"бот на сервере «{g.json().get('name')}»")
                        else:
                            bad(f"бот не видит сервер {settings.discord_guild_id} ({g.status_code}) — не добавлен или неверный ID")
                    else:
                        bad("DISCORD_GUILD_ID пустой")
                    if settings.discord_voice_channel_id:
                        ch = d.get(f"{base}/channels/{settings.discord_voice_channel_id}")
                        if ch.status_code == 200:
                            j = ch.json()
                            kind = {2: "голосовой", 13: "сцена (stage)"}.get(j.get("type"), f"тип {j.get('type')} — НЕ голосовой")
                            print((OK if j.get("type") in (2, 13) else WARN) + f"канал «{j.get('name')}» ({kind})")
                        else:
                            bad(f"бот не видит канал {settings.discord_voice_channel_id} ({ch.status_code})")
                    if settings.discord_owner_id and settings.discord_guild_id:
                        m = d.get(f"{base}/guilds/{settings.discord_guild_id}/members/{settings.discord_owner_id}")
                        if m.status_code == 200:
                            u = m.json().get("user", {})
                            print(OK + f"владелец: {u.get('global_name') or u.get('username')}")
                        else:
                            bad(f"DISCORD_OWNER_ID не найден на сервере ({m.status_code})")
        except httpx.HTTPError as e:
            bad(f"нет связи с discord.com: {e}")

    # --- GPU
    print("\nВидеокарта")
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,memory.used,driver_version", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=10,
        )
        if out.returncode == 0 and out.stdout.strip():
            print(OK + out.stdout.strip())
        else:
            print(WARN + "nvidia-smi не ответил (для распознавания речи понадобится драйвер NVIDIA)")
    except (OSError, subprocess.SubprocessError):
        print(WARN + "nvidia-smi не найден")

    print("\n" + ("Всё в порядке." if not problems else f"Проблем: {problems}. Подробности выше."))
    print(f"\nЛокальный токен для модуля Foundry: {settings.local_token}\n")
    return 1 if problems else 0


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    sys.exit(main())
