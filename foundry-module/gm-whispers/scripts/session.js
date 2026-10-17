/**
 * Итоги сессии: лог чата Foundry + заметки мастера → черновик в «Дневник кампании».
 * Журнал создаётся только для мастера (права «Нет» для всех) и сразу добавляется в базу знаний советника.
 */

import { MODULE_ID, isNoise, request, stripHtml } from "./api.js";
import { markSynced } from "./kbsync.js";
import { getBible, updateBibleAfterSummary } from "./bible.js";
import { gatherContext } from "./context.js";
import { esc, renderMarkdown, sourcesHtml } from "./md.js";

export const DIARY_FOLDER = "GM Whispers · Дневник кампании";
const HOUR = 3600 * 1000;

const strip = (html, max = 400) => stripHtml(html, max);

function hhmm(ts) {
  return new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
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
    const text = [flavor, content, rolls.length ? `бросок ${rolls.join("; ")}` : ""].filter(Boolean).join(" — ");
    if (!text) continue;
    const whisper = (m.whisper ?? []).map(id => game.users.get(id)?.name).filter(Boolean).join(", ");
    out.push({ t: hhmm(ts), who, kind: m.type ?? "", text, whisper: whisper || undefined });
  }
  return out;
}

async function diaryFolder() {
  let folder = game.folders.find(f => f.type === "JournalEntry" && f.name === DIARY_FOLDER);
  if (!folder) folder = await Folder.create({ name: DIARY_FOLDER, type: "JournalEntry", color: "#5b4a2a" });
  return folder;
}

function diaryEntries() {
  const folder = game.folders.find(f => f.type === "JournalEntry" && f.name === DIARY_FOLDER);
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
  const date = new Date(to).toLocaleDateString("ru-RU");
  const name = `Сессия ${n} — ${date}${title ? ": " + title : ""}`;
  let html = renderMarkdown(body, { citations: res.citations ?? [], journal: true });
  html += sourcesHtml(res.citations ?? []);
  if (notes?.trim()) html += `<h3>Заметки мастера</h3><p>${esc(notes.trim()).replace(/\n/g, "<br>")}</p>`;
  html += `<p><em>Черновик GM Whispers · ${esc(period)} · проверь и поправь при необходимости.</em></p>`;
  return JournalEntry.create({
    name,
    folder: folder.id,
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
    flags: { [MODULE_ID]: { session: { n, from, to } } },
    pages: [{ name: "Итоги", type: "text", text: { content: html, format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } }],
  });
}

