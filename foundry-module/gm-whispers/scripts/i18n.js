/**
 * Тексты интерфейса: lang/ru.json и lang/en.json (Foundry читает их при старте по module.json → languages).
 *
 * T(key, data) — перевод по ключу через game.i18n с подстановкой {плейсхолдеров}.
 * Если Foundry ещё не подхватил языковые файлы (новая строка добавлена без перезапуска Foundry),
 * берём русский текст из lang/ru.json, который модуль сам читает при init (см. preloadFallback).
 * Если и его нет — возвращаем ключ, чтобы было видно, что строка не найдена.
 */

import { MODULE_ID } from "./api.js";

let FALLBACK = {};

/** Прочитать lang/ru.json как запасной словарь. Вызывается один раз при init; ошибки не мешают работе. */
export async function preloadFallback() {
  try {
    const res = await fetch(`modules/${MODULE_ID}/lang/ru.json`, { cache: "no-cache" });
    if (res.ok) FALLBACK = flatten(await res.json());
  } catch (_) { /* нет файла или сети — переводы только через game.i18n */ }
}

function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out);
    else out[key] = String(v);
  }
  return out;
}

function fill(text, data) {
  if (!data) return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in data ? String(data[k]) : m));
}

/** Перевод строки интерфейса. */
export function T(key, data) {
  const i18n = globalThis.game?.i18n;
  if (i18n?.has?.(key)) return data ? i18n.format(key, data) : i18n.localize(key);
  const fb = FALLBACK[key];
  return fb != null ? fill(fb, data) : key;
}

/** Русский текст из запасного словаря (lang/ru.json), независимо от языка Foundry; null, если нет. */
export function TRu(key) {
  return FALLBACK[key] ?? null;
}

/** Массив строк по префиксу ключа: GMW.Examples.general.1, .2, … (пока ключи идут подряд). */
export function TList(prefix) {
  const out = [];
  for (let i = 1; i < 100; i++) {
    const key = `${prefix}.${i}`;
    const s = T(key);
    if (s === key) break;
    out.push(s);
  }
  return out;
}
