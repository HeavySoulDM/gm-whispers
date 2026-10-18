/**
 * «Что нового»: показывается один раз после обновления модуля (версия из module.json).
 * Новые версии — сверху. Текст короткий: что изменилось для мастера, а не для кода.
 */

import { MODULE_ID } from "./api.js";
import { T, TList } from "./i18n.js";

/** Пункты — в lang/*.json: GMW.Changelog.<версия через _>.<n> (items читаются при показе, когда переводы уже загружены). */
export const CHANGELOG = [
  { version: "0.3.2", key: "GMW.Changelog.0_3_2" },
  { version: "0.3.0", key: "GMW.Changelog.0_3_0" },
  { version: "0.2.0", key: "GMW.Changelog.0_2_0" },
  { version: "0.1.0", key: "GMW.Changelog.0_1_0" },
];

function cmp(a, b) {
  return foundry.utils.isNewerVersion(a, b) ? 1 : a === b ? 0 : -1;
}

/** Показать изменения новее сохранённой версии; вызывать при ready у мастера. */
export async function showWhatsNew() {
  const current = game.modules.get(MODULE_ID)?.version ?? "0.0.0";
  const seen = String(game.settings.get(MODULE_ID, "lastSeenVersion") || "");
  if (seen === current) return;
  const fresh = seen ? CHANGELOG.filter(c => cmp(c.version, seen) > 0 && cmp(c.version, current) <= 0) : [];
  await game.settings.set(MODULE_ID, "lastSeenVersion", current);
  if (!fresh.length) return; // первая установка — ничего не показываем, панель сама проведёт по шагам
  const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const content = fresh.map(c => `<h4>${esc(T("GMW.Changelog.Version", { version: c.version }))}</h4><ul>${TList(c.key).map(i => `<li>${esc(i)}</li>`).join("")}</ul>`).join("");
  await foundry.applications.api.DialogV2.prompt({
    window: { title: T("GMW.Changelog.Title"), icon: "fas fa-hat-wizard" },
    content: `<div class="gmw-whatsnew">${content}</div>`,
    ok: { label: T("GMW.Changelog.Ok"), icon: "fas fa-check" },
    rejectClose: false,
  });
}
