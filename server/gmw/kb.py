"""База знаний: страницы журналов Foundry → фрагменты → поиск BM25 с русским стеммером.

Векторный поиск (BGE-M3) добавим позже; для имён собственных и точных
формулировок BM25 и так работает лучше всего.
"""

from __future__ import annotations

import json
import math
import re
import sys
import threading
import time
from collections import Counter
from dataclasses import asdict, dataclass
from html.parser import HTMLParser
from pathlib import Path

import snowballstemmer

from .config import SOURCES_PATH

# ---------------------------------------------------------------- токенизация

_RU = snowballstemmer.stemmer("russian")
_EN = snowballstemmer.stemmer("english")
_WORD = re.compile(r"[0-9a-zа-яё]+", re.IGNORECASE)
_CYR = re.compile(r"[а-я]")
_STOP = set(
    "и в во на не что с со по как а к ко из у за о об же для это от до при но или ли бы был была были "
    "быть его ее её их им ими он она оно они мы вы ты я то так также там тут где когда если чтобы "
    "который которая которые которого этот эта эти этого того тот та те все всё всех весь вся уже "
    "еще ещё очень может могут можно нет да the a an of to in and or is are".split()
)


PREFIX = 5  # «отравлен» / «отравленный» дают разные основы — общий префикс их связывает


def tokenize(text: str) -> list[str]:
    out = []
    for w in _WORD.findall(text.lower().replace("ё", "е")):
        if w in _STOP or (len(w) < 2 and not w.isdigit()):
            continue
        stem = _RU.stemWord(w) if _CYR.search(w) else _EN.stemWord(w)
        out.append(sys.intern(stem))
        if len(stem) > PREFIX and not stem.isdigit():
            out.append(sys.intern("~" + stem[:PREFIX]))
    return out


# ---------------------------------------------------------------- HTML → блоки

_ENRICH_UUID = re.compile(r"@UUID\[[^\]]*\](?:\{([^}]*)\})?")
_ENRICH_OTHER = re.compile(r"@(\w+)\[([^\]]*)\](?:\{([^}]*)\})?")
_INLINE_ROLL = re.compile(r"\[\[/?\w*\s*([^\]]*)\]\]")
_SPACES = re.compile(r"[ \t ]+")


def clean_enrichers(text: str) -> str:
    text = _ENRICH_UUID.sub(lambda m: m.group(1) or "", text)
    text = _ENRICH_OTHER.sub(lambda m: m.group(3) or m.group(2).replace("|", " "), text)
    text = _INLINE_ROLL.sub(lambda m: m.group(1), text)
    return text


