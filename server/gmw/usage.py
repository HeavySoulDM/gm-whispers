"""Учёт токенов и примерной стоимости. Лог: data/logs/usage.jsonl."""

from __future__ import annotations

import json
import time

from .config import settings

# $ за 1M токенов: (вход, выход, множитель для чтения из кэша).
# Claude: запись в кэш (5 мин) = 1.25 × вход. OpenAI: кэш автоматический, запись не доплачивается.
PRICES = {
    "opus": (4.0, 20.0, 0.05),
    "sonnet": (2.0, 10.0, 0.10),
    "haiku": (1.0, 5.0, 0.10),
    "astra": (5.0, 25.0, 0.10),
    "sol": (1.0, 5.0, 0.05),
    "luna": (0.05, 0.25, 0.10),
    # Gemini / DeepSeek — ориентиры; OpenRouter и свои провайдеры берут цену модели, если она угадана по названию.
    "gemini-2.5-pro": (1.25, 10.0, 0.25),
    "gemini-2.5-flash": (0.30, 2.50, 0.25),
    "gemini": (0.30, 2.50, 0.25),
    "deepseek-reasoner": (0.55, 2.19, 0.25),
    "deepseek": (0.27, 1.10, 0.25),
}
UNKNOWN_PRICE = (1.0, 5.0, 0.25)  # модель неизвестна — грубая оценка, в ответе помечается "≈"


def _price(model: str):
    m = model.lower()
    for key, p in PRICES.items():
        if key in m:
            return p
    return UNKNOWN_PRICE


def price_known(model: str) -> bool:
    m = model.lower()
    return any(key in m for key in PRICES)


class Usage:
    def __init__(self, model: str):
        self.model = model
        self.input = self.output = self.cache_write = self.cache_read = 0
        self.calls = 0
        self.rounds: list[float] = []  # секунды на каждое обращение к модели

    def add_anthropic(self, u) -> None:
        if u is None:
            return
        self.calls += 1
        self.input += getattr(u, "input_tokens", 0) or 0
        self.output += getattr(u, "output_tokens", 0) or 0
        self.cache_write += getattr(u, "cache_creation_input_tokens", 0) or 0
        self.cache_read += getattr(u, "cache_read_input_tokens", 0) or 0

    def add_openai(self, u) -> None:
        if u is None:
            return
        self.calls += 1
        total_in = getattr(u, "input_tokens", 0) or 0
        details = getattr(u, "input_tokens_details", None)
        cached = (getattr(details, "cached_tokens", 0) or 0) if details else 0
        self.input += max(0, total_in - cached)
        self.cache_read += cached
        self.output += getattr(u, "output_tokens", 0) or 0  # включая токены размышлений

    def add_chat(self, u) -> None:
        """Chat Completions (Gemini, DeepSeek, OpenRouter, свои): prompt_tokens / completion_tokens, кэш — если отдан."""
        if u is None:
            return
        self.calls += 1
        total_in = getattr(u, "prompt_tokens", 0) or 0
        details = getattr(u, "prompt_tokens_details", None)
        cached = (getattr(details, "cached_tokens", 0) or 0) if details else 0
        self.input += max(0, total_in - cached)
        self.cache_read += cached
        self.output += getattr(u, "completion_tokens", 0) or 0

    @property
    def cost(self) -> float:
        pin, pout, cr = _price(self.model)
        return (self.input * pin + self.cache_write * pin * 1.25 + self.cache_read * pin * cr + self.output * pout) / 1_000_000

    def as_dict(self) -> dict:
        return {
            "model": self.model,
            "calls": self.calls,
            "input": self.input,
            "output": self.output,
            "cache_write": self.cache_write,
            "cache_read": self.cache_read,
            "cost_usd": round(self.cost, 4),
            "cost_estimated": not price_known(self.model),
            "rounds": self.rounds,
        }

    def log(self, kind: str, extra: dict | None = None) -> None:
        _totals.add(kind, self.cost)
        try:
            settings.logs_dir.mkdir(parents=True, exist_ok=True)
            row = {"ts": time.strftime("%Y-%m-%d %H:%M:%S"), "kind": kind, **self.as_dict(), **(extra or {})}
            path = settings.logs_dir / "usage.jsonl"
            if path.exists() and path.stat().st_size > 5_000_000:  # ротация: старый лог остаётся рядом как .1
                path.replace(path.with_suffix(".jsonl.1"))
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError:
            pass


class _Totals:
    """Расход за сегодня и с запуска сервера — для строки статуса в панели. Сегодняшнее дочитывается из лога при старте."""

    def __init__(self):
        self.day = ""
        self.today: dict[str, list] = {}     # kind -> [calls, usd]
        self.since_start: dict[str, list] = {}
        self._loaded = False

    def _roll(self) -> None:
        day = time.strftime("%Y-%m-%d")
        if day != self.day:
            self.day, self.today = day, {}

    def _load(self) -> None:
        self._loaded = True
        self._roll()
        path = settings.logs_dir / "usage.jsonl"
        try:
            if not path.exists() or path.stat().st_size > 20_000_000:
                return
            for line in path.read_text(encoding="utf-8").splitlines()[-5000:]:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if str(row.get("ts", "")).startswith(self.day):
                    t = self.today.setdefault(row.get("kind", "?"), [0, 0.0])
                    t[0] += 1
                    t[1] += float(row.get("cost_usd") or 0)
        except OSError:
            pass

    def add(self, kind: str, usd: float) -> None:
        if not self._loaded:
            self._load()
        self._roll()
        for bucket in (self.today, self.since_start):
            t = bucket.setdefault(kind, [0, 0.0])
            t[0] += 1
            t[1] += usd

    def summary(self) -> dict:
        if not self._loaded:
            self._load()
        self._roll()
        fmt = lambda b: {"calls": sum(v[0] for v in b.values()), "usd": round(sum(v[1] for v in b.values()), 4),
                         "byKind": {k: {"calls": v[0], "usd": round(v[1], 4)} for k, v in b.items()}}
        return {"today": fmt(self.today), "sinceStart": fmt(self.since_start)}


_totals = _Totals()


def usage_summary() -> dict:
    return _totals.summary()
