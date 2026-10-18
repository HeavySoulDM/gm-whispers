/**
 * Итоги сессии: лог чата Foundry + заметки мастера → черновик в «Дневник кампании».
 * Журнал создаётся только для мастера (права «Нет» для всех) и сразу добавляется в базу знаний советника.
 */

import { MODULE_ID, isNoise, request, stripHtml } from "./api.js";
import { markSynced } from "./kbsync.js";
import { getBible, updateBibleAfterSummary } from "./bible.js";
import { gatherContext } from "./context.js";
import { esc, renderMarkdown, sourcesHtml } from "./md.js";
import { T } from "./i18n.js";

/** Папка дневника кампании (имя — по языку интерфейса, lang/*.json). */
export function diaryFolderName() { return T("GMW.Summary.DiaryFolder"); }
const HOUR = 3600 * 1000;

const strip = (html, max = 400) => stripHtml(html, max);

function hhmm(ts) {
  return new Date(ts).toLocaleTimeString(game.i18n.lang, { hour: "2-digit", minute: "2-digit" });
}

/** Сообщения чата за период в компактном виде. */
export function collectMessages(fromTs, toTs = Date.now()) {
  const out = [];
  for (const m of game.messages.contents) {
    const ts = m.timestamp ?? 0;
    if (ts < fromTs || ts > toTs) continue;
    const who = m.speaker?.alias || m.alias || m.author?.name || "?";
    if (who === "GM Whispers" || isNoise(m)) continue;
    const flavor = strip(m.flavor, 160);
    let content = strip(m.content, 400);
    const rolls = (m.rolls ?? []).map(r => {
      const total = Number.isInteger(r.total) ? r.total : Math.floor(r.total ?? 0);
      return `${r.formula} = ${total}`;
    });
    if (rolls.length && /^[\d.,\s]+$/.test(content)) content = ""; // карточка броска с одним числом
    const text = [flavor, content, rolls.length ? T("GMW.Log.Roll", { rolls: rolls.join("; ") }) : ""].filter(Boolean).join(" — ");
    if (!text) continue;
    const whisper = (m.whisper ?? []).map(id => game.users.get(id)?.name).filter(Boolean).join(", ");
    out.push({ t: hhmm(ts), who, kind: m.type ?? "", text, whisper: whisper || undefined });
  }
  return out;
}

async function diaryFolder() {
  const name = diaryFolderName();
  let folder = game.folders.find(f => f.type === "JournalEntry" && f.name === name);
  if (!folder) folder = await Folder.create({ name, type: "JournalEntry", color: "#5b4a2a" });
  return folder;
}

function diaryEntries() {
  const name = diaryFolderName();
  const folder = game.folders.find(f => f.type === "JournalEntry" && f.name === name);
  if (!folder) return [];
  return game.journal.filter(j => j.folder?.id === folder.id)
    .sort((a, b) => (a.getFlag(MODULE_ID, "session")?.to ?? 0) - (b.getFlag(MODULE_ID, "session")?.to ?? 0));
}

function previousSummaryText() {
  const last = diaryEntries().at(-1);
  const page = last?.pages?.contents?.[0];
  return page ? strip(page.text?.content, 4000) : "";
}

