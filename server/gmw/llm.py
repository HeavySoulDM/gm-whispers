"""Переходник к языковым моделям.

Провайдер определяется по названию модели:
  claude-…            → Claude API (Anthropic), ключ ANTHROPIC_API_KEY
  gpt-… / o… / chatgpt → OpenAI (Responses API), ключ OPENAI_API_KEY

Модель для каждой роли задаётся в .env (GMW_MODEL_LORE / GMW_MODEL_TACTICS / GMW_MODEL_FAST),
так что провайдеров можно смешивать и переключать без правки кода.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Callable

from .config import settings
from .usage import Usage


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict  # JSON Schema аргументов


Executor = Callable[[str, dict], str]


# ---------------------------------------------------------------- провайдеры
#
# Модель задаётся строкой «провайдер:модель» (openrouter:anthropic/claude-sonnet-4.5, gemini:gemini-2.5-pro,
# deepseek:deepseek-chat, custom:имя-модели). Без префикса провайдер угадывается по названию:
# claude-… → anthropic, gpt-…/o… → openai, gemini-… → gemini, deepseek-… → deepseek, «a/b» → openrouter.
#
# Claude и OpenAI идут через их родные API; остальные — через совместимый с OpenAI Chat Completions
# (у Gemini, DeepSeek, OpenRouter такой есть; «custom» — любой сервис с таким API: RouterAI и т. п.).

PROVIDERS = {
    "anthropic": {"title": "Claude (Anthropic)", "key": "anthropic_api_key"},
    "openai": {"title": "OpenAI", "key": "openai_api_key"},
    "gemini": {"title": "Gemini (Google)", "key": "gemini_api_key",
               "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/"},
    "deepseek": {"title": "DeepSeek", "key": "deepseek_api_key", "base_url": "https://api.deepseek.com"},
    "openrouter": {"title": "OpenRouter", "key": "openrouter_api_key", "base_url": "https://openrouter.ai/api/v1"},
    "custom": {"title": "Свой провайдер (совместимый с OpenAI API)", "key": "custom_api_key", "base_url": None},
}
PROVIDER_ORDER = ["anthropic", "openai", "gemini", "deepseek", "openrouter", "custom"]

# Что подставляется при «auto»: лор и итоги — сильная модель, тактика — средняя, быстрые реплики — дешёвая.
DEFAULT_MODELS = {
    "anthropic": {"lore": "claude-opus-5-5", "tactics": "claude-sonnet-5-5", "fast": "claude-haiku-4-5-20251001"},
    "openai": {"lore": "gpt-6.1-sol", "tactics": "gpt-6.1-sol", "fast": "gpt-6-luna"},
    "gemini": {"lore": "gemini:gemini-2.5-pro", "tactics": "gemini:gemini-2.5-pro", "fast": "gemini:gemini-2.5-flash"},
    "deepseek": {"lore": "deepseek:deepseek-chat", "tactics": "deepseek:deepseek-chat", "fast": "deepseek:deepseek-chat"},
    "openrouter": {"lore": "openrouter:anthropic/claude-sonnet-4.5", "tactics": "openrouter:anthropic/claude-sonnet-4.5",
                   "fast": "openrouter:google/gemini-2.5-flash"},
    "custom": {"lore": "custom:", "tactics": "custom:", "fast": "custom:"},
}


def api_key_for(provider: str) -> str:
    return getattr(settings, PROVIDERS.get(provider, PROVIDERS["anthropic"])["key"], "") or ""


def default_provider() -> str:
    """Провайдер для «auto»: первый по порядку PROVIDER_ORDER, у которого задан ключ."""
    for p in PROVIDER_ORDER:
        if api_key_for(p):
            return p
    return "anthropic"


def split_model(model: str) -> tuple[str, str]:
    """«провайдер:модель» → (провайдер, модель). Без префикса — по названию."""
    m = (model or "").strip()
    if ":" in m:
        p, _, name = m.partition(":")
        p = p.strip().lower()
        if p in PROVIDERS:
            return p, name.strip()
    low = m.lower()
    if low.startswith(("gpt", "chatgpt", "o1", "o3", "o4")):
        return "openai", m
    if low.startswith("gemini"):
        return "gemini", m
    if low.startswith("deepseek"):
        return "deepseek", m
    if "/" in m:
        return "openrouter", m
    return "anthropic", m


def provider_for(model: str) -> str:
    return split_model(model)[0]


def model_for(role: str) -> str:
    raw = {"lore": settings.model_lore, "tactics": settings.model_tactics, "fast": settings.model_fast}.get(role, settings.model_lore)
    if not raw or raw.lower() == "auto":
        p = default_provider()
        m = DEFAULT_MODELS[p].get(role, DEFAULT_MODELS[p]["lore"])
        if p == "custom":
            m = "custom:" + (settings.custom_model or "")
        return m
    return raw


def has_key(model: str) -> bool:
    p, name = split_model(model)
    if p == "custom":
        return bool(settings.custom_api_key and settings.custom_base_url and name)
    return bool(api_key_for(p))


_clients: dict[str, object] = {}


def reset_clients() -> None:
    """После смены ключей в настройках клиенты создаются заново."""
    _clients.clear()


def _compat_client(provider: str, api_key: str | None = None, base_url: str | None = None, timeout: float = 180.0):
    """Клиент OpenAI SDK для совместимого провайдера (Gemini, DeepSeek, OpenRouter, свой)."""
    from openai import AsyncOpenAI

    key = api_key or api_key_for(provider)
    url = base_url or (settings.custom_base_url if provider == "custom" else PROVIDERS[provider].get("base_url"))
    if not key:
        raise LLMError(f"Ключ {PROVIDERS[provider]['title']} не задан. Открой «Настройки сервера» в панели GM Whispers.", 409)
    if not url:
        raise LLMError("Для своего провайдера не задан адрес API (base URL).", 409)
    headers = {"HTTP-Referer": "https://github.com/gm-whispers", "X-Title": "GM Whispers"} if provider == "openrouter" else None
    return AsyncOpenAI(api_key=key, base_url=url, timeout=timeout, max_retries=2, default_headers=headers)


def anthropic_client():
    if "anthropic" not in _clients:
        from anthropic import AsyncAnthropic

        if not settings.anthropic_api_key:
            raise LLMError("Ключ Claude не задан. Открой «Настройки сервера» в панели GM Whispers.", 409)
        _clients["anthropic"] = AsyncAnthropic(api_key=settings.anthropic_api_key, timeout=120.0, max_retries=2)
    return _clients["anthropic"]


def openai_client():
    if "openai" not in _clients:
        from openai import AsyncOpenAI

        if not settings.openai_api_key:
            raise LLMError("Ключ OpenAI не задан. Открой «Настройки сервера» в панели GM Whispers.", 409)
        _clients["openai"] = AsyncOpenAI(api_key=settings.openai_api_key, timeout=180.0, max_retries=2)
    return _clients["openai"]


def compat_client(provider: str):
    if provider not in _clients:
        _clients[provider] = _compat_client(provider)
    return _clients[provider]


async def list_models(provider: str, api_key: str | None = None, base_url: str | None = None) -> list[str]:
    """Проверить ключ и получить список моделей, доступных этому ключу (запрос бесплатный).
    api_key / base_url — проверить ещё не сохранённые значения; None — взять из настроек."""
    key = (api_key or "").strip() or None
    try:
        if provider == "anthropic":
            from anthropic import AsyncAnthropic

            key = key or settings.anthropic_api_key
            if not key:
                raise LLMError("Ключ Claude не задан", 400)
            page = await AsyncAnthropic(api_key=key, timeout=30.0, max_retries=1).models.list(limit=100)
            ids = [m.id for m in page.data]
        elif provider == "openai":
            from openai import AsyncOpenAI

            key = key or settings.openai_api_key
            if not key:
                raise LLMError("Ключ OpenAI не задан", 400)
            page = await AsyncOpenAI(api_key=key, timeout=30.0, max_retries=1).models.list()
            ids = [m.id for m in page.data if m.id.startswith(("gpt-", "o1", "o3", "o4"))
                   and not any(x in m.id for x in ("audio", "realtime", "image", "tts", "transcribe", "embedding", "search", "moderation", "codex"))]
        elif provider in PROVIDERS:
            client = _compat_client(provider, key, (base_url or "").strip() or None, timeout=30.0)
            page = await client.models.list()
            ids = []
            for m in page.data:
                mid = str(m.id)
                if provider == "gemini":
                    mid = mid.removeprefix("models/")
                    if not mid.startswith("gemini") or any(x in mid for x in ("embedding", "tts", "image", "audio", "live", "aqa")):
                        continue
                ids.append(f"{provider}:{mid}")
        else:
            raise LLMError(f"Неизвестный провайдер: {provider}", 400)
    except LLMError:
        raise
    except Exception as e:  # noqa: BLE001
        raise explain_error(e) from e
    return sorted(set(ids), reverse=True)


class LLMError(Exception):
    """Понятная мастеру ошибка обращения к модели."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.message = message
        self.status = status


