import { stripHtml as stripHtmlSafe } from "./api.js";
import { kindFor } from "./kbsync.js";
import { statblock } from "./tactics.js";

/**
 * Сбор контекста игры для советника и выгрузка журналов в базу знаний.
 * Всё читается локально у мастера; на сервер уходит только в момент вопроса или обновления базы.
 */

function folderPath(folder) {
  const parts = [];
  for (let f = folder; f; f = f.folder) parts.unshift(f.name);
  return parts.join(" / ");
}

/** Все текстовые страницы журналов мира. */
export function collectJournalPages() {
  const pages = [];
  for (const entry of game.journal) {
    const folder = entry.folder ? folderPath(entry.folder) : "";
    const kind = kindFor(entry);
    for (const page of entry.pages) {
      if (page.type !== "text") continue;
      const html = page.text?.content ?? "";
      if (!html.trim()) continue;
      pages.push({ uuid: page.uuid, entry: entry.name, page: page.name, folder, html, kind });
    }
  }
  return pages;
}

function sceneContext(scene) {
  if (!scene) return null;
  const pageUuids = new Set();
  const notes = [];
  const addEntry = (entry) => entry?.pages?.forEach(p => { if (p.type === "text") pageUuids.add(p.uuid); });

  try {
    if (scene.journal) {
      const page = scene.journalEntryPage ? scene.journal.pages.get(scene.journalEntryPage) : null;
      if (page) pageUuids.add(page.uuid); else addEntry(scene.journal);
    }
  } catch (_) { /* старый формат сцены */ }

  for (const note of scene.notes ?? []) {
    try {
      const page = note.page;
      const entry = note.entry;
      if (page) pageUuids.add(page.uuid); else if (entry) addEntry(entry);
      const label = note.label || page?.name || entry?.name;
      if (label) notes.push(label);
    } catch (_) { /* заметка без журнала */ }
  }
  return { name: scene.navName || scene.name, notes: [...new Set(notes)], pageUuids: [...pageUuids].slice(0, 80) };
}

function actorSummary(actor) {
  if (!actor) return null;
  const sys = actor.system ?? {};
  const hp = sys.attributes?.hp;
  let classes = "";
  try {
    classes = Object.values(actor.classes ?? {}).map(c => `${c.name} ${c.system?.levels ?? ""}`.trim()).join(" / ");
  } catch (_) { /* не dnd5e */ }
  const conditions = [...(actor.statuses ?? [])].map(id => {
    const def = CONFIG.statusEffects?.find(s => s.id === id);
    return def ? game.i18n.localize(def.name ?? def.label ?? id) : id;
  });
  const details = sys.details ?? {};
  const named = (v) => (typeof v === "string" ? v : v?.name) || "";
  return {
    name: actor.name,
    classes,
    level: details.level ?? null,
    race: named(details.race) || named(actor.itemTypes?.race?.[0]) || "",
    background: named(details.background) || named(actor.itemTypes?.background?.[0]) || "",
    hp: hp ? { value: hp.value, max: hp.max } : null,
    conditions,
  };
}

function partyContext() {
  const out = [];
  for (const user of game.users) {
    if (user.isGM || !user.character) continue;
    const s = actorSummary(user.character);
    if (s) out.push({ player: user.name, ...s });
  }
  return out;
}

/** Сторона токена относительно партии: pc / hostile / friendly / neutral / secret. */
function sideOf(tokenDoc, actor) {
  if (actor?.hasPlayerOwner && actor.type === "character") return "pc";
  const D = CONST.TOKEN_DISPOSITIONS;
  switch (tokenDoc?.disposition) {
    case D.HOSTILE: return "hostile";
    case D.FRIENDLY: return "friendly";
    case D.NEUTRAL: return "neutral";
    case D.SECRET: return "secret";
    default: return "unknown";
  }
}

const stripHtml = (html, max = 500) => stripHtmlSafe(html, max);

/** Краткая информация о токене для советника. withBio — добавить начало описания актёра. */
function tokenInfo(tokenDoc, { withBio = false } = {}) {
  const actor = tokenDoc?.actor;
  const hp = actor?.system?.attributes?.hp;
  const info = {
    name: tokenDoc?.name ?? actor?.name ?? "?",
    actor: actor?.name && actor.name !== tokenDoc?.name ? actor.name : undefined,
    side: sideOf(tokenDoc, actor),
    hidden: !!tokenDoc?.hidden || undefined,
  };
  if (hp?.max) info.hp = { value: hp.value, max: hp.max };
  const cond = [...(actor?.statuses ?? [])].map(id => {
    const def = CONFIG.statusEffects?.find(s => s.id === id);
    return def ? game.i18n.localize(def.name ?? def.label ?? id) : id;
  });
  if (cond.length) info.conditions = cond;
  if (withBio && actor?.type !== "character") {
    const bio = actor?.system?.details?.biography?.value;
    const text = bio ? stripHtml(bio) : "";
    if (text) info.bio = text;
  }
  if (withBio) {
    try { const sb = statblock(actor, { detail: false }); if (sb) info.statblock = sb; } catch (_) { /* не dnd5e */ }
  }
  return info;
}

function combatContext() {
  const combat = game.combat;
  if (!combat?.started) return null;
  const current = combat.combatant;
  return {
    round: combat.round,
    current: current?.token ? tokenInfo(current.token, { withBio: true }) : { name: current?.name ?? "?" },
    combatants: combat.turns.map(c => {
      const info = c.token ? tokenInfo(c.token) : { name: c.name, side: "unknown" };
      if (c.isDefeated) info.defeated = true;
      return info;
    }),
  };
}

/** Токены на сцене вне боя: одинаковые схлопываются в «Гуль ×5». */
function sceneTokens(scene) {
  if (!scene || game.combat?.started) return [];
  const groups = new Map();
  for (const t of scene.tokens) {
    const info = tokenInfo(t);
    const key = `${info.name}|${info.side}|${info.hidden ? 1 : 0}`;
    const g = groups.get(key);
    if (g) g.count += 1; else groups.set(key, { name: info.name, side: info.side, hidden: info.hidden, count: 1 });
  }
  return [...groups.values()].slice(0, 40);
}

export function gatherContext({ includeScene = true, tokens = null } = {}) {
  if (!includeScene) return null;
  const scene = canvas?.scene ?? game.scenes.viewed;
  const selected = tokens ?? canvas?.tokens?.controlled ?? [];
  return {
    scene: sceneContext(scene),
    party: partyContext(),
    combat: combatContext(),
    tokens: sceneTokens(scene),
    selected: selected.slice(0, 6).map(t => tokenInfo(t.document ?? t, { withBio: true })),
  };
}