async function createDiaryEntry(res, { from, to, notes, period }) {
  const folder = await diaryFolder();
  const n = diaryEntries().length + 1;
  const md = res.markdown ?? "";
  const title = md.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const body = md.replace(/^#\s+.+$/m, "").trim(); // заголовок уходит в название журнала
  const date = new Date(to).toLocaleDateString(game.i18n.lang);
  const name = T("GMW.Summary.EntryName", { n, date }) + (title ? ": " + title : "");
  let html = renderMarkdown(body, { citations: res.citations ?? [], journal: true });
  html += sourcesHtml(res.citations ?? []);
  if (notes?.trim()) html += `<h3>${esc(T("GMW.Summary.GmNotes"))}</h3><p>${esc(notes.trim()).replace(/\n/g, "<br>")}</p>`;
  html += `<p><em>${esc(T("GMW.Summary.Draft", { period }))}</em></p>`;
  return JournalEntry.create({
    name,
    folder: folder.id,
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
    flags: { [MODULE_ID]: { session: { n, from, to } } },
    pages: [{ name: T("GMW.Summary.PageName"), type: "text", text: { content: html, format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } }],
  });
}

async function indexEntry(entry) {
  const page = entry.pages.contents[0];
  if (!page) return;
  markSynced([page.uuid]); // автообновление уже поставило страницу в очередь — не слать дважды
  await request("/kb/upsert", {
    method: "POST",
    body: { pages: [{ uuid: page.uuid, entry: entry.name, page: page.name, folder: diaryFolderName(), html: page.text?.content ?? "" }] },
    timeout: 60000,
  });
}

/** Забрать новые записи Craig и дождаться обработки. Возвращает id сессии последней записи. */
async function syncCraig(item, panel) {
  const res = await request("/craig/sync", { method: "POST", timeout: 15000 });
  if (!res.started) {
    ui.notifications.info(`GM Whispers: ${res.message}`);
    return null;
  }
  const files = new Set(res.files ?? []);
  item.phase = T("GMW.Summary.CraigFetch");
  item.progress = { phase: "start", pct: 0, at: Date.now() };
  panel.updateItem(item);
  const deadline = Date.now() + 60 * 60 * 1000;
  let sid = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    let jobs = [];
    try { jobs = (await request("/craig/jobs", { timeout: 8000 })).jobs ?? []; } catch (_) { continue; }
    const mine = jobs.filter(j => files.has(j.file) && j.started >= item.started - 60000);
    if (!mine.length && Date.now() - item.started > 5 * 60 * 1000) {
      throw new Error(T("GMW.Summary.CraigNotStarted"));
    }
    const running = mine.find(j => j.state === "running");
    if (running) {
      if (running.progress) {
        item.phase = files.size > 1 ? T("GMW.Summary.CraigTranscribingFile", { file: running.file }) : T("GMW.Summary.CraigTranscribing");
        item.progress = running.progress;
        panel.updateItem(item);
      }
      continue;
    }
    if (mine.length < files.size) continue; // ещё не начали
    for (const j of mine) {
      if (j.state === "error") throw new Error(T("GMW.Summary.CraigFileError", { file: j.file, message: j.message }));
      if (j.session) sid = j.session;
    }
    return sid;
  }
  throw new Error(T("GMW.Summary.CraigTimeout"));
}

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleString(game.i18n.lang, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
}

