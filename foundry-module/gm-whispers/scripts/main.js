/**
 * GM Whispers — ИИ-помощник мастера.
 *
 * Консоль / макросы (под мастером):
 *   game.gmWhispers.open()       // панель советника (также Alt+G и кнопка на панели токенов)
 *   game.gmWhispers.refreshKb()  // выгрузить журналы мира в базу знаний
 *   game.gmWhispers.summary()    // итоги сессии → «Дневник кампании»
 *   game.gmWhispers.settings()   // настройки сервера: ключи, модели, Craig
 *   game.gmWhispers.prep()       // «К игре»: сводка перед сессией → журнал
 *   game.gmWhispers.bible()      // Библия кампании: открыть или собрать; bible(true) — пересобрать
 */

import { MODULE_ID, askHotkey, autoBuildKnowledgeOnReady, openPanel, refreshKnowledge } from "./panel.js";
import { showWhatsNew } from "./changelog.js";
import { openSummaryDialog } from "./session.js";
import { openPrepDialog } from "./prep.js";
import { openOrBuildBible } from "./bible.js";
import { registerLogger } from "./logger.js";
import { registerTokenHud } from "./tokenhud.js";
import { registerKbSync } from "./kbsync.js";
import { ServerSettingsApp, openServerSettings } from "./settings.js";
import { maybeOpenSetup, openSetupWizard } from "./setup.js";
import { T, preloadFallback } from "./i18n.js";

Hooks.once("init", () => {
  preloadFallback(); // запасной словарь, если languages из module.json ещё не подхвачены
  // Все настройки правятся в одном окне (⚙ в панели / меню ниже); в стандартном списке Foundry их не показываем.
  game.settings.register(MODULE_ID, "serverUrl", { scope: "client", config: false, type: String, default: "http://127.0.0.1:8765" });
  game.settings.register(MODULE_ID, "token", { scope: "client", config: false, type: String, default: "" });

  game.settings.registerMenu(MODULE_ID, "serverSettings", {
    name: T("GMW.Settings.MenuName"),
    label: T("GMW.Settings.MenuLabel"),
    hint: T("GMW.Settings.MenuHint"),
    icon: "fas fa-sliders",
    type: ServerSettingsApp,
    restricted: true,
  });

  // Журнал сессии нужен для «Итогов» — ведётся всегда (поле оставлено для совместимости со старыми мирами).
  game.settings.register(MODULE_ID, "logSession", { scope: "world", config: false, type: Boolean, default: true });
  // Компендиумы в базе знаний: id через запятую; отмечаются галочками в окне настроек → Кампания → Источники.
  game.settings.register(MODULE_ID, "kbPacks", { scope: "world", config: false, type: String, default: "" });
  game.settings.register(MODULE_ID, "kbSources", {
    // Вид источника по id папки журналов ("" — журналы без папки): gm / diary / adventure / setting / rules / other / exclude / auto.
    scope: "world", config: false, type: Object, default: {},
  });
  game.settings.register(MODULE_ID, "bibleQuentaFolder", {
    scope: "world", config: false, type: String, default: "",
  });
  // Автообновление базы включено всегда (поле оставлено для совместимости).
  game.settings.register(MODULE_ID, "kbAutoSync", { scope: "world", config: false, type: Boolean, default: true });

  // Мастер первого запуска пройден (или мир был настроен до его появления).
  game.settings.register(MODULE_ID, "setupDone", { scope: "world", config: false, type: Boolean, default: false });

  game.settings.register(MODULE_ID, "lastSummaryAt", {
    scope: "world", config: false, type: Number, default: 0,
  });
  game.settings.register(MODULE_ID, "showExamples", {
    scope: "client", config: false, type: Boolean, default: true,
  });
  game.settings.register(MODULE_ID, "lastSeenVersion", {
    scope: "client", config: false, type: String, default: "",
  });

  game.keybindings.register(MODULE_ID, "openPanel", {
    name: T("GMW.Keybinds.OpenPanel"),
    editable: [{ key: "KeyG", modifiers: ["Alt"] }],
    restricted: true,
    onDown: () => { openPanel(); return true; },
  });
  game.keybindings.register(MODULE_ID, "tacticsToken", {
    name: T("GMW.Keybinds.Tactics"),
    hint: T("GMW.Keybinds.TacticsHint"),
    editable: [{ key: "KeyT", modifiers: ["Alt"] }],
    restricted: true,
    onDown: () => { askHotkey("tactics"); return true; },
  });
  game.keybindings.register(MODULE_ID, "lineToken", {
    name: T("GMW.Keybinds.Line"),
    hint: T("GMW.Keybinds.LineHint"),
    editable: [{ key: "KeyR", modifiers: ["Alt"] }],
    restricted: true,
    onDown: () => { askHotkey("line"); return true; },
  });

  registerTokenHud();

  Hooks.on("getSceneControlButtons", (controls) => {
    if (!game.user?.isGM) return;
    const group = controls.tokens ?? controls.token;
    if (!group?.tools) return;
    group.tools[MODULE_ID] = {
      name: MODULE_ID,
      title: T("GMW.Panel.ControlTitle"),
      icon: "fas fa-hat-wizard",
      button: true,
      order: 99,
      onChange: (_event, active) => { if (active !== false) openPanel(); },
    };
  });
});

Hooks.once("ready", () => {
  if (!game.user.isGM) return;
  registerLogger();
  registerKbSync();
  game.gmWhispers = {
    open: openPanel,
    refreshKb: refreshKnowledge,
    settings: openServerSettings,
    setup: openSetupWizard,
    prep: async () => { const panel = await openPanel(); if (panel) openPrepDialog(panel); },
    bible: async (rebuild = false) => { const panel = await openPanel(); if (panel) openOrBuildBible(panel, { rebuild }); },
    summary: async () => {
      await openPanel();
      const panel = foundry.applications.instances?.get?.("gm-whispers-panel");
      if (panel) openSummaryDialog(panel);
    },
  };
  console.log(`${MODULE_ID} | готов: game.gmWhispers.open()`);
  setTimeout(() => autoBuildKnowledgeOnReady(), 5000); // даём миру догрузиться
  setTimeout(() => maybeOpenSetup().catch(e => console.warn(`${MODULE_ID} | мастер настройки`, e)), 2500);
  showWhatsNew().catch(e => console.warn(`${MODULE_ID} | что нового`, e));
});
