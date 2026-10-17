/**
 * «Библия кампании» (D3): журнал из двух страниц — «Постоянное» (правит мастер) и «Текущее положение»
 * (обновляется после каждых «Итогов»). Текст обеих страниц уходит с каждым запросом к модели.
 */

import { MODULE_ID, htmlToText, request } from "./api.js";
import { gatherContext } from "./context.js";
import { esc, renderMarkdown } from "./md.js";
import { diarySummaries } from "./prep.js";

const FALLBACK = {
  "GMW.Bible.Name": "GM Whispers · Библия кампании", "GMW.Bible.Folder": "GM Whispers · Библия",
  "GMW.Bible.Permanent": "Постоянное", "GMW.Bible.Current": "Текущее положение",
  "GMW.Bible.Title": "Собрать Библию кампании", "GMW.Bible.Go": "Собрать", "GMW.Bible.Working": "Собираю Библию кампании (1–3 мин)",
  "GMW.Bible.FeedTitle": "📖 Библия кампании", "GMW.Bible.NoQuentas": "— без квент —",
  "GMW.Bible.PermanentNote": "Эту страницу правит мастер. Модуль её не меняет. Сюда — то, что всегда верно: партия, ключевые NPC, правила стола.",
  "GMW.Bible.CurrentNote": "Эту страницу модуль переписывает после каждых «Итогов». Что хочешь сохранить навсегда — перенеси в «Постоянное».",
};
function t(key, data) {
  let s = game.i18n?.localize?.(key);
  if (!s || s === key) s = FALLBACK[key] ?? key;
  return data ? s.replace(/\{(\w+)\}/g, (_m, k) => (k in data ? String(data[k]) : `{${k}}`)) : s;
}

export function bibleEntry() {
  return game.journal.find(j => j.getFlag(MODULE_ID, "bible")) ?? game.journal.find(j => j.name === t("GMW.Bible.Name")) ?? null;
}

function pageOf(entry, part) {
  return entry?.pages?.find(p => p.getFlag(MODULE_ID, "part") === part) ?? entry?.pages?.contents?.[part === "permanent" ? 0 : 1] ?? null;
}

/** Текст библии для запросов к модели; null, если библии нет. */
export function getBible() {
  const entry = bibleEntry();
  if (!entry) return null;
  const strip = (txt, key) => txt.replace(t(key), "").replace(FALLBACK[key] ?? "\u0000", "").trim();
  const permanent = strip(htmlToText(pageOf(entry, "permanent")?.text?.content), "GMW.Bible.PermanentNote");
  const current = strip(htmlToText(pageOf(entry, "current")?.text?.content), "GMW.Bible.CurrentNote");
  if (!permanent && !current) return null;
  return { permanent, current };
}

function mdToPage(md) {
  return renderMarkdown(md ?? "", { journal: true });
}

async function bibleFolder() {
  const name = t("GMW.Bible.Folder");
  let folder = game.folders.find(f => f.type === "JournalEntry" && f.name === name);
  if (!folder) {
    folder = await Folder.create({ name, type: "JournalEntry", color: "#4a2a5b" });
    try { // библия уходит в промпт целиком — в базу знаний её не индексируем
      const map = { ...(game.settings.get(MODULE_ID, "kbSources") || {}) };
      if (!map[folder.id]) { map[folder.id] = "exclude"; await game.settings.set(MODULE_ID, "kbSources", map); }
    } catch (_) { /* нет настройки */ }
  }
  return folder;
}

function quentaFolders() {
  return game.folders.filter(f => f.type === "JournalEntry").sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
}

function collectQuentas(folderId) {
  if (!folderId) return [];
  const out = [];
  const walk = (fid) => {
    for (const j of game.journal.filter(x => x.folder?.id === fid)) {
      const text = j.pages.contents.filter(p => p.type === "text").map(p => `${p.name}\n${htmlToText(p.text?.content)}`).join("\n\n");
      if (text.trim()) out.push({ name: j.name, text });
    }
    for (const f of game.folders.filter(x => x.type === "JournalEntry" && x.folder?.id === fid)) walk(f.id);
  };
  walk(folderId);
  return out;
}