def explain_error(e: Exception) -> LLMError:
    """Переводит исключения SDK обоих провайдеров в понятное сообщение."""
    if isinstance(e, LLMError):
        return e
    name = type(e).__name__
    mod = type(e).__module__.split(".")[0]
    who = {"anthropic": "Claude API", "openai": "Провайдер модели"}.get(mod, "Модель")
    msg = getattr(e, "message", None) or str(e)
    low = msg.lower()
    if name == "AuthenticationError":
        return LLMError(f"{who}: неверный ключ.")
    if name == "PermissionDeniedError":
        return LLMError(f"{who}: доступ запрещён — {msg}")
    if name == "NotFoundError":
        return LLMError(f"{who}: модель не найдена — {msg}")
    if name == "RateLimitError":
        if "quota" in low or "billing" in low:
            return LLMError(f"{who}: закончились деньги на балансе или превышен лимит трат.", 402)
        return LLMError(f"{who}: слишком много запросов, подожди минуту.", 429)
    if name == "BadRequestError" and ("credit" in low or "balance" in low):
        return LLMError(f"{who}: на балансе закончились деньги.", 402)
    if name in ("APIConnectionError", "APITimeoutError"):
        return LLMError(f"{who}: нет связи с сервером модели.")
    status = getattr(e, "status_code", None)
    return LLMError(f"{who}: ошибка{' ' + str(status) if status else ''} — {msg}")


