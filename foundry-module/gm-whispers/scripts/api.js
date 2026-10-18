/**
 * Связь с локальным сервером GM Whispers Core.
 * Адрес и токен — клиентские настройки (хранятся только в браузере мастера, в мир не попадают).
 */

import { T } from "./i18n.js";

export const MODULE_ID = "gm-whispers";

export function serverUrl() {
  return String(game.settings.get(MODULE_ID, "serverUrl") || "http://127.0.0.1:8765").replace(/\/+$/, "");
}

function token() {
  return String(game.settings.get(MODULE_ID, "token") || "").trim();
}

export class ServerError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

export async function request(path, { method = "GET", body, timeout = 180000 } = {}) {
  if (!token()) throw new ServerError(T("GMW.Api.NoToken"), 401);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(serverUrl() + path, {
      method,
      headers: { "Content-Type": "application/json", "X-GMW-Token": token() },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw new ServerError(T("GMW.Api.Timeout"));
    throw new ServerError(T("GMW.Api.NoConnection", { url: serverUrl() }));
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch (_) { /* пустой ответ */ }
  if (!res.ok) throw new ServerError(data?.detail || T("GMW.Api.ServerError", { status: res.status }), res.status);
  return data;
}

export const health = () => request("/health", { timeout: 8000 });

/**
 * Потоковый вопрос: события {type: status|delta|reset|done|error} приходят по мере генерации.
 * onEvent вызывается на каждое; возвращает результат «done». Если сервер старый (404) — бросает ServerError со status 404,
 * чтобы вызывающий мог откатиться на обычный /ask.
 */
export async function askStream(payload, onEvent, { timeout = 190000 } = {}) {
  if (!token()) throw new ServerError(T("GMW.Api.NoToken"), 401);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(serverUrl() + "/ask/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-GMW-Token": token() },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new ServerError(T("GMW.Api.Timeout"));
    throw new ServerError(T("GMW.Api.NoConnection", { url: serverUrl() }));
  }
  if (!res.ok) {
    clearTimeout(timer);
    let data = null;
    try { data = await res.json(); } catch (_) { /* пусто */ }
    throw new ServerError(data?.detail || T("GMW.Api.ServerError", { status: res.status }), res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result = null;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch (_) { continue; }
        if (ev.type === "error") throw new ServerError(ev.message || T("GMW.Api.ModelError"), ev.status || 502);
        if (ev.type === "done") { result = ev; break; }
        if (ev.type !== "ping") onEvent?.(ev);
      }
      if (result) break;
    }
  } finally {
    clearTimeout(timer);
    try { reader.cancel(); } catch (_) { /* уже закрыт */ }
  }
  if (!result) throw new ServerError(T("GMW.Api.StreamBroken"));
  return result;
}
export const ask = (payload) => request("/ask", { method: "POST", body: payload });
export const importKnowledge = (payload) => request("/kb/import", { method: "POST", body: payload, timeout: 300000 });

/** Текст из HTML без выполнения скриптов и загрузки картинок (DOMParser не грузит ресурсы, в отличие от div.innerHTML). */
export function stripHtml(html, max = 400) {
  let text = "";
  try {
    text = new DOMParser().parseFromString(String(html ?? ""), "text/html").body?.textContent ?? "";
  } catch (_) { text = String(html ?? "").replace(/<[^>]+>/g, " "); }
  text = text.replace(/\s+/g, " ").trim();
  return max && text.length > max ? text.slice(0, max) + "…" : text;
}

/** Игровая система мира. Статблоки, подписи действий и заклинания модуль умеет читать только у dnd5e;
 * геометрия тактики (пути, укрытия, двери) и всё остальное — для любой системы. */
export function isDnd5e() {
  return game.system?.id === "dnd5e";
}

/** HTML → текст с сохранением абзацев и списков (для квент и библии, где структура важна). */
export function htmlToText(html, max = 0) {
  let src = String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|section)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<h([1-6])[^>]*>/gi, (_m, n) => "\n" + "#".repeat(Number(n)) + " ");
  let text = "";
  try { text = new DOMParser().parseFromString(src, "text/html").body?.textContent ?? ""; } catch (_) { text = src.replace(/<[^>]+>/g, " "); }
  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
  return max && text.length > max ? text.slice(0, max) + "…" : text;
}

/** Служебные сообщения чата других модулей, которые не нужны в итогах (подсказки AG D&D Hub и т. п.). */
export function isNoise(m) {
  return !!m?.flags?.["ag-dnd-hub"]?.tip;
}
