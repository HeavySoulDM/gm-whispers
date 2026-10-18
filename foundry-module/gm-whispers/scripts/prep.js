/**
 * «К игре»: сводка перед сессией по последним итогам, заметкам мастера и книге → журнал «GM Whispers · К игре».
 * Тексты интерфейса — через lang/*.json (GMW.Prep.*).
 */

import { MODULE_ID, request, stripHtml } from "./api.js";
import { gatherContext } from "./context.js";
import { esc, renderMarkdown, sourcesHtml } from "./md.js";
import { diaryFolderName } from "./session.js";
import { getBible } from "./bible.js";
import { T } from "./i18n.js";

export function diarySummaries(limit) {
  const name = diaryFolderName();
  const folder = game.folders.find(f => f.type === "JournalEntry" && f.name === name);
  if (!folder) return [];
  return game.journal.filter(j => j.folder?.id === folder.id)
    .sort((a, b) => (a.getFlag(MODULE_ID, "session")?.to ?? a._stats?.createdTime ?? 0) - (b.getFlag(MODULE_ID, "session")?.to ?? b._stats?.createdTime ?? 0))
    .slice(-limit)
    .map(j => {
      const page = j.pages?.contents?.[0];
      return page ? `${j.name}\n${stripHtml(page.text?.content, 8000)}` : "";
    })
    .filter(Boolean);
}

async function prepFolder() {
  const name = T("GMW.Prep.Folder");
  let folder = game.folders.find(f => f.type === "JournalEntry" && f.name === name);
  if (!folder) {
    folder = await Folder.create({ name, type: "JournalEntry", color: "#2a4a5b" });
    // Сводки — пересказ базы, в саму базу им не нужно: помечаем папку «не включать».
    try {
      const map = { ...(game.settings.get(MODULE_ID, "kbSources") || {}) };
      if (!map[folder.id]) { map[folder.id] = "exclude"; await game.settings.set(MODULE_ID, "kbSources", map); }
    } catch (_) { /* старый мир без настройки */ }
  }
  return folder;
}

async function createPrepEntry(res, { notes, count }) {
  const folder = await prepFolder();
  const md = res.markdown ?? "";
  const title = md.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const body = md.replace(/^#\s+.+$/m, "").trim();
  const date = new Date().toLocaleDateString(game.i18n.lang);
  const name = T("GMW.Prep.EntryName", { date }) + (title ? `: ${title.replace(/^К игре\s*—\s*|^Prep\s*—\s*/i, "")}` : "");
  let html = renderMarkdown(body, { citations: res.citations ?? [], journal: true });
  html += sourcesHtml(res.citations ?? []);
  if (notes?.trim()) html += `<h3>${esc(T("GMW.Prep.Notes"))}</h3><p>${esc(notes.trim()).replace(/\n/g, "<br>")}</p>`;
  html += `<p><em>${esc(T("GMW.Prep.Footer", { n: count }))}</em></p>`;
  return JournalEntry.create({
    name,
    folder: folder.id,
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
    flags: { [MODULE_ID]: { prep: { at: Date.now(), summaries: count } } },
    pages: [{ name: T("GMW.Prep.PageName"), type: "text", text: { content: html, format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } }],
  });
}

/** Диалог и весь процесс. panel — открытая панель советника (лента, статус). */
export async function openPrepDialog(panel) {
  if (panel?.busy) return;
  const available = diarySummaries(10).length;
  const { DialogV2 } = foundry.applications.api;
  const content = `
    <p class="hint">${esc(T("GMW.Prep.Intro"))}</p>
    ${available ? "" : `<p class="hint gmw-warn"><i class="fas fa-circle-info"></i> ${esc(T("GMW.Prep.NoSummaries"))}</p>`}
    <div class="form-group">
      <label>${esc(T("GMW.Prep.Notes"))}</label>
      <textarea name="notes" rows="5" placeholder="${esc(T("GMW.Prep.NotesHint"))}"></textarea>
    </div>
    <div class="form-group">
      <label>${esc(T("GMW.Prep.Summaries"))}</label>
      <select name="count">${[1, 2, 3, 5].map(n => `<option value="${n}" ${n === 2 ? "selected" : ""}>${n}</option>`).join("")}</select>
    </div>
    <label class="gmw-check"><input type="checkbox" name="useScene" checked> ${esc(T("GMW.Prep.UseScene"))}</label>`;
  let data;
  try {
    data = await DialogV2.input({
      window: { title: T("GMW.Prep.Title"), icon: "fas fa-compass" },
      content,
      ok: { label: T("GMW.Prep.Go"), icon: "fas fa-compass" },
      rejectClose: false,
    });
  } catch (_) {
    return;
  }
  if (!data) return;

  const notes = String(data.notes ?? "");
  const count = Math.max(1, Number(data.count) || 2);
  const summaries = diarySummaries(count);
  const ctx = gatherContext({ includeScene: !!data.useScene });
  const item = { question: T("GMW.Prep.FeedTitle"), pending: true, started: Date.now(), phase: T("GMW.Prep.Working"), indeterminate: true };
  panel.pushItem(item);
  panel.busy = true;
  panel.render();
  try {
    const res = await request("/session/prep", {
      method: "POST",
      body: { summaries, notes, party: ctx?.party ?? [], scene: data.useScene ? ctx?.scene ?? null : null, lang: game.i18n.lang, bible: getBible() },
      timeout: 620000,
    });
    const entry = await createPrepEntry(res, { notes, count: summaries.length });
    Object.assign(item, {
      pending: false,
      question: `${T("GMW.Prep.FeedTitle")} · ${entry.name}`,
      answer: res.markdown,
      citations: res.citations,
      usage: res.usage,
      seconds: res.seconds,
      journalUuid: entry.uuid,
      journalName: entry.name,
    });
    ui.notifications.info(`GM Whispers: ${T("GMW.Prep.Done")} — «${entry.name}».`);
    entry.sheet?.render({ force: true });
  } catch (err) {
    Object.assign(item, { pending: false, error: err.message });
  } finally {
    panel.busy = false;
    panel.render();
  }
}
