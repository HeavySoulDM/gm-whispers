"""Контрольный набор (D4): находит ли поиск нужные страницы на настоящие вопросы мастера.

    python -m gmw.evaluate            — только поиск (бесплатно, секунды): попала ли ожидаемая страница в топ-3 / топ-8
    python -m gmw.evaluate --llm      — полный ответ советника (платно, ~$0.005/вопрос): есть ли ожидаемая страница в ссылках
    python -m gmw.evaluate --tag npc  — только вопросы с меткой
    python -m gmw.evaluate --save     — записать результат в data/logs/eval-<дата>.json (для сравнения до/после)

Вопросы — server/config/eval.json. Запускать после любой смены модели, промпта или настроек поиска.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

from .config import DATA_DIR, SERVER_DIR, settings
from .kb import KnowledgeBase

EVAL_PATH = SERVER_DIR / "config" / "eval.json"


def load_questions(tag: str | None = None) -> list[dict]:
    data = json.loads(EVAL_PATH.read_text(encoding="utf-8"))
    qs = [q for q in data.get("questions", []) if q.get("q") and q.get("expect")]
    if tag:
        qs = [q for q in qs if tag in (q.get("tags") or [])]
    return qs


def _match(title: str, expects: list[str]) -> bool:
    t = title.casefold()
    return any(e.casefold() in t for e in expects)


def run_search(kb: KnowledgeBase, qs: list[dict], limit: int = 8) -> list[dict]:
    rows = []
    for q in qs:
        t0 = time.time()
        hits = kb.search(q["q"], limit=limit, per_page=1)
        ms = int((time.time() - t0) * 1000)
        rank = next((i + 1 for i, (c, _s) in enumerate(hits) if _match(c.title, q["expect"])), None)
        rows.append({"q": q["q"], "rank": rank, "ms": ms, "top": [c.title for c, _ in hits[:3]], "tags": q.get("tags", [])})
    return rows


async def run_llm(kb: KnowledgeBase, qs: list[dict]) -> list[dict]:
    from . import advisor

    rows = []
    for q in qs:
        try:
            res = await advisor.ask(kb, q["q"], None, None, "lore")
        except Exception as e:  # noqa: BLE001
            rows.append({"q": q["q"], "error": str(e)[:200]})
            continue
        cited = [c.get("title", "") for c in res.get("citations", [])]
        ok = any(_match(t, q["expect"]) for t in cited)
        rows.append({"q": q["q"], "cited": ok, "seconds": res.get("seconds"), "cost": res["usage"].get("cost_usd"),
                     "calls": res["usage"].get("calls"), "answer": res.get("answer", "")[:300], "citations": cited})
    return rows


def report_search(rows: list[dict]) -> dict:
    n = len(rows)
    top1 = sum(1 for r in rows if r["rank"] == 1)
    top3 = sum(1 for r in rows if r["rank"] and r["rank"] <= 3)
    top8 = sum(1 for r in rows if r["rank"])
    print(f"\nПоиск: вопросов {n} · в топ-1: {top1} · в топ-3: {top3} · в топ-8: {top8} · среднее {sum(r['ms'] for r in rows) // max(n, 1)} мс")
    for r in rows:
        mark = "✓" if r["rank"] and r["rank"] <= 3 else ("~" if r["rank"] else "✗")
        print(f" {mark} [{r['rank'] or '-'}] {r['q']}")
        if not r["rank"] or r["rank"] > 3:
            for t in r["top"]:
                print(f"       нашлось: {t}")
    return {"n": n, "top1": top1, "top3": top3, "top8": top8}


def report_llm(rows: list[dict]) -> dict:
    ok = sum(1 for r in rows if r.get("cited"))
    err = sum(1 for r in rows if r.get("error"))
    cost = sum(r.get("cost") or 0 for r in rows)
    secs = [r["seconds"] for r in rows if r.get("seconds")]
    print(f"\nСоветник: вопросов {len(rows)} · ссылка на нужную страницу: {ok} · ошибок: {err} · ~${cost:.3f} · среднее {sum(secs) / max(len(secs), 1):.1f} с")
    for r in rows:
        if r.get("error"):
            print(f" ! {r['q']} — {r['error']}")
        else:
            print(f" {'✓' if r['cited'] else '✗'} {r['q']}  ({r['seconds']} с, ~${r['cost']:.3f})")
            if not r["cited"]:
                print(f"       ссылки: {', '.join(r['citations'][:4]) or '—'}")
    return {"n": len(rows), "cited": ok, "errors": err, "cost": round(cost, 4)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Контрольный набор вопросов GM Whispers")
    ap.add_argument("--llm", action="store_true", help="полный ответ советника (платно)")
    ap.add_argument("--tag", help="только вопросы с этой меткой")
    ap.add_argument("--limit", type=int, default=8)
    ap.add_argument("--save", action="store_true", help="сохранить результат в data/logs")
    args = ap.parse_args(argv)

    kb = KnowledgeBase(settings.kb_dir)
    if not kb.chunks:
        print("База знаний пуста: запусти сервер и нажми «База» в панели.")
        return 1
    qs = load_questions(args.tag)
    if not qs:
        print(f"Нет вопросов в {EVAL_PATH}")
        return 1
    print(f"База: {len(kb.pages)} стр., {len(kb.chunks)} фрагм. · вопросов: {len(qs)}")
    out = {"ts": time.strftime("%Y-%m-%d %H:%M"), "kb": kb.meta, "search": run_search(kb, qs, args.limit)}
    summary = {"search": report_search(out["search"])}
    if args.llm:
        from .llm import model_for

        print(f"\nМодель: {model_for('lore')}")
        out["llm"] = asyncio.run(run_llm(kb, qs))
        summary["llm"] = report_llm(out["llm"])
    out["summary"] = summary
    if args.save:
        path = DATA_DIR / "logs" / f"eval-{time.strftime('%Y%m%d-%H%M')}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\nСохранено: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