# ---------------------------------------------------------------- цикл с инструментами


async def run_tool_loop(
    model: str,
    system: str,
    history: list[tuple[str, str]],
    user_text: str,
    tools: list[Tool],
    execute: Executor,
    usage: Usage,
    max_rounds: int = 8,
    max_tokens: int = 2000,
    reasoning: str | None = None,
    on_event: Callable[[dict], None] | None = None,
) -> str:
    """Диалог «модель ↔ инструменты», пока модель не даст финальный ответ. Возвращает текст ответа.

    on_event — потоковый вывод: получает {"type": "delta", "text"} по мере генерации, {"type": "reset"} если
    модель решила искать дальше (набранный текст не финальный), {"type": "status", "text"} — что делает."""
    try:
        provider, name = split_model(model)
        if provider == "openai":
            return await _openai_loop(name, system, history, user_text, tools, execute, usage, max_rounds, max_tokens, reasoning, on_event)
        if provider == "anthropic":
            return await _anthropic_loop(name, system, history, user_text, tools, execute, usage, max_rounds, max_tokens, on_event)
        return await _chat_loop(provider, name, system, history, user_text, tools, execute, usage, max_rounds, max_tokens, on_event)
    except Exception as e:  # noqa: BLE001
        if type(e).__module__.split(".")[0] in ("anthropic", "openai") or isinstance(e, LLMError):
            raise explain_error(e) from e
        raise


def _emit(on_event, ev: dict) -> None:
    if on_event:
        try:
            on_event(ev)
        except Exception:  # noqa: BLE001 — поток не должен ломать ответ
            pass


def _tool_status(calls: list[tuple[str, dict]]) -> str:
    bits = []
    for name, args in calls:
        if name == "search_lore":
            bits.append(f"ищу: {args.get('query', '')}")
        elif name == "read_page":
            bits.append("читаю страницу")
        else:
            bits.append(name)
    return " · ".join(bits)[:200]


def _strip_cache_marks(messages: list) -> None:
    for m in messages:
        if isinstance(m.get("content"), list):
            for b in m["content"]:
                if isinstance(b, dict):
                    b.pop("cache_control", None)


