/**
 * Раздатки: советник оформляет текст для игроков (письмо, записка, объявление…) блоком
 * === РАЗДАТКА: название === … === КОНЕЦ РАЗДАТКИ === (или HANDOUT / END HANDOUT по-английски).
 * Панель показывает такой блок отдельной карточкой с кнопками «В журнал» и «Показать игрокам»;
 * журнал создаётся в папке «GM Whispers · Раздатки», скрытым от игроков, и сам попадает в базу знаний.
 */

import { MODULE_ID } from "./api.js";
import { T } from "./i18n.js";
import { esc, renderMarkdown } from "./md.js";

const OPEN_RX = /^[ \t]*={2,}\s*(?:РАЗДАТКА|HANDOUT)\s*(?:\[([^\]]*)\])?\s*:\s*(.+?)\s*={2,}[ \t]*$/im;

/** Тип раздатки по слову из маркера → класс оформления. */
const KINDS = {
  letter: ["письмо", "letter"], note: ["записка", "note"], notice: ["объявление", "notice", "poster"],
  diary: ["дневник", "diary", "journal"], prophecy: ["пророчество", "prophecy"], document: ["документ", "document", "contract", "контракт"],
};

function kindFromWords(text) {
  const t = (text ?? "").toLowerCase();
  for (const [kind, words] of Object.entries(KINDS)) if (words.some(w => t.includes(w))) return kind;
  return "";
}

function parseMeta(meta) {
  const out = { kind: "", lang: "" };
  for (const part of (meta ?? "").split(/[;,]/)) {
    const [k, v] = part.split(":").map(x => x?.trim().toLowerCase() ?? "");
    if (v && /^(язык|language|lang)$/.test(k)) { out.lang = v; continue; }
    out.kind = kindFromWords(v || k) || out.kind;
  }
  return out;
}

/** Язык по коду или названию из Polyglot («эльфийский», «elvish», «Эльфийском»); пусто — не найден. */
function resolveLang(text) {
  const langs = worldLanguages();
  if (!langs || !text) return "";
  const t = text.toLowerCase();
  for (const l of langs.list) {
    if (t === l.id.toLowerCase()) return l.id;
  }
  for (const l of langs.list) {
    const stem = l.label.toLowerCase().replace(/(ий|ский|ом|ого|ая|ое|ish|ic|an)$/, "");
    if (stem.length >= 3 && t.includes(stem)) return l.id;
  }
  return "";
}

/** Дополнить раздатку тем, чего модель не написала в маркере: тип — по словам названия/вопроса, язык — по вопросу. */
export function completeHandout(h, question = "") {
  const kind = h.kind || kindFromWords(h.title) || kindFromWords(question) || "document";
  let lang = h.lang ? resolveLang(h.lang) : "";
  if (!lang && !h.lang) {
    const m = (question + " " + h.title).match(/(?:на|in|по-|по)\s*([а-яёa-z-]+(?:ском|ском языке|ish|ic|an|йском|йски))/i);
    lang = resolveLang(m?.[1] ?? "") || resolveLang(question);
  }
  return { ...h, kind, lang };
}
const CLOSE_RX = /^[ \t]*={2,}\s*(?:КОНЕЦ РАЗДАТКИ|END HANDOUT)\s*={2,}[ \t]*$/im;

