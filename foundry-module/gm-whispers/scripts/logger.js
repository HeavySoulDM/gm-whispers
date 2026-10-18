/**
 * Журнал сессии: события Foundry уходят на сервер GM Whispers в реальном времени
 * (data/sessions/<сессия>/events.jsonl). Поэтому чистка чата (chatlog-prune, ручная) итогам не мешает.
 *
 * Пишет только активный мастер. Если сервер недоступен — события копятся и отправляются позже
 * (переживают перезагрузку страницы через localStorage).
 */

import { MODULE_ID, isNoise, request, stripHtml } from "./api.js";
import { T } from "./i18n.js";

const QUEUE_KEY = "gm-whispers.eventQueue";
const FLUSH_MS = 10000;
const MAX_QUEUE = 5000;

let queue = [];
let timer = null;
let flushing = false;
const hpSnapshot = new Map(); // combatantId -> hp на начало хода

export const loggerState = { sent: 0, pending: 0, lastError: null };

function strip(html, max = 400) {
  return stripHtml(html, max);
}

function enabled() {
  try {
    return game.user.isGM && game.users.activeGM?.id === game.user.id; // журнал ведётся всегда — без него нет «Итогов»
  } catch (_) {
    return false;
  }
}

let persistTimer = null;
function persistNow() {
  persistTimer = null;
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE))); } catch (_) { /* приватный режим или место кончилось */ }
}
function persist() {
  // Сериализовать очередь на каждое сообщение чата дорого — пишем не чаще раза в 2 с.
  if (!persistTimer) persistTimer = setTimeout(persistNow, 2000);
}

function push(kind, text, extra = {}) {
  if (!enabled() || !text) return;
  queue.push({ ts: Date.now(), kind, text, ...extra });
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  loggerState.pending = queue.length;
  persist();
  if (queue.length >= 40) flush();
}

export async function flush() {
  if (flushing || !queue.length) return;
  flushing = true;
  const batch = queue.slice(0, 200);
  try {
    await request("/session/events", { method: "POST", body: { events: batch }, timeout: 15000 });
    queue = queue.slice(batch.length);
    loggerState.sent += batch.length;
    loggerState.lastError = null;
    persist();
  } catch (err) {
    loggerState.lastError = err.message;
  } finally {
    loggerState.pending = queue.length;
    flushing = false;
  }
}

/* ------------------------------------------------------------------ */

function chatEvent(m) {
  const who = m.speaker?.alias || m.alias || m.author?.name || "";
  if (who === "GM Whispers" || isNoise(m)) return;
  const flavor = strip(m.flavor, 160);
  let content = strip(m.content, 500);
  const rolls = (m.rolls ?? []).map(r => {
    const total = Number.isInteger(r.total) ? r.total : Math.floor(r.total ?? 0);
    return `${r.formula} = ${total}`;
  });
  if (rolls.length && /^[\d.,\s]+$/.test(content)) content = "";
  const text = [flavor, content, rolls.length ? T("GMW.Log.Roll", { rolls: rolls.join("; ") }) : ""].filter(Boolean).join(" — ");
  const whisper = (m.whisper ?? []).map(id => game.users.get(id)?.name).filter(Boolean).join(", ");
  push(rolls.length ? "roll" : "chat", text, { who, whisper: whisper || undefined });
}

function hpOf(c) {
  return c.actor?.system?.attributes?.hp?.value;
}

function snapshotCombat(combat) {
  for (const c of combat?.combatants ?? []) hpSnapshot.set(c.id, hpOf(c));
}

function hpChanges(combat) {
  const parts = [];
  for (const c of combat?.combatants ?? []) {
    const before = hpSnapshot.get(c.id);
    const now = hpOf(c);
    if (before != null && now != null && before !== now) {
      const d = now - before;
      parts.push(`${c.name} ${before}→${now} (${d > 0 ? "+" : ""}${d})`);
    }
  }
  snapshotCombat(combat);
  if (parts.length) push("hp", parts.join("; "));
}

function combatantsText(combat) {
  return combat.combatants.contents.map(c => c.name).join(", ");
}

export function registerLogger() {
  try { queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); } catch (_) { queue = []; }
  loggerState.pending = queue.length;

  Hooks.on("createChatMessage", (msg) => { try { chatEvent(msg); } catch (e) { console.warn(`${MODULE_ID} | лог чата`, e); } });

  const safe = (fn) => (...a) => { try { fn(...a); } catch (e) { console.warn(`${MODULE_ID} | журнал сессии`, e); } };

  Hooks.on("combatStart", safe((combat) => {
    snapshotCombat(combat);
    push("combat", T("GMW.Log.CombatStart", { scene: combat.scene?.name ?? T("GMW.Log.UnknownScene"), list: combatantsText(combat) }));
  }));
  Hooks.on("updateCombat", safe((combat, changed) => {
    if (!combat.started) return;
    if ("round" in changed || "turn" in changed) hpChanges(combat);
    if ("round" in changed) push("combat", T("GMW.Log.Round", { n: combat.round }));
    if ("turn" in changed || "round" in changed) {
      const c = combat.combatant;
      if (c) push("combat", T("GMW.Log.Turn", { name: c.name }));
    }
  }));
  Hooks.on("updateCombatant", safe((c, changed) => {
    if (changed.defeated === true) push("combat", T("GMW.Log.Defeated", { name: c.name }));
  }));
  Hooks.on("deleteCombat", safe((combat) => {
    for (const c of combat.combatants) hpSnapshot.delete(c.id);
    if (!combat.started) return;
    hpChanges(combat);
    const down = combat.combatants.filter(c => c.isDefeated || (hpOf(c) ?? 1) <= 0).map(c => c.name);
    const up = combat.combatants.filter(c => !(c.isDefeated || (hpOf(c) ?? 1) <= 0)).map(c => {
      const hp = c.actor?.system?.attributes?.hp;
      return hp?.max ? `${c.name} ${hp.value}/${hp.max}` : c.name;
    });
    push("combat", T("GMW.Log.CombatEnd", { round: combat.round, down: down.join(", ") || T("GMW.Log.Nobody"), up: up.join(", ") || T("GMW.Log.Nobody") }));
  }));

  Hooks.on("updateScene", safe((scene, changed) => {
    if (changed.active === true) push("scene", T("GMW.Log.ActiveScene", { name: scene.navName || scene.name }));
  }));

  Hooks.on("createItem", safe((item, _opts, userId) => {
    const actor = item.parent;
    if (!actor || actor.documentName !== "Actor" || actor.type !== "character" || !actor.hasPlayerOwner) return;
    if (["class", "subclass", "background", "race", "feat", "spell"].includes(item.type)) return;
    const qty = item.system?.quantity > 1 ? ` ×${item.system.quantity}` : "";
    push("loot", T("GMW.Log.Loot", { actor: actor.name, item: item.name }) + qty, { who: game.users.get(userId)?.name });
  }));

  timer = setInterval(flush, FLUSH_MS);
  window.addEventListener("beforeunload", () => persistNow());
}