/** Открыть библию или собрать первую версию. panel — панель советника (лента, статус). */
export async function openOrBuildBible(panel, { rebuild = false } = {}) {
  const existing = bibleEntry();
  if (existing && !rebuild) return existing.sheet?.render({ force: true });
  if (panel?.busy) return;
  const { DialogV2 } = foundry.applications.api;
  const saved = String(game.settings.get(MODULE_ID, "bibleQuentaFolder") || "");
  const folders = quentaFolders();
  const guess = folders.find(f => f.id === saved) ?? folders.find(f => /квент|backstor|предыстор/i.test(f.name));
  const content = `
    <p class="hint">${esc(t("GMW.Bible.Intro"))}</p>
    <div class="form-group"><label>${esc(t("GMW.Bible.Quentas"))}</label>
      <select name="folder"><option value="">${esc(t("GMW.Bible.NoQuentas"))}</option>${folders.map(f => `<option value="${esc(f.id)}" ${f.id === guess?.id ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select></div>
    <div class="form-group"><label>${esc(t("GMW.Bible.Summaries"))}</label>
      <select name="count">${[0, 2, 4].map(n => `<option value="${n}" ${n === 4 ? "selected" : ""}>${n}</option>`).join("")}</select></div>`;
  let data;
  try {
    data = await DialogV2.input({ window: { title: t("GMW.Bible.Title"), icon: "fas fa-book" }, content, ok: { label: t("GMW.Bible.Go"), icon: "fas fa-book" }, rejectClose: false });
  } catch (_) { return; }
  if (!data) return;
  const folderId = String(data.folder ?? "");
  await game.settings.set(MODULE_ID, "bibleQuentaFolder", folderId);
  const quentas = collectQuentas(folderId);
  const summaries = diarySummaries(Number(data.count) || 0);
  const party = gatherContext({ includeScene: false })?.party ?? [];
  const item = { question: t("GMW.Bible.FeedTitle"), pending: true, started: Date.now(), phase: t("GMW.Bible.Working"), indeterminate: true };
  panel.pushItem(item);
  panel.busy = true;
  panel.render();
  try {
    const res = await request("/bible/build", { method: "POST", body: { quentas, party, summaries, lang: game.i18n.lang }, timeout: 620000 });
    const folder = await bibleFolder();
    if (existing) { // пересборка: старую версию не удаляем, а убираем в сторону
      await existing.update({ name: `${existing.name} (до ${new Date().toLocaleDateString(game.i18n.lang)})`, [`flags.${MODULE_ID}.-=bible`]: null });
    }
    const note = (key) => `<p><em>${esc(t(key))}</em></p>`;
    const entry = await JournalEntry.create({
      name: t("GMW.Bible.Name"),
      folder: folder.id,
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
      flags: { [MODULE_ID]: { bible: { builtAt: Date.now(), quentas: quentas.length, summaries: summaries.length } } },
      pages: [
        { name: t("GMW.Bible.Permanent"), type: "text", flags: { [MODULE_ID]: { part: "permanent" } }, text: { content: note("GMW.Bible.PermanentNote") + mdToPage(res.permanent), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } },
        { name: t("GMW.Bible.Current"), type: "text", flags: { [MODULE_ID]: { part: "current" } }, text: { content: note("GMW.Bible.CurrentNote") + mdToPage(res.current), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } },
      ],
    });
    Object.assign(item, { pending: false, answer: `${res.permanent}\n\n---\n\n${res.current}`, citations: [], usage: res.usage, seconds: res.seconds, journalUuid: entry.uuid, journalName: entry.name });
    ui.notifications.info(`GM Whispers: ${t("GMW.Bible.Done")}`);
    entry.sheet?.render({ force: true });
  } catch (err) {
    Object.assign(item, { pending: false, error: err.message });
  } finally {
    panel.busy = false;
    panel.render();
  }
}

/** После «Итогов»: переписать «Текущее положение». Тихо выходит, если библии нет. */
export async function updateBibleAfterSummary(summaryMarkdown) {
  const entry = bibleEntry();
  if (!entry || !summaryMarkdown?.trim()) return null;
  const cur = pageOf(entry, "current");
  if (!cur) return null;
  const bible = getBible() ?? { permanent: "", current: "" };
  const res = await request("/bible/update", { method: "POST", body: { permanent: bible.permanent, current: bible.current, summary: summaryMarkdown, lang: game.i18n.lang }, timeout: 320000 });
  const note = `<p><em>${esc(t("GMW.Bible.CurrentNote"))}</em></p>`;
  await cur.update({ "text.content": note + mdToPage(res.current) });
  await entry.setFlag(MODULE_ID, "bible.updatedAt", Date.now());
  const hasSuggestions = /^##\s*(Предложения в постоянное|Suggestions)/im.test(res.current);
  ui.notifications.info(`GM Whispers: ${t("GMW.Bible.Updated")}${hasSuggestions ? ` — ${t("GMW.Bible.Suggestions")}` : ""}.`);
  return res;
}