/** Разбить ответ на куски: {text} и {handout: {title, text}} по порядку. */
export function splitHandouts(answer) {
  const out = [];
  let rest = answer ?? "";
  for (;;) {
    const open = rest.match(OPEN_RX);
    if (!open) break;
    const before = rest.slice(0, open.index);
    const after = rest.slice(open.index + open[0].length);
    const close = after.match(CLOSE_RX);
    const body = close ? after.slice(0, close.index) : after;
    if (before.trim()) out.push({ text: before.trim() });
    out.push({ handout: { title: open[2].trim().replace(/[«»"]/g, ""), text: body.trim(), ...parseMeta(open[1]) } });
    rest = close ? after.slice(close.index + close[0].length) : "";
  }
  if (rest.trim()) out.push({ text: rest.trim() });
  return out;
}

export function handoutsOf(answer, question = "") {
  return splitHandouts(answer).filter(p => p.handout).map(p => completeHandout(p.handout, question));
}

export function handoutFolderName() { return T("GMW.Handout.Folder"); }

async function handoutFolder() {
  const name = handoutFolderName();
  let folder = game.folders.find(f => f.type === "JournalEntry" && f.name === name);
  if (!folder) folder = await Folder.create({ name, type: "JournalEntry", color: "#4a3d5b" });
  return folder;
}

/* ------------------------------------------------------------ тон бумаги (ползунки в ⚙ → Кампания) */

/** Выставить CSS-переменные оформления: тон 0–100 (светлая → тёмная), потёртость 0–100 (чистая → лежалая).
 *  Без аргументов — из настроек мира; вызывается при старте у всех клиентов и при движении ползунков. */
export function applyHandoutTheme({ tone, wear } = {}) {
  const t = Number(tone ?? game.settings.get(MODULE_ID, "handoutTone"));
  const w = Number(wear ?? game.settings.get(MODULE_ID, "handoutWear"));
  const light = 90 - (Number.isFinite(t) ? t : 50) * 0.34;      // 90% (светлая) … 56% (тёмная)
  const wearK = (Number.isFinite(w) ? w : 50) / 100;
  const root = document.documentElement.style;
  root.setProperty("--gmw-paper-l", `${light.toFixed(1)}%`);
  root.setProperty("--gmw-paper-wear", wearK.toFixed(2));
}

/* ------------------------------------------------------------ Polyglot: языки мира */

export function polyglotActive() {
  return !!game.modules?.get?.("polyglot")?.active && !!game.polyglot;
}

export function polyglotEnabled() {
  return polyglotActive() && !!game.settings.get(MODULE_ID, "handoutPolyglot");
}

/** Языки из Polyglot: [{id, label}] и язык по умолчанию. Пусто, если модуля нет или галочка снята. */
export function worldLanguages() {
  if (!polyglotEnabled()) return null;
  const prov = game.polyglot.provider ?? game.polyglot.languageProvider ?? game.polyglot;
  const raw = prov?.languages ?? {};
  const list = Object.entries(raw).map(([id, v]) => ({ id, label: typeof v === "string" ? v : (v?.label ?? id) })).filter(l => l.id);
  if (!list.length) return null;
  return { list, default: prov?.defaultLanguage ?? "" };
}

function polyglotWrap(html, lang) {
  // Polyglot подменяет текст внутри .polyglot-journal[data-language] на «руны» для тех, кто языка не знает.
  const open = `<span class="polyglot-journal" data-language="${esc(lang)}">`;
  return html.replace(/<(p|li|h[1-6])(\s[^>]*)?>([\s\S]*?)<\/\1>/g, (_m, tag, attrs, inner) => `<${tag}${attrs ?? ""}>${open}${inner}</span></${tag}>`);
}

/* ------------------------------------------------------------ оформление страницы */

/** HTML страницы журнала: своё оформление по типу (+ пергамент dnd5e), текст на языке мира через Polyglot. */
export function handoutPageHTML(h) {
  let body = renderMarkdown(h.text, { journal: true });
  const lang = h.lang && polyglotEnabled() && h.lang !== (worldLanguages()?.default ?? "") ? h.lang : "";
  if (lang) body = polyglotWrap(body, lang);
  if (!game.settings.get(MODULE_ID, "handoutStyle")) return body;
  // Название уже в заголовке страницы; внутри «бумаги» его повторяем только у объявления — там это часть оформления.
  const head = h.kind === "notice" && h.title ? `<h2 class="gmw-ho-title">${esc(h.title)}</h2>` : "";
  return `<div class="gmw-ho gmw-ho-${esc(h.kind ?? "document")}">${head}${body}</div>`;
}

/** Журнал из раздатки: скрыт от игроков, пока мастер не покажет. Возвращает JournalEntry. */
export async function createHandoutEntry(h, { question = "" } = {}) {
  const folder = await handoutFolder();
  const html = handoutPageHTML(h);
  return JournalEntry.create({
    name: h.title || T("GMW.Handout.DefaultName"),
    folder: folder.id,
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
    flags: { [MODULE_ID]: { handout: { question, kind: h.kind ?? "", lang: h.lang ?? "", created: Date.now() } } },
    pages: [{ name: h.title || T("GMW.Handout.DefaultName"), type: "text", text: { content: html, format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } }],
  });
}

/** Показать игрокам: дать всем право наблюдателя и открыть журнал у них на экране. */
export async function showHandout(entry) {
  await entry.update({ ownership: { ...entry.ownership, default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER } });
  if (globalThis.Journal?.show) await Journal.show(entry, { force: true });
  else if (typeof entry.show === "function") await entry.show(true);
}

/** HTML блока раздатки в ленте (кнопки — только когда известен индекс карточки). */
export function handoutHTML(h, { idx, hidx, uuid } = {}) {
  let actions = "";
  if (idx != null) {
    actions = uuid
      ? `<a data-action="openDoc" data-uuid="${esc(uuid)}"><i class="fas fa-book-open"></i> ${T("GMW.Handout.Open")}</a>
         <a data-action="handoutShow" data-index="${idx}" data-handout="${hidx}"><i class="fas fa-eye"></i> ${T("GMW.Handout.Show")}</a>`
      : `<a data-action="handoutJournal" data-index="${idx}" data-handout="${hidx}"><i class="fas fa-book-medical"></i> ${T("GMW.Handout.ToJournal")}</a>
         <a data-action="handoutShow" data-index="${idx}" data-handout="${hidx}"><i class="fas fa-eye"></i> ${T("GMW.Handout.Show")}</a>`;
  }
  // В ленте — нейтральная карточка (панель тёмная, «бумага» тут нечитаема); тип и язык — подписью.
  const langLabel = h.lang ? (worldLanguages()?.list.find(l => l.id === h.lang)?.label ?? h.lang) : "";
  const kindLabel = h.kind ? T(`GMW.Handout.Kind.${h.kind}`) : "";
  const meta = [kindLabel, langLabel].filter(Boolean).join(" · ");
  return `<div class="gmw-handout"><div class="gmw-handout-title"><i class="fas fa-scroll"></i> ${esc(h.title)}${meta ? ` <span class="gmw-muted">· ${esc(meta)}</span>` : ""}</div>
    <div class="gmw-handout-body">${renderMarkdown(h.text)}</div>${actions ? `<div class="gmw-handout-actions">${actions}</div>` : ""}</div>`;
}