async function indexEntry(entry) {
  const page = entry.pages.contents[0];
  if (!page) return;
  markSynced([page.uuid]); // автообновление уже поставило страницу в очередь — не слать дважды
  await request("/kb/upsert", {
    method: "POST",
    body: { pages: [{ uuid: page.uuid, entry: entry.name, page: page.name, folder: DIARY_FOLDER, html: page.text?.content ?? "" }] },
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
  item.phase = "Забираю запись Craig";
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
      throw new Error("Сервер не начал обработку записи за 5 минут — проверь окно сервера и лог data/logs/craig-*.log.");
    }
    const running = mine.find(j => j.state === "running");
    if (running) {
      if (running.progress) {
        item.phase = files.size > 1 ? `Расшифровываю ${running.file}` : "Расшифровываю запись Craig";
        item.progress = running.progress;
        panel.updateItem(item);
      }
      continue;
    }
    if (mine.length < files.size) continue; // ещё не начали
    for (const j of mine) {
      if (j.state === "error") throw new Error(`Craig «${j.file}»: ${j.message}`);
      if (j.session) sid = j.session;
    }
    return sid;
  }
  throw new Error("Обработка записи Craig не закончилась за час — проверь окно сервера.");
}

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
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
    ui.notifications.warn(`GM Whispers: не удалось получить список сессий (${err.message}). Доступен только текущий чат.`);
  }
  // Новые записи Craig в облачной папке (один просмотр списка файлов на сервере).
  let craig = { enabled: false, pending: [] };
  try {
    craig = await request("/craig/pending", { timeout: 8000 });
  } catch (_) { /* старый сервер или папка не задана */ }
  const pendingCraig = craig.pending ?? [];
  const count = from => game.messages.contents.filter(m => (m.timestamp ?? 0) >= from && (m.timestamp ?? 0) <= now).length;
  const chatOpts = [
    { v: "chat:last", from: last, label: last ? `Чат с прошлых итогов (${fmtTime(last)})` : "Весь текущий чат" },
    { v: "chat:h8", from: now - 8 * HOUR, label: "Чат за последние 8 часов" },
    { v: "chat:all", from: 0, label: "Весь текущий чат" },
  ];
  const sessOpts = sessions.map(x => ({
    v: `s:${x.id}`,
    id: x.id,
    first: x.first,
    last: x.last,
    label: `${x.label} — событий ${x.events}${x.transcript ? `, голос: ${x.transcript} реплик` : ", голоса нет"}`,
  }));
  const content = `
    <div class="gmw-dialog">
      <label>Что подводим
        <select name="source">
          ${sessOpts.length ? `<optgroup label="Журнал сессий GM Whispers">${sessOpts.map(o => `<option value="${o.v}">${esc(o.label)}</option>`).join("")}</optgroup>` : ""}
          <optgroup label="Только текущий чат Foundry">
            ${chatOpts.map(o => `<option value="${o.v}">${esc(o.label)} — ${count(o.from)} сообщ.</option>`).join("")}
          </optgroup>
        </select>
      </label>
      ${pendingCraig.length ? `
      <label class="gmw-check"><input type="checkbox" name="craigSync" checked>
        Сначала забрать из Craig: ${pendingCraig.map(f => `${esc(f.file)} (${Math.round(f.size / 1048576)} МБ)`).join(", ")}
      </label>` : (craig.enabled ? `<p class="hint">Новых записей Craig в папке нет.</p>` : "")}
      <label>Расшифровка голоса (необязательно)
        <input type="file" name="transcriptFile" accept=".txt,.srt,.vtt,text/plain">
      </label>
      <p class="hint">Запись Craig проще расшифровать здесь, на видеокарте: перетащи zip на <code>server\\transcribe.bat</code> — расшифровка сама привяжется к сессии. Сюда — только если текст уже есть (txt / srt / vtt).</p>
      <label>Заметки мастера
        <textarea name="notes" rows="6" placeholder="Что важно и могло не попасть в запись: решения, договорённости, кто что получил, твои планы на последствия…"></textarea>
      </label>
    </div>`;

  let fileText = "";
  let fileName = "";
  let data;
  try {
    data = await foundry.applications.api.DialogV2.input({
      window: { title: "GM Whispers — итоги сессии", icon: "fas fa-scroll" },
      position: { width: 600 },
      content,
      ok: { label: "Составить итоги", icon: "fas fa-feather" },
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
  const period = sess ? `сессия ${sess.label.split(" — ")[0]}` : (chat?.label ?? "");
  // Чат прикладываем всегда для выбранного периода: сервер использует его, только если журнал событий пуст.
  const messages = collectMessages(from, sess ? to + HOUR : now);

  if (!sessionId && !messages.length && !notes.trim() && !fileText) {
    return ui.notifications.warn("GM Whispers: нет ни событий, ни расшифровки, ни заметок.");
  }

  const item = { question: `📜 Итоги: ${period}`, pending: true, started: Date.now() };
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
    item.phase = "Пишу итоги (обычно 1–3 мин)";
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
      ui.notifications.warn(`GM Whispers: итоги сохранены, но не добавлены в базу (${err.message}). Нажми «База».`);
    }
    try {
      item.phase = "Обновляю библию кампании";
      panel.updateItem(item);
      await updateBibleAfterSummary(res.markdown);
    } catch (err) {
      ui.notifications.warn(`GM Whispers: итоги сохранены, но библия не обновлена (${err.message}).`);
    }
    const st = res.stats ?? {};
    Object.assign(item, {
      pending: false,
      question: `📜 Итоги: ${period} · событий ${st.events ?? 0}, голос ${st.voice ?? 0}${notes.trim() ? ", заметки" : ""}`,
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