async def _anthropic_loop(model, system, history, user_text, tools, execute, usage, max_rounds, max_tokens, on_event=None) -> str:
    api = anthropic_client()
    a_tools = [{"name": t.name, "description": t.description, "input_schema": t.parameters} for t in tools]
    messages: list = []
    for q, a in history:
        messages += [{"role": "user", "content": q}, {"role": "assistant", "content": a}]
    messages.append({"role": "user", "content": [{"type": "text", "text": user_text}]})
    sys_blocks = [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]

    for rnd in range(max_rounds):
        _strip_cache_marks(messages)
        if isinstance(messages[-1]["content"], list):
            messages[-1]["content"][-1]["cache_control"] = {"type": "ephemeral"}
        last = rnd == max_rounds - 1
        t0 = time.time()
        kw = dict(model=model, max_tokens=max_tokens, system=sys_blocks, messages=messages)
        if a_tools:
            kw.update(tools=a_tools, tool_choice={"type": "none"} if last else {"type": "auto"})
        if on_event:
            async with api.messages.stream(**kw) as stream:
                async for ev in stream:
                    if getattr(ev, "type", "") == "content_block_delta" and getattr(ev.delta, "type", "") == "text_delta":
                        _emit(on_event, {"type": "delta", "text": ev.delta.text})
                resp = await stream.get_final_message()
        else:
            resp = await api.messages.create(**kw)
        usage.rounds.append(round(time.time() - t0, 1))
        usage.add_anthropic(resp.usage)
        messages.append({"role": "assistant", "content": [b.model_dump(exclude_none=True) for b in resp.content]})
        if resp.stop_reason != "tool_use":
            return "\n".join(b.text for b in resp.content if b.type == "text").strip()
        calls = [(b.name, b.input or {}) for b in resp.content if b.type == "tool_use"]
        _emit(on_event, {"type": "reset"})
        _emit(on_event, {"type": "status", "text": _tool_status(calls)})
        results = [
            {"type": "tool_result", "tool_use_id": b.id, "content": execute(b.name, b.input or {})}
            for b in resp.content
            if b.type == "tool_use"
        ]
        messages.append({"role": "user", "content": results})
    return ""


async def _openai_loop(model, system, history, user_text, tools, execute, usage, max_rounds, max_tokens, reasoning=None, on_event=None) -> str:
    api = openai_client()
    o_tools = [
        {"type": "function", "name": t.name, "description": t.description, "parameters": t.parameters, "strict": False}
        for t in tools
    ]
    pending: list = []
    for q, a in history:
        pending += [{"role": "user", "content": q}, {"role": "assistant", "content": a}]
    pending.append({"role": "user", "content": user_text})
    prev_id = None

    for rnd in range(max_rounds):
        last = rnd == max_rounds - 1
        kwargs = dict(
            model=model,
            instructions=system,
            input=pending,
            # В лимит входят и «размышления» модели, поэтому запас больше, чем у Claude.
            max_output_tokens=max_tokens * 3,
            prompt_cache_key="gm-whispers",
        )
        effort = settings.openai_reasoning if reasoning is None else reasoning
        if effort:
            kwargs["reasoning"] = {"effort": effort}
        if o_tools:
            kwargs.update(tools=o_tools, tool_choice="none" if last else "auto")
        if prev_id:
            kwargs["previous_response_id"] = prev_id
        t0 = time.time()
        if on_event:
            resp = None
            stream = await api.responses.create(stream=True, **kwargs)
            async for ev in stream:
                et = getattr(ev, "type", "")
                if et == "response.output_text.delta":
                    _emit(on_event, {"type": "delta", "text": ev.delta})
                elif et in ("response.completed", "response.incomplete"):
                    resp = ev.response
            if resp is None:
                raise LLMError("Поток ответа оборвался без завершения.")
        else:
            resp = await api.responses.create(**kwargs)
        usage.rounds.append(round(time.time() - t0, 1))
        usage.add_openai(resp.usage)
        calls = [it for it in resp.output if it.type == "function_call"]
        if not calls:
            return (resp.output_text or "").strip()
        prev_id = resp.id
        pending = []
        parsed = []
        for c in calls:
            try:
                parsed.append((c.name, json.loads(c.arguments or "{}")))
            except ValueError:
                parsed.append((c.name, {}))
        _emit(on_event, {"type": "reset"})
        _emit(on_event, {"type": "status", "text": _tool_status(parsed)})
        for c in calls:
            try:
                args = json.loads(c.arguments or "{}")
            except ValueError:
                args = {}
            pending.append({"type": "function_call_output", "call_id": c.call_id, "output": execute(c.name, args)})
    return ""