/** Диалог «Итоги сессии» и весь процесс. panel — открытая панель советника (для ленты и статуса). */
export async function openSummaryDialog(panel) {
  if (panel?.busy) return;
  const now = Date.now();
  const last = game.settings.get(MODULE_ID, "lastSummaryAt") || 0;

  // Сессии из журнала сервера (события Foundry + расшифровка голоса).
  let sessions = [];
  try {
    sessions = (await request("/session/list", { timeout: 8000 })).sessions ?? [];
  } catch (err) {
    ui.notifications.warn(T("GMW.Summary.SessionsFailed", { reason: err.message }));
  }
  // Новые записи Craig в облачной папке (один просмотр списка файлов на сервере).
  let craig = { enabled: false, pending: [] };
  try {
    craig = await request("/craig/pending", { timeout: 8000 });
  } catch (_) { /* старый сервер или папка не задана */ }
  const pendingCraig = craig.pending ?? [];
  const count = from => game.messages.contents.filter(m => (m.timestamp ?? 0) >= from && (m.timestamp ?? 0) <= now).length;
  const chatOpts = [
    { v: "chat:last", from: last, label: last ? T("GMW.Summary.ChatSinceLast", { time: fmtTime(last) }) : T("GMW.Summary.ChatAll") },
    { v: "chat:h8", from: now - 8 * HOUR, label: T("GMW.Summary.Chat8h") },
    { v: "chat:all", from: 0, label: T("GMW.Summary.ChatAll") },
  ];
  const sessOpts = sessions.map(x => ({
    v: `s:${x.id}`,
    id: x.id,
    first: x.first,
    last: x.last,
    label: `${T("GMW.Summary.SessionEvents", { label: x.label, n: x.events })}, ${x.transcript ? T("GMW.Summary.SessionVoice", { n: x.transcript }) : T("GMW.Summary.SessionNoVoice")}`,
  }));
  const content = `
    <div class="gmw-dialog">
      <label>${esc(T("GMW.Summary.Source"))}
        <select name="source">
          ${sessOpts.length ? `<optgroup label="${esc(T("GMW.Summary.GroupSessions"))}">${sessOpts.map(o => `<option value="${o.v}">${esc(o.label)}</option>`).join("")}</optgroup>` : ""}
          <optgroup label="${esc(T("GMW.Summary.GroupChat"))}">
            ${chatOpts.map(o => `<option value="${o.v}">${esc(o.label)} — ${esc(T("GMW.Summary.Messages", { n: count(o.from) }))}</option>`).join("")}
          </optgroup>
        </select>
      </label>
      ${pendingCraig.length ? `
      <label class="gmw-check"><input type="checkbox" name="craigSync" checked>
        ${esc(T("GMW.Summary.CraigSyncFirst"))} ${pendingCraig.map(f => esc(T("GMW.Summary.FileSize", { file: f.file, mb: Math.round(f.size / 1048576) }))).join(", ")}
      </label>` : (craig.enabled ? `<p class="hint">${esc(T("GMW.Summary.NoNewCraig"))}</p>` : "")}
      <label>${esc(T("GMW.Summary.TranscriptFile"))}
        <input type="file" name="transcriptFile" accept=".txt,.srt,.vtt,text/plain">
      </label>
      <p class="hint">${esc(T("GMW.Summary.TranscriptHint"))}</p>
      <label>${esc(T("GMW.Summary.GmNotes"))}
        <textarea name="notes" rows="6" placeholder="${esc(T("GMW.Summary.NotesPlaceholder"))}"></textarea>
      </label>
    </div>`;

  let fileText = "";
  let fileName = "";
  let data;
  try {
    data = await foundry.applications.api.DialogV2.input({
      window: { title: T("GMW.Summary.Title"), icon: "fas fa-scroll" },
      position: { width: 600 },
      content,
      ok: { label: T("GMW.Summary.Go"), icon: "fas fa-feather" },
      render: (_event, dialog) => {
        const input = (dialog.element ?? dialog).querySelector?.("input[name=transcriptFile]");
        input?.addEventListener("change", async () => {
          const f = input.files?.[0];
          if (!f) return;
          fileName = f.name;
          fileText = await f.text();
        });
      },
    });
  } catch (_) {
    return;
  }
  if (!data) return;

  const notes = String(data.notes ?? "");
  const sel = String(data.source ?? "");
  const sess = sessOpts.find(o => o.v === sel);
  const chat = chatOpts.find(o => o.v === sel);
  let sessionId = sess?.id ?? null;
  const from = sess?.first ?? chat?.from ?? 0;
  const to = sess?.last ?? now;
  const period = sess ? T("GMW.Summary.PeriodSession", { label: sess.label.split(" — ")[0] }) : (chat?.label ?? "");
  // Чат прикладываем всегда для выбранного периода: сервер использует его, только если журнал событий пуст.
  const messages = collectMessages(from, sess ? to + HOUR : now);

  if (!sessionId && !messages.length && !notes.trim() && !fileText) {
    return ui.notifications.warn(T("GMW.Summary.NothingToSummarize"));
  }

  const item = { question: T("GMW.Summary.FeedTitle", { period }), pending: true, started: Date.now() };
  panel.pushItem(item);
  panel.busy = true;
  panel.render();
  try {
    if (data.craigSync && pendingCraig.length) {
      const sid = await syncCraig(item, panel);
      if (sid) sessionId = sid;
    }
    if (fileText) {
      const up = await request(`/session/${sessionId ?? "new"}/transcript`, {
        method: "POST", body: { filename: fileName, text: fileText }, timeout: 60000,
      });
      sessionId = up.session ?? sessionId;
    }
    item.phase = T("GMW.Summary.Writing");
    item.progress = null;
    item.indeterminate = true;
    panel.updateItem(item);
    const party = gatherContext({ includeScene: true })?.party ?? [];
    const res = await request("/session/summarize", {
      method: "POST",
      body: { session: sessionId, messages, notes, period, party, previous: previousSummaryText(), lang: game.i18n.lang, bible: getBible() },
      timeout: 900000,
    });
    const entry = await createDiaryEntry(res, { from, to, notes, period });
    await game.settings.set(MODULE_ID, "lastSummaryAt", now);
    try {
      await indexEntry(entry);
    } catch (err) {
      ui.notifications.warn(T("GMW.Summary.NotIndexed", { reason: err.message }));
    }
    try {
      item.phase = T("GMW.Summary.UpdatingBible");
      panel.updateItem(item);
      await updateBibleAfterSummary(res.markdown);
    } catch (err) {
      ui.notifications.warn(T("GMW.Summary.BibleNotUpdated", { reason: err.message }));
    }
    const st = res.stats ?? {};
    Object.assign(item, {
      pending: false,
      question: `${T("GMW.Summary.FeedTitle", { period })} · ${T("GMW.Summary.FeedStats", { events: st.events ?? 0, voice: st.voice ?? 0 })}${notes.trim() ? `, ${T("GMW.Summary.FeedNotes")}` : ""}`,
      answer: res.markdown,
      citations: res.citations,
      usage: res.usage,
      seconds: res.seconds,
      tools: res.tools,
      journalUuid: entry.uuid,
      journalName: entry.name,
    });
    entry.sheet?.render({ force: true });
  } catch (err) {
    Object.assign(item, { pending: false, error: err.message });
  } finally {
    panel.busy = false;
    if (panel.rendered) panel.render();
  }
}