class _Blocks(HTMLParser):
    """Раскладывает HTML страницы на заголовки и абзацы."""

    BLOCK = {"p", "div", "li", "tr", "blockquote", "section", "article", "dd", "dt", "figcaption", "pre"}
    HEAD = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}
    SKIP = {"script", "style", "template"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[tuple[str, int, str]] = []
        self.buf: list[str] = []
        self.head_level = 0
        self.skip = 0

    def _flush(self) -> None:
        text = _SPACES.sub(" ", "".join(self.buf)).strip()
        self.buf = []
        if not text:
            return
        if self.head_level:
            self.blocks.append(("h", self.head_level, text))
        else:
            self.blocks.append(("p", 0, text))

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        elif tag in self.HEAD:
            self._flush()
            self.head_level = self.HEAD[tag]
        elif tag in self.BLOCK:
            self._flush()
            if tag == "li":
                self.buf.append("• ")
        elif tag == "br":
            self.buf.append("\n")
        elif tag in ("td", "th"):
            self.buf.append(" | ")

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag in self.HEAD:
            self._flush()
            self.head_level = 0
        elif tag in self.BLOCK:
            self._flush()

    def handle_data(self, data):
        if not self.skip:
            self.buf.append(data)

    def close(self):
        super().close()
        self._flush()


def html_to_blocks(html: str) -> list[tuple[str, int, str]]:
    p = _Blocks()
    p.feed(clean_enrichers(html or ""))
    p.close()
    return p.blocks


def blocks_to_text(blocks) -> str:
    lines = []
    for kind, level, text in blocks:
        lines.append(("#" * level + " " + text) if kind == "h" else text)
    return "\n".join(lines)


# ---------------------------------------------------------------- модель данных


@dataclass
class Page:
    uuid: str
    entry: str
    page: str
    folder: str
    source: str
    label: str
    weight: float
    text: str


@dataclass
class Chunk:
    id: int
    page_uuid: str
    title: str  # «Журнал › Страница › Заголовок»
    source: str
    label: str
    weight: float
    text: str


_RULES_CACHE: tuple[float, list, dict] | None = None


def _load_rules():
    """Правила из sources.json; перечитываются только когда файл изменился. Невалидный regex пропускается."""
    global _RULES_CACHE
    try:
        mtime = Path(SOURCES_PATH).stat().st_mtime
    except OSError:
        mtime = 0.0
    if _RULES_CACHE and _RULES_CACHE[0] == mtime:
        return _RULES_CACHE[1], _RULES_CACHE[2]
    default = {"source": "other", "label": "Прочие журналы", "weight": 1.0}
    try:
        cfg = json.loads(Path(SOURCES_PATH).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cfg = {"rules": []}
    rules = []
    for r in cfg.get("rules", []):
        try:
            rules.append((re.compile(r["match"]), r))
        except (re.error, KeyError, TypeError) as e:
            print(f"[kb] правило в sources.json пропущено ({e}): {r}")
    default = cfg.get("default", default)
    _RULES_CACHE = (mtime, rules, default)
    return rules, default


# Виды источников. Мастер назначает их папкам журналов в настройках модуля; если вид не задан («авто»),
# работают правила sources.json по названию «Папка / Журнал». Вес — множитель релевантности при поиске.
KINDS = {
    "diary": {"label": "Дневник кампании", "weight": 1.35},
    "gm": {"label": "Материалы ГМа", "weight": 1.3},
    "adventure": {"label": "Книга приключения", "weight": 1.15},
    "setting": {"label": "Справочник мира", "weight": 1.0},
    "rules": {"label": "Правила", "weight": 0.9},
    "other": {"label": "Прочие журналы", "weight": 1.0},
}


def classify(folder: str, entry: str, kind: str | None = None):
    if kind == "exclude":
        return None
    if kind in KINDS:
        return kind, KINDS[kind]["label"], KINDS[kind]["weight"]
    rules, default = _load_rules()
    key = f"{folder} / {entry}" if folder else entry
    for rx, rule in rules:
        if rx.search(key):
            if rule.get("exclude"):
                return None
            return rule["source"], rule["label"], float(rule.get("weight", 1.0))
    return default["source"], default["label"], float(default.get("weight", 1.0))


TARGET = 1400  # символов во фрагменте
MIN_FLUSH = 350
_NORM = re.compile(r"[^0-9a-zа-яё]+", re.IGNORECASE)


def _norm(s: str) -> str:
    return _NORM.sub("", s.lower())


def chunk_page(page: Page, blocks, start_id: int) -> list[Chunk]:
    chunks: list[Chunk] = []
    heads: list[tuple[int, str]] = []
    cur: list[str] = []
    cur_heads = ""
    size = 0
    same = {_norm(page.entry), _norm(page.page)}

    def head_path() -> str:
        return " › ".join(h[1] for h in heads if _norm(h[1]) not in same)

    def flush(carry: bool = False):
        nonlocal cur, size, cur_heads
        if not cur:
            return
        parts, seen_n = [], set()
        for x in (page.entry, page.page, cur_heads):
            if x and _norm(x) not in seen_n:
                seen_n.add(_norm(x))
                parts.append(x)
        title = " › ".join(parts)
        chunks.append(Chunk(start_id + len(chunks), page.uuid, title, page.source, page.label, page.weight, "\n".join(cur)))
        last = cur[-1] if carry and len(cur[-1]) < 400 else None
        cur = [last] if last else []
        size = len(last) if last else 0

    for kind, level, text in blocks:
        if kind == "h":
            if size >= MIN_FLUSH:
                flush()
            heads = [h for h in heads if h[0] < level] + [(level, text)]
            if not cur:
                cur_heads = head_path()
            cur.append("#" * min(level + 1, 4) + " " + text)
            size += len(text)
            continue
        if size + len(text) > TARGET and size >= MIN_FLUSH:
            flush(carry=True)
            cur_heads = head_path()
        # Очень длинный абзац режем по предложениям.
        while len(text) > TARGET * 1.5:
            cut = text.rfind(". ", 0, TARGET)
            cut = cut + 1 if cut > TARGET // 3 else TARGET
            cur.append(text[:cut].strip())
            size += cut
            flush()
            text = text[cut:].strip()
        if not cur:
            cur_heads = head_path()
        cur.append(text)
        size += len(text)
    flush()
    return chunks


# ---------------------------------------------------------------- индекс


@dataclass
class _Index:
    """Снимок индекса. Поиск берёт ссылку на снимок один раз, поэтому обновление
    (которое идёт в другом потоке) никогда не меняет списки под ногами у поиска."""

    chunks: list[Chunk]
    tf: list[Counter]
    lens: list[int]
    df: Counter
    avg: float


def _make_page(rp: dict) -> tuple[Page, list] | None:
    cls = classify(rp.get("folder", ""), rp.get("entry", ""), rp.get("kind"))
    if cls is None:
        return None
    blocks = html_to_blocks(rp.get("html", ""))
    if not blocks:
        return None
    source, label, weight = cls
    page = Page(rp["uuid"], rp.get("entry", ""), rp.get("page", ""), rp.get("folder", ""), source, label, weight, blocks_to_text(blocks))
    return page, blocks


def _tokens(c: Chunk) -> list[str]:
    return tokenize(c.title) * 3 + tokenize(c.text)


class KnowledgeBase:
    K1 = 1.4
    B = 0.75
    SAVE_DELAY = 20.0  # с: правки журналов идут пачками — пишем файл один раз после затишья

    def __init__(self, kb_dir: Path):
        self.dir = Path(kb_dir)
        self.path = self.dir / "kb.json"
        self.pages: dict[str, Page] = {}
        self.meta: dict = {}
        self._idx = _Index([], [], [], Counter(), 1.0)
        self._lock = threading.Lock()       # одно изменение индекса за раз (rebuild/upsert из разных потоков)
        self._save_timer: threading.Timer | None = None
        self.load()

    @property
    def chunks(self) -> list[Chunk]:
        return self._idx.chunks

    # -- сборка

    def rebuild(self, raw_pages: list[dict], world: str = "") -> dict:
        with self._lock:
            pages: dict[str, Page] = {}
            chunks: list[Chunk] = []
            skipped = 0
            for rp in raw_pages:
                made = _make_page(rp)
                if made is None:
                    skipped += classify(rp.get("folder", ""), rp.get("entry", ""), rp.get("kind")) is None
                    continue
                page, blocks = made
                pages[page.uuid] = page
                chunks.extend(chunk_page(page, blocks, len(chunks)))
            self.pages = pages
            self._idx = self._build_index(chunks)
            self.meta = {
                "world": world,
                "updated": time.strftime("%Y-%m-%d %H:%M"),
                "pages": len(pages),
                "chunks": len(chunks),
                "skipped_pages": skipped,
                "chars": sum(len(p.text) for p in pages.values()),
            }
            self.save()
            return self.stats()

    def upsert(self, raw_pages: list[dict]) -> dict:
        """Добавить, заменить или удалить (html пустой) отдельные страницы.

        Инкрементально: пересчитываются только фрагменты затронутых страниц, а не вся база.
        Файл сохраняется отложенно (SAVE_DELAY) — серия правок даёт одну запись.
        """
        with self._lock:
            uuids = {rp["uuid"] for rp in raw_pages}
            old = self._idx
            keep = [i for i, c in enumerate(old.chunks) if c.page_uuid not in uuids]
            chunks = [old.chunks[i] for i in keep]
            tf = [old.tf[i] for i in keep]
            lens = [old.lens[i] for i in keep]
            df = Counter(old.df)
            for i, c in enumerate(old.chunks):
                if c.page_uuid in uuids:
                    df.subtract(old.tf[i].keys())
            pages = {u: p for u, p in self.pages.items() if u not in uuids}
            for rp in raw_pages:
                made = _make_page(rp)
                if made is None:
                    continue
                page, blocks = made
                pages[page.uuid] = page
                for c in chunk_page(page, blocks, len(chunks)):
                    toks = _tokens(c)
                    cnt = Counter(toks)
                    chunks.append(c)
                    tf.append(cnt)
                    lens.append(len(toks))
                    df.update(cnt.keys())
            for i, c in enumerate(chunks):
                c.id = i
            df = +df  # убрать нули и отрицательные остатки
            avg = (sum(lens) / len(lens)) if lens else 1.0
            self.pages = pages
            self._idx = _Index(chunks, tf, lens, df, avg)
            self.meta.update({
                "updated": time.strftime("%Y-%m-%d %H:%M"),
                "pages": len(pages),
                "chunks": len(chunks),
                "chars": sum(len(p.text) for p in pages.values()),
            })
            self._schedule_save()
            return self.stats()

    def _build_index(self, chunks: list[Chunk]) -> _Index:
        tf, lens, df = [], [], Counter()
        for c in chunks:
            toks = _tokens(c)
            cnt = Counter(toks)
            tf.append(cnt)
            lens.append(len(toks))
            df.update(cnt.keys())
        avg = (sum(lens) / len(lens)) if lens else 1.0
        return _Index(chunks, tf, lens, df, avg)

    # -- файл

    def _schedule_save(self) -> None:
        if self._save_timer:
            self._save_timer.cancel()
        self._save_timer = threading.Timer(self.SAVE_DELAY, self.flush)
        self._save_timer.daemon = True
        self._save_timer.start()

    def flush(self) -> None:
        """Записать отложенные изменения сейчас (вызывается таймером и при остановке сервера)."""
        with self._lock:
            if self._save_timer:
                self._save_timer.cancel()
                self._save_timer = None
            try:
                self.save()
            except OSError as e:
                print(f"[kb] не удалось сохранить kb.json: {e}")

    def save(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        data = {"meta": self.meta, "pages": [asdict(p) for p in self.pages.values()], "chunks": [asdict(c) for c in self.chunks]}
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.path)

    def load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            meta = data.get("meta", {})
            pages = {p["uuid"]: Page(**p) for p in data.get("pages", [])}
            chunks = [Chunk(**c) for c in data.get("chunks", [])]
        except (OSError, ValueError, TypeError, KeyError) as e:
            broken = self.path.with_suffix(".json.broken")
            try:
                self.path.replace(broken)
            except OSError:
                pass
            print(f"[kb] файл базы повреждён или устарел ({e}). Переименован в {broken.name}; нажми «База» в панели, чтобы собрать заново.")
            return
        self.meta, self.pages = meta, pages
        self._idx = self._build_index(chunks)

    def stats(self) -> dict:
        by_source = Counter(c.label for c in self.chunks)
        return {**self.meta, "by_source": dict(by_source)}

    # -- поиск

    def search(self, query: str, limit: int = 8, boost_pages: set[str] | None = None, per_page: int = 2) -> list[tuple[Chunk, float]]:
        q = tokenize(query)
        idx = self._idx  # снимок: обновление в другом потоке подменит self._idx целиком
        if not q or not idx.chunks:
            return []
        n = len(idx.chunks)
        # Префиксы основ (~отрав) помогают с формами слова, но весят вдвое меньше точной основы.
        idf = {
            t: math.log(1 + (n - idx.df[t] + 0.5) / (idx.df[t] + 0.5)) * (0.5 if t.startswith("~") else 1.0)
            for t in set(q) if idx.df[t]
        }
        if not idf:
            return []
        boost_pages = boost_pages or set()
        scored = []
        K1, B, avg = self.K1, self.B, idx.avg
        for i, tf in enumerate(idx.tf):
            s = 0.0
            dl = idx.lens[i]
            for t, w in idf.items():
                f = tf.get(t)
                if f:
                    s += w * f * (K1 + 1) / (f + K1 * (1 - B + B * dl / avg))
            if s:
                c = idx.chunks[i]
                s *= c.weight
                if c.page_uuid in boost_pages:
                    s *= 1.5
                scored.append((s, i))
        scored.sort(reverse=True)
        out, seen = [], Counter()
        for s, i in scored:
            c = idx.chunks[i]
            if seen[c.page_uuid] >= per_page:
                continue
            seen[c.page_uuid] += 1
            out.append((c, s))
            if len(out) >= limit:
                break
        return out

    def page_text(self, uuid: str, max_chars: int = 12000) -> Page | None:
        p = self.pages.get(uuid)
        if p is None:
            return None
        if len(p.text) > max_chars:
            p = Page(**{**asdict(p), "text": p.text[:max_chars] + "\n…[страница обрезана]"})
        return p
