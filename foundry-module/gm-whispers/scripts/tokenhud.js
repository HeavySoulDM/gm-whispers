/**
 * «Спросить о токене»: кнопка со шляпой волшебника в меню токена (правый клик), только у мастера.
 * Открывает стандартную выпадающую палитру HUD с тремя вопросами.
 */

import { openPanel } from "./panel.js";
import { T } from "./i18n.js";

const ITEMS = [
  { kind: "who", icon: "fa-circle-question", label: "GMW.TokenHud.Who" },
  { kind: "line", icon: "fa-comment-dots", label: "GMW.TokenHud.Line" },
  { kind: "tactics", icon: "fa-chess-knight", label: "GMW.TokenHud.Tactics" },
];

async function ask(token, kind) {
  await openPanel();
  const panel = foundry.applications.instances?.get?.("gm-whispers-panel");
  if (!panel) return;
  if (panel.busy) return ui.notifications.warn(T("GMW.Panel.Busy"));
  panel.askAboutToken(token, kind);
}

export function registerTokenHud() {
  Hooks.on("renderTokenHUD", (hud, html) => {
    if (!game.user.isGM) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    const col = root?.querySelector(".col.left");
    if (!col || col.querySelector('[data-palette="gm-whispers"]')) return;
    const token = hud.object;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "control-icon";
    button.dataset.action = "togglePalette";
    button.dataset.palette = "gm-whispers";
    button.dataset.tooltip = T("GMW.TokenHud.Tooltip");
    button.setAttribute("aria-label", "GM Whispers");
    button.innerHTML = '<i class="fa-solid fa-hat-wizard" inert></i>';

    const palette = document.createElement("div");
    palette.className = "palette palette-list";
    palette.dataset.palette = "gm-whispers";
    for (const it of ITEMS) {
      const a = document.createElement("a");
      a.className = "palette-list-entry";
      a.innerHTML = `<i class="fa-solid ${it.icon}"></i> <span>${T(it.label)}</span>`;
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        hud.close?.();
        ask(token, it.kind);
      });
      palette.append(a);
    }
    col.append(button, palette);
  });
}
