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

import { MODULE_ID, askHotkey, openPanel, refreshKnowledge } from "./panel.js";
import { showWhatsNew } from "./changelog.js";
import { openSummaryDialog } from "./session.js";
import { openPrepDialog } from "./prep.js";
import { openOrBuildBible } from "./bible.js";
import { registerLogger } from "./logger.js";
import { registerTokenHud } from "./tokenhud.js";
import { registerKbSync } from "./kbsync.js";
import { ServerSettingsApp, openServerSettings } from "./settings.js";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "serverUrl", {
    name: "Адрес сервера GM Whispers Core",
    hint: "Обычно http://127.0.0.1:8765. Настройка хранится только в этом браузере.",
    scope: "client", config: true, type: String, default: "http://127.0.0.1:8765",
  });
  game.settings.register(MODULE_ID, "token", {
    name: "Локальный токен",
    hint: "Значение GMW_LOCAL_TOKEN из server/.env (его печатает start.bat при запуске). Хранится только в этом браузере.",
    scope: "client", config: true, type: String, default: "",
  });

  game.settings.registerMenu(MODULE_ID, "serverSettings", {
    name: "Настройки сервера",
    label: "Открыть настройки сервера",
    hint: "Ключи API и модели, папка записей Craig, кто есть кто в записи, что не учитывать в итогах. То же окно — кнопка ⚙ в панели советника.",
    icon: "fas fa-sliders",
    type: ServerSettingsApp,
    restricted: true,
  });

  game.settings.register(MODULE_ID, "logSession", {
    name: "Вести журнал сессии",
    hint: "Чат, ход боя, хиты, смена сцен и добыча сохраняются на сервере GM Whispers (data/sessions) — для итогов. Чистка чата на журнал не влияет.",
    scope: "world", config: true, type: Boolean, default: true,
  });

  game.settings.register(MODULE_ID, "kbPacks", {
    name: "Компендиумы в базе знаний",
    hint: "Удобнее отмечать галочками в ⚙ «Настройки сервера» → Источники знаний. Здесь — id через запятую. После изменения нажми «База».",
    scope: "world", config: true, type: String,
    default: "",
  });
  game.settings.register(MODULE_ID, "kbSources", {
    // Вид источника по id папки журналов ("" — журналы без папки): gm / diary / adventure / setting / rules / other / exclude / auto.
    scope: "world", config: false, type: Object, default: {},
  });
  game.settings.register(MODULE_ID, "bibleQuentaFolder", {
    scope: "world", config: false, type: String, default: "",
  });
  game.settings.register(MODULE_ID, "kbAutoSync", {
    name: "Автообновление базы знаний",
    hint: "Правки журналов мира сразу попадают в базу советника — без кнопки «База».",
    scope: "world", config: true, type: Boolean, default: true,
  });

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
    name: "Открыть советника GM Whispers",
    editable: [{ key: "KeyG", modifiers: ["Alt"] }],
    restricted: true,
    onDown: () => { openPanel(); return true; },
  });
  game.keybindings.register(MODULE_ID, "tacticsToken", {
    name: "GM Whispers: тактика для выделенного токена",
    hint: "Варианты хода для выделенного токена (или того, чей ход в бою).",
    editable: [{ key: "KeyT", modifiers: ["Alt"] }],
    restricted: true,
    onDown: () => { askHotkey("tactics"); return true; },
  });
  game.keybindings.register(MODULE_ID, "lineToken", {
    name: "GM Whispers: реплика выделенного токена",
    hint: "2–3 реплики, которые NPC может сказать прямо сейчас.",
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
      title: "GM Whispers — советник",
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
    prep: async () => { const panel = await openPanel(); if (panel) openPrepDialog(panel); },
    bible: async (rebuild = false) => { const panel = await openPanel(); if (panel) openOrBuildBible(panel, { rebuild }); },
    summary: async () => {
      await openPanel();
      const panel = foundry.applications.instances?.get?.("gm-whispers-panel");
      if (panel) openSummaryDialog(panel);
    },
  };
  console.log(`${MODULE_ID} | готов: game.gmWhispers.open()`);
  showWhatsNew().catch(e => console.warn(`${MODULE_ID} | что нового`, e));
});