async def _chat_loop(provider, model, system, history, user_text, tools, execute, usage, max_rounds, max_tokens, on_event=None) -> str:
    """Chat Completions с function calling — общий формат для Gemini, DeepSeek, OpenRouter и своих провайдеров."""
    api = compat_client(provider)
    if not model:
        raise LLMError("Не задано название модели для провайдера «%s». Открой «Настройки сервера»." % PROVIDERS[provider]["title"], 409)
    c_tools = [{"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.parameters}} for t in tools]
    messages: list[dict] = [{"role": "system", "content": system}]
    for q, a in history:
        messages += [{"role": "user", "content": q}, {"role": "assistant", "content": a}]
    messages.append({"role": "user", "content": user_text})

    for rnd in range(max_rounds):
        last = rnd == max_rounds - 1
        kwargs: dict = dict(model=model, messages=messages, max_tokens=max_tokens * 2)
        if c_tools and not last:
            kwargs.update(tools=c_tools, tool_choice="auto")
        t0 = time.time()
        if on_event:
            msg, chat_usage = await _chat_stream(api, kwargs, provider, on_event)
        else:
            resp = await api.chat.completions.create(**kwargs)
            choice = resp.choices[0] if resp.choices else None
            msg = choice.message if choice else None
            chat_usage = getattr(resp, "usage", None)
        usage.rounds.append(round(time.time() - t0, 1))
        usage.add_chat(chat_usage)
        calls = list(getattr(msg, "tool_calls", None) or []) if msg else []
        if not calls:
            return ((msg.content if msg else "") or "").strip()
        parsed = []
        for c in calls:
            try:
                parsed.append((c.function.name, json.loads(c.function.arguments or "{}")))
            except ValueError:
                parsed.append((c.function.name, {}))
        _emit(on_event, {"type": "reset"})
        _emit(on_event, {"type": "status", "text": _tool_status(parsed)})
        messages.append({
            "role": "assistant",
            "content": msg.content or "",
            "tool_calls": [{"id": c.id, "type": "function", "function": {"name": c.function.name, "arguments": c.function.arguments or "{}"}} for c in calls],
        })
        for c in calls:
            try:
                args = json.loads(c.function.arguments or "{}")
            except ValueError:
                args = {}
            messages.append({"role": "tool", "tool_call_id": c.id, "content": execute(c.function.name, args)})
    return ""


class _Fn:
    def __init__(self, name="", arguments=""):
        self.name, self.arguments = name, arguments


class _Call:
    def __init__(self, id=""):
        self.id, self.function = id, _Fn()


class _Msg:
    def __init__(self):
        self.content, self.tool_calls = "", []


async def _chat_stream(api, kwargs: dict, provider: str, on_event):
    """Потоковый Chat Completions: собирает текст и вызовы инструментов из кусочков. Возвращает (сообщение, usage)."""
    kw = dict(kwargs, stream=True)
    if provider != "gemini":  # у совместимого API Gemini этот параметр не принимается
        kw["stream_options"] = {"include_usage": True}
    msg = _Msg()
    calls: dict[int, _Call] = {}
    chat_usage = None
    stream = await api.chat.completions.create(**kw)
    async for chunk in stream:
        if getattr(chunk, "usage", None):
            chat_usage = chunk.usage
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if delta is None:
            continue
        if delta.content:
            msg.content += delta.content
            _emit(on_event, {"type": "delta", "text": delta.content})
        for tc in delta.tool_calls or []:
            idx = getattr(tc, "index", 0) or 0
            call = calls.setdefault(idx, _Call())
            if tc.id:
                call.id = tc.id
            fn = getattr(tc, "function", None)
            if fn is not None:
                if fn.name:
                    call.function.name = fn.name
                if fn.arguments:
                    call.function.arguments += fn.arguments
    msg.tool_calls = [calls[i] for i in sorted(calls)]
    for i, c in enumerate(msg.tool_calls):
        if not c.id:
            c.id = f"call_{i}"
    return msg, chat_usage
