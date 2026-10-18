/**
 * База знаний: выгрузка журналов мира и компендиумов правил, автообновление при правке журналов.
 */

import { MODULE_ID, request } from "./api.js";
import { collectJournalPages } from "./context.js";

export const COMPENDIUM_PREFIX = "Компендиум · ";

/** Виды источников (значения для настройки kbSources). Подписи — в окне настроек. */
export const KINDS = ["auto", "gm", "diary", "adventure", "setting", "rules", "other", "exclude"];

/** Вид источника журнала по настройке папок (ближайшая папка-предок с заданным видом; "" — журналы без папки).
 * null — «авто»: сервер классифицирует по правилам sources.json. */
export function kindFor(entry) {
  let map;
  try { map = game.settings.get(MODULE_ID, "kbSources") || {}; } catch (_) { map = {}; }
  for (let f = entry?.folder; f; f = f.folder) {
    const k = map[f.id];
    if (k && k !== "auto") return k;
  }
  if (!entry?.folder) {
    const k = map[""];
    if (k && k !== "auto") return k;
  }
  return null;
}

/** Список компендиумов из настройки (id через запятую), только существующие и с журналами. */
export function configuredPacks() {
  const raw = String(game.settings.get(MODULE_ID, "kbPacks") || "");
  return raw.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)
    .map(id => game.packs.get(id))
    .filter(p => p && p.documentName === "JournalEntry");
}

function pageHtml(page) {
  return page.text?.content || page.system?.description?.value || "";
}

/** Страницы журналов из компендиумов (правила D&D и т. п.). Babele переводит их при загрузке. */
export async function collectCompendiumPages(onProgress) {
  const out = [];
  const packs = configuredPacks();
  for (const [i, pack] of packs.entries()) {
    onProgress?.(`${pack.metadata.label} (${i + 1}/${packs.length})`);
    let docs = [];
    try {
      docs = await pack.getDocuments();
    } catch (err) {
      console.warn(`${MODULE_ID} | не удалось прочитать ${pack.collection}`, err);
      continue;
    }
    for (const entry of docs) {
      for (const page of entry.pages) {
        const html = pageHtml(page);
        if (!html.trim()) continue;
        out.push({ uuid: page.uuid, entry: entry.name, page: page.name, folder: COMPENDIUM_PREFIX + pack.metadata.label, html, kind: "rules" });
      }
    }
  }
  return out;
}

export async function collectAllPages(onProgress) {
  const world = collectJournalPages().filter(p => p.kind !== "exclude");
  const packs = await collectCompendiumPages(onProgress);
  return [...world, ...packs];
}

/* ------------------------------------------------------------------ */
/*  Автообновление: правка журналов мира сразу уходит в базу           */
/* ------------------------------------------------------------------ */

const dirty = new Map(); // uuid страницы -> {page|null}
let timer = null;
let failures = 0;
export const kbSyncState = { stale: 0, lastError: null }; // для строки статуса панели

function folderPath(folder) {
  const parts = [];
  for (let f = folder; f; f = f.folder) parts.unshift(f.name);
  return parts.join(" / ");
}

function pageRecord(page, removed = false) {
  const entry = page.parent;
  const kind = kindFor(entry);
  return {
    uuid: page.uuid,
    entry: entry?.name ?? "",
    page: page.name,
    folder: entry?.folder ? folderPath(entry.folder) : "",
    kind,
    // Пустой текст = удалить страницу из базы (в т. ч. если папка помечена «не включать»).
    html: removed || kind === "exclude" || page.type !== "text" ? "" : (page.text?.content ?? ""),
  };
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(flush, 3000);
}

async function flush() {
  if (!dirty.size) return;
  const pages = [...dirty.values()];
  dirty.clear();
  try {
    await request("/kb/upsert", { method: "POST", body: { pages }, timeout: 60000 });
    failures = 0;
    kbSyncState.stale = dirty.size;
    kbSyncState.lastError = null;
  } catch (err) {
    // Сервер недоступен: правки возвращаются в очередь (новее уже лежащих не перекрываем) и уйдут позже.
    for (const p of pages) if (!dirty.has(p.uuid)) dirty.set(p.uuid, p);
    failures = Math.min(failures + 1, 6);
    kbSyncState.stale = dirty.size;
    kbSyncState.lastError = err.message;
    console.warn(`${MODULE_ID} | автообновление базы не удалось, повторю позже`, err);
    clearTimeout(timer);
    timer = setTimeout(flush, 30000 * failures); // 30 с, 1 мин … до 3 мин
  }
}

function markPage(page, removed = false) {
  if (!page || page.pack) return; // только журналы мира
  dirty.set(page.uuid, pageRecord(page, removed));
  kbSyncState.stale = dirty.size;
  schedule();
}

/** Страница уже отправлена другим путём (например, итоги сессии через indexEntry) — не слать второй раз. */
export function markSynced(uuids) {
  for (const u of uuids) dirty.delete(u);
  kbSyncState.stale = dirty.size;
}

function markEntry(entry, removed = false) {
  if (!entry || entry.pack) return;
  for (const page of entry.pages) markPage(page, removed);
}

export function registerKbSync() {
  // Только у активного мастера, чтобы правки не уходили дважды. Автообновление включено всегда.
  const on = () => game.user.isGM && game.users.activeGM?.id === game.user.id;
  const safe = (fn) => (...a) => { try { fn(...a); } catch (e) { console.warn(`${MODULE_ID} | автообновление базы`, e); } };
  Hooks.on("createJournalEntryPage", safe((page) => { if (on()) markPage(page); }));
  Hooks.on("updateJournalEntryPage", safe((page) => { if (on()) markPage(page); }));
  Hooks.on("deleteJournalEntryPage", safe((page) => { if (on()) markPage(page, true); }));
  Hooks.on("updateJournalEntry", safe((entry, changed) => {
    // Переименование или перенос в другую папку меняют заголовки и приоритет источника.
    if (on() && ("name" in changed || "folder" in changed)) markEntry(entry);
  }));
  Hooks.on("deleteJournalEntry", safe((entry) => { if (on()) markEntry(entry, true); }));
}
