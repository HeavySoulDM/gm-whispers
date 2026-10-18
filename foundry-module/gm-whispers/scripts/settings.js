/**
 * Окно «Настройки сервера GM Whispers»: ключи API и модели, папка записей Craig,
 * словарь «кто есть кто» и исключения — всё, что раньше правилось в server/.env и config/*.json.
 *
 * Ключи уходят только на локальный сервер (127.0.0.1) и хранятся в server/.env; обратно
 * сервер отдаёт лишь «задан / не задан» и последние 4 символа.
 */

import { MODULE_ID, ServerError, request } from "./api.js";
import { esc } from "./md.js";
import { bibleEntry, bibleEntryName, buildBible, guessQuentaFolder, quentaFolders } from "./bible.js";
import { openPanel } from "./panel.js";
import { T } from "./i18n.js";

const { ApplicationV2 } = foundry.applications.api;

const PROVIDERS = {
  anthropic: { title: "Claude (Anthropic)", where: "console.anthropic.com → API keys", prefix: "sk-ant-" },
  openai: { title: "OpenAI", where: "platform.openai.com → API keys", prefix: "sk-" },
  gemini: { title: "Gemini (Google)", where: "aistudio.google.com → Get API key", prefix: "AIza" },
  deepseek: { title: "DeepSeek", where: "platform.deepseek.com → API keys", prefix: "sk-" },
  openrouter: { title: "OpenRouter", where: null, prefix: "sk-or-" }, // where — GMW.Settings.WhereOpenrouter
  custom: { title: null, where: null, prefix: "" },                     // GMW.Settings.ProviderCustom / WhereCustom
};
function providerTitle(p) { return p === "custom" ? T("GMW.Settings.ProviderCustom") : PROVIDERS[p].title; }
function providerWhere(p) {
  if (p === "openrouter") return T("GMW.Settings.WhereOpenrouter");
  if (p === "custom") return T("GMW.Settings.WhereCustom");
  return PROVIDERS[p].where;
}
const PROVIDER_ORDER = ["anthropic", "openai", "gemini", "deepseek", "openrouter", "custom"];
const KINDS_ORDER = ["auto", "gm", "diary", "adventure", "setting", "rules", "other", "exclude"];
// Подписи — ключи lang/*.json, переводятся при отрисовке.
const ROLES = {
  lore: { title: "GMW.Settings.RoleLore", hint: "GMW.Settings.RoleLoreHint" },
  tactics: { title: "GMW.Settings.RoleTactics", hint: "GMW.Settings.RoleTacticsHint" },
  fast: { title: "GMW.Settings.RoleFast", hint: "GMW.Settings.RoleFastHint" },
};
const KIND_LABELS = {
  auto: "GMW.Settings.KindAuto", gm: "GMW.Settings.KindGm", diary: "GMW.Settings.KindDiary", adventure: "GMW.Settings.KindAdventure",
  setting: "GMW.Settings.KindSetting", rules: "GMW.Settings.KindRules", other: "GMW.Settings.KindOther", exclude: "GMW.Settings.KindExclude",
};
const KIND_HINTS = {
  gm: "GMW.Settings.KindGmHint",
  diary: "GMW.Settings.KindDiaryHint",
  adventure: "GMW.Settings.KindAdventureHint",
  setting: "GMW.Settings.KindSettingHint",
  rules: "GMW.Settings.KindRulesHint",
  other: "GMW.Settings.KindOtherHint",
  exclude: "GMW.Settings.KindExcludeHint",
};
const kindLabel = (k) => T(KIND_LABELS[k]);
const kindHint = (k) => (KIND_HINTS[k] ? T(KIND_HINTS[k]) : "");
/** Популярные системы: подпись для модели и id системы Foundry, по которому угадываем по умолчанию. */
const SYSTEMS = [
  ["D&D 5e (правила 2024)", ["dnd5e"]],
  ["D&D 5e (правила 2014)", []],
  ["Pathfinder 2e", ["pf2e"]],
  ["Pathfinder 1e", ["pf1"]],
  ["Daggerheart", ["daggerheart"]],
  ["Call of Cthulhu 7e", ["CoC7", "coc7"]],
  ["Warhammer Fantasy Roleplay 4e", ["wfrp4e"]],
  ["Savage Worlds", ["swade"]],
  ["Vampire: The Masquerade 5e", ["vtm5e", "wod"]],
  ["Cyberpunk RED", ["cyberpunk-red-core"]],
  ["Starfinder", ["sfrpg", "sf2e"]],
  ["Dungeon World", ["dungeonworld"]],
  ["Shadowrun", ["shadowrun5e", "shadowrun6-eden"]],
  ["Blades in the Dark", ["blades-in-the-dark"]],
];
const SPEECH_LANGS = [["ru", "GMW.Settings.LangRu"], ["en", "GMW.Settings.LangEn"], ["auto", "GMW.Settings.SpeechAuto"]];

const LANGS = [["auto", "GMW.Settings.LangAuto"], ["ru", "GMW.Settings.LangRu"], ["en", "GMW.Settings.LangEn"]];

function providerOf(model) {
  const m = String(model || "");
  const pref = m.match(/^([a-z]+):/i)?.[1]?.toLowerCase();
  if (pref && PROVIDERS[pref]) return pref;
  if (/^(gpt|chatgpt|o[134])/i.test(m)) return "openai";
  if (/^gemini/i.test(m)) return "gemini";
  if (/^deepseek/i.test(m)) return "deepseek";
  if (m.includes("/")) return "openrouter";
  return "anthropic";
}

export class ServerSettingsApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "gm-whispers-settings",
    classes: ["gm-whispers", "gmw-settings"],
    tag: "div",
    window: { title: T("GMW.Settings.Title"), icon: "fas fa-sliders", resizable: true },
    position: { width: 620, height: "auto" },
    actions: {
      checkKey: ServerSettingsApp.#onCheckKey,
      clearKey: ServerSettingsApp.#onClearKey,
      testServer: ServerSettingsApp.#onTestServer,
      addSpeaker: ServerSettingsApp.#onAddSpeaker,
      removeSpeaker: ServerSettingsApp.#onRemoveSpeaker,
      save: ServerSettingsApp.#onSave,
      reload: ServerSettingsApp.#onReload,
      exportSettings: ServerSettingsApp.#onExport,
      importSettings: ServerSettingsApp.#onImport,
      switchTab: ServerSettingsApp.#onTab,
      rebuildKb: ServerSettingsApp.#onRebuildKb,
      buildBible: ServerSettingsApp.#onBuildBible,
      openBible: ServerSettingsApp.#onOpenBible,
      openSetup: ServerSettingsApp.#onOpenSetup,
    },
  };

  constructor(options = {}) {
    super(options);
    this.data = null;          // ответ GET /settings
    this.error = null;
    this.models = Object.fromEntries(PROVIDER_ORDER.map(p => [p, []])); // списки моделей после проверки ключа
    this.keyStatus = Object.fromEntries(PROVIDER_ORDER.map(p => [p, ""]));
    this.clearKeys = new Set();
    this.speakers = [];        // [{key, name}]
    this.sources = null;       // {folderId: kind} — черновик настройки kbSources
    this.saving = false;
    this.tab = "connect";      // активная вкладка
    this.keyProvider = null;   // какой сервис показан в блоке «Ключ API»
  }

  async load() {
    this.error = null;
    try {
      this.data = await request("/settings", { timeout: 10000 });
      if (!Object.values(this.data.keys ?? {}).some(k => k.set)) this.tab = "connect";
      this.speakers = Object.entries(this.data.speakers ?? {}).map(([key, name]) => ({ key, name }));
      // Текущие модели всегда есть в списках, даже до проверки ключа.
      for (const m of Object.values(this.data.models ?? {})) if (m && m !== "auto") this._addModel(m);
      for (const m of Object.values(this.data.resolved ?? {})) if (typeof m === "string") this._addModel(m);
    } catch (err) {
      this.error = err.message;
    }
    this.render();
  }

  _addModel(id) {
    const p = providerOf(id);
    if (!this.models[p].includes(id)) this.models[p].push(id);
  }

  /* ------------------------------------------------------------ разметка */

  _customRow() {
    const c = this.data?.custom ?? {};
    return `
      <div class="gmw-grid gmw-three">
        <div class="gmw-field"><label>${T("GMW.Settings.CustomName")}</label><input type="text" name="custom_name" value="${esc(c.name ?? "")}" placeholder="RouterAI"><p class="hint">${T("GMW.Settings.CustomNameHint")}</p></div>
        <div class="gmw-field"><label>${T("GMW.Settings.CustomUrl")}</label><input type="text" name="custom_base_url" value="${esc(c.base_url ?? "")}" placeholder="https://api.example.com/v1"><p class="hint">${T("GMW.Settings.CustomUrlHint")}</p></div>
        <div class="gmw-field"><label>${T("GMW.Settings.CustomModel")}</label><input type="text" name="custom_model" value="${esc(c.model ?? "")}" placeholder="${esc(T("GMW.Settings.CustomModelPlaceholder"))}"><p class="hint">${T("GMW.Settings.CustomModelHint")}</p></div>
      </div>`;
  }

  _keyRow(provider) {
    const info = PROVIDERS[provider];
    const k = this.data?.keys?.[provider] ?? { set: false, hint: "" };
    const cleared = this.clearKeys.has(provider);
    const state = cleared ? T("GMW.Settings.KeyWillRemove") : k.set ? T("GMW.Settings.KeySet", { hint: esc(k.hint) }) : T("GMW.Settings.KeyNotSet");
    const cls = cleared ? "gmw-bad" : k.set ? "gmw-ok" : "gmw-muted";
    return `
      <div class="gmw-field">
        <label>${T("GMW.Settings.KeyLabel", { provider: providerTitle(provider) })} <span class="gmw-key-state ${cls}">· ${state}</span></label>
        <div class="gmw-inline">
          <input type="password" name="key-${provider}" autocomplete="off" spellcheck="false"
                 placeholder="${esc(k.set ? T("GMW.Settings.KeyKeepPlaceholder") : T("GMW.Settings.KeyPastePlaceholder", { prefix: info.prefix }))}">
          <button type="button" data-action="checkKey" data-provider="${provider}" data-tooltip="${esc(T("GMW.Settings.CheckKeyTooltip"))}"><i class="fas fa-plug-circle-check"></i> ${T("GMW.Settings.Check")}</button>
          ${k.set ? `<button type="button" data-action="clearKey" data-provider="${provider}" data-tooltip="${esc(T("GMW.Settings.RemoveKeyTooltip"))}"><i class="fas fa-trash"></i></button>` : ""}
        </div>
        <p class="hint">${T("GMW.Settings.WhereToGet", { where: providerWhere(provider) })} ${this.keyStatus[provider] ? `<span class="gmw-key-result">${esc(this.keyStatus[provider])}</span>` : ""}</p>
        ${provider === "custom" ? this._customRow() : ""}
      </div>`;
  }

  _modelSelect(role) {
    const cur = this.data?.models?.[role] ?? "auto";
    const resolved = this.data?.resolved?.[role] ?? "";
    const opts = [`<option value="auto" ${cur === "auto" ? "selected" : ""}>${T("GMW.Settings.ModelAuto", { model: esc(resolved) })}</option>`];
    for (const p of PROVIDER_ORDER) {
      const list = [...this.models[p]].sort();
      if (!list.length) continue;
      const title = p === "custom" ? (this.data?.custom?.name || providerTitle(p)) : providerTitle(p);
      opts.push(`<optgroup label="${esc(title)}">${list.map(m => `<option value="${esc(m)}" ${m === cur ? "selected" : ""}>${esc(m.replace(/^[a-z]+:/, ""))}</option>`).join("")}</optgroup>`);
    }
    return `
      <div class="gmw-field">
        <label>${T(ROLES[role].title)}</label>
        <select name="model-${role}">${opts.join("")}</select>
        <p class="hint">${T(ROLES[role].hint)}</p>
      </div>`;
  }

  /* ------------------------------------------------------------ кампания и источники */

  /** Что выбрать в списке систем: сохранённое название, иначе — по системе этого мира Foundry. */
  _systemChoice(saved) {
    const names = SYSTEMS.map(([n]) => n);
    if (saved && names.includes(saved)) return { sel: saved, other: "" };
    if (saved) return { sel: "other", other: saved };
    const id = game.system?.id ?? "";
    const guess = SYSTEMS.find(([, ids]) => ids.includes(id))?.[0];
    return guess ? { sel: guess, other: "" } : { sel: "other", other: game.system?.title ?? "" };
  }

  _campaignHTML() {
    const c = this.data?.campaign ?? {};
    const sys = `${game.system?.title ?? game.system?.id ?? ""}${game.system?.version ? " " + game.system.version : ""}`;
    const ch = this._systemChoice(c.system);
    const sysOpts = [...SYSTEMS.map(([n]) => `<option value="${esc(n)}" ${ch.sel === n ? "selected" : ""}>${esc(n)}</option>`), `<option value="other" ${ch.sel === "other" ? "selected" : ""}>${T("GMW.Settings.SystemOther")}</option>`].join("");
    return `
      <div class="gmw-grid gmw-two">
        <div class="gmw-field"><label>${T("GMW.Settings.CampName")}</label><input type="text" name="camp_name" value="${esc(c.name ?? "")}" placeholder="Dungeons of Drakkenheim"><p class="hint">${T("GMW.Settings.CampNameHint")}</p></div>
        <div class="gmw-field"><label>${T("GMW.Settings.CampSystem")}</label>
          <select name="camp_system_sel">${sysOpts}</select>
          <input type="text" name="camp_system" value="${esc(ch.other)}" placeholder="${esc(T("GMW.Settings.CampSystemPlaceholder"))}" ${ch.sel === "other" ? "" : "hidden"}>
          <p class="hint">${T("GMW.Settings.CampSystemHint", { system: esc(sys || "—") })}</p></div>
      </div>
      <div class="gmw-field"><label>${T("GMW.Settings.CampDesc")}</label><textarea name="camp_description" rows="3" placeholder="${esc(T("GMW.Settings.CampDescPlaceholder"))}">${esc(c.description ?? "")}</textarea><p class="hint">${T("GMW.Settings.CampDescHint")}</p></div>
      <div class="gmw-grid gmw-two">
        <div class="gmw-field"><label>${T("GMW.Settings.CampTone")}</label><textarea name="camp_tone" rows="3" placeholder="${esc(T("GMW.Settings.CampTonePlaceholder"))}">${esc(c.tone ?? "")}</textarea><p class="hint">${T("GMW.Settings.CampToneHint")}</p></div>
        <div class="gmw-field"><label>${T("GMW.Settings.CampRules")}</label><textarea name="camp_rules" rows="3" placeholder="${esc(T("GMW.Settings.CampRulesPlaceholder"))}">${esc(c.special_rules ?? "")}</textarea><p class="hint">${T("GMW.Settings.CampRulesHint")}</p></div>
      </div>
      <div class="gmw-grid gmw-two">
        <div class="gmw-field"><label>${T("GMW.Settings.CampLang")}</label><select name="camp_lang">${LANGS.map(([v, t]) => `<option value="${v}" ${v === (c.lang || "auto") ? "selected" : ""}>${T(t)}</option>`).join("")}</select><p class="hint">${T("GMW.Settings.CampLangHint")}</p></div>
        <div class="gmw-field"><label>${T("GMW.Settings.CampLength")}</label><select name="camp_length">${[["short", "GMW.Settings.LengthShort"], ["normal", "GMW.Settings.LengthNormal"], ["long", "GMW.Settings.LengthLong"]].map(([v, t]) => `<option value="${v}" ${v === (c.answer_length || "normal") ? "selected" : ""}>${T(t)}</option>`).join("")}</select><p class="hint">${T("GMW.Settings.CampLengthHint")}</p></div>
      </div>
      <label class="gmw-check"><input type="checkbox" name="camp_lines_only" ${c.lines_only === "1" ? "checked" : ""}> ${T("GMW.Settings.CampLinesOnly")}</label>
      <label class="gmw-check"><input type="checkbox" name="camp_no_improv" ${c.no_improv === "1" ? "checked" : ""}> ${T("GMW.Settings.CampNoImprov")}</label>
      <label class="gmw-check"><input type="checkbox" name="camp_player_names" ${c.player_names === "1" ? "checked" : ""}> ${T("GMW.Settings.CampPlayerNames")}</label>`;
  }

  _bibleHTML() {
    const entry = bibleEntry();
    const built = entry?.flags?.[MODULE_ID]?.bible?.builtAt;
    const guess = guessQuentaFolder();
    const cur = this._field("bible_folder")?.value ?? guess?.id ?? "";
    const opts = [`<option value="" ${cur ? "" : "selected"}>${esc(T("GMW.Settings.BibleNoQuentas"))}</option>`, ...quentaFolders().map(f => `<option value="${esc(f.id)}" ${f.id === cur ? "selected" : ""}>${esc(f.name)}</option>`)].join("");
    const state = entry
      ? `<span class="gmw-ok">${T("GMW.Settings.BibleExists")}</span>${built ? `, ${T("GMW.Settings.BibleBuilt", { date: new Date(built).toLocaleDateString(game.i18n.lang) })}` : ""}. ${T("GMW.Settings.BibleExistsNote")}`
      : `<span class="gmw-muted">${T("GMW.Settings.BibleMissing")}</span>. ${T("GMW.Settings.BibleMissingNote")}`;
    return `
      <p class="hint">${T("GMW.Settings.BibleIntro", { name: esc(bibleEntryName()) })}</p>
      <p class="hint">${T("GMW.Settings.BibleState", { state })}</p>
      <div class="gmw-grid gmw-two">
        <div class="gmw-field"><label>${T("GMW.Settings.BibleFolder")}</label><select name="bible_folder">${opts}</select><p class="hint">${T("GMW.Settings.BibleFolderHint")}</p></div>
        <div class="gmw-field"><label>&nbsp;</label><div class="gmw-inline">
          ${entry ? `<button type="button" data-action="openBible"><i class="fas fa-book-open"></i> ${T("GMW.Common.Open")}</button>` : ""}
          <button type="button" data-action="buildBible" ${this.bibleBusy ? "disabled" : ""}><i class="fas fa-book"></i> ${entry ? T("GMW.Settings.BibleRebuild") : T("GMW.Bible.Go")}</button>
        </div>${entry ? `<p class="hint">${T("GMW.Settings.BibleRebuildHint")}</p>` : ""}</div>
      </div>`;
  }

  _folderTree() {
    const all = game.folders.filter(f => f.type === "JournalEntry");
    const rows = [];
    const walk = (parent, depth) => {
      for (const f of all.filter(x => (x.folder?.id ?? null) === parent).sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang))) {
        rows.push({ id: f.id, name: f.name, depth, folder: f });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return rows;
  }

  /** Вид, который правила sources.json дали бы журналам этой папки (большинство). Для подсказки «авто → …». */
  _suggestKind(folder) {
    const rules = (this.data?.source_rules ?? []).map(r => { try { return { rx: new RegExp(r.match), kind: r.kind }; } catch (_) { return null; } }).filter(Boolean);
    const path = (f) => { const p = []; for (let x = f; x; x = x.folder) p.unshift(x.name); return p.join(" / "); };
    const entries = folder ? game.journal.filter(j => j.folder?.id === folder.id) : game.journal.filter(j => !j.folder);
    const counts = {};
    for (const j of entries) {
      const key = folder ? `${path(folder)} / ${j.name}` : j.name;
      const hit = rules.find(r => r.rx.test(key));
      const k = hit?.kind ?? "other";
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return { kind: best?.[0] ?? "other", n: entries.length };
  }

  _sourcesHTML() {
    if (!this.sources) {
      const saved = game.settings.get(MODULE_ID, "kbSources") || {};
      this.sources = { ...saved };
      // Первое открытие: подставляем то, что сейчас дают правила, — мастер видит и правит, а не угадывает.
      if (!Object.keys(saved).length) {
        for (const r of this._folderTree()) { const s = this._suggestKind(r.folder); this.sources[r.id] = s.n ? s.kind : "auto"; } // пустые папки наследуют
        this.sources[""] = this._suggestKind(null).kind;
      }
    }
    const kindOpts = (cur) => KINDS_ORDER.map(k => `<option value="${k}" ${k === cur ? "selected" : ""}>${kindLabel(k)}</option>`).join("");
    const rows = this._folderTree().map(r => {
      const cur = this.sources[r.id] ?? "auto";
      const s = this._suggestKind(r.folder);
      return `<tr><td style="padding-left:${r.depth * 18}px"><i class="fas fa-folder"></i> ${esc(r.name)} <span class="gmw-muted">· ${s.n}</span></td>
        <td><select name="src-${esc(r.id)}">${kindOpts(cur)}</select></td>
        <td class="gmw-muted">${cur === "auto" ? `→ ${kindLabel(s.kind)}` : esc(kindHint(cur))}</td></tr>`;
    });
    const rootS = this._suggestKind(null);
    const rootCur = this.sources[""] ?? "auto";
    rows.push(`<tr><td><i class="fas fa-book"></i> ${T("GMW.Settings.RootJournals")} <span class="gmw-muted">· ${rootS.n}</span></td>
      <td><select name="src-root">${kindOpts(rootCur)}</select></td>
      <td class="gmw-muted">${rootCur === "auto" ? `→ ${kindLabel(rootS.kind)}` : esc(kindHint(rootCur))}</td></tr>`);
    const packs = game.packs.filter(p => p.documentName === "JournalEntry");
    const saved = String(game.settings.get(MODULE_ID, "kbPacks") || "");
    const chosen = new Set(saved.split(/[,;\s]+/).filter(Boolean));
    // Похоже на книгу правил: по названию или id. Если мастер ещё ничего не выбирал — такие отмечаем сразу.
    const RULES_RX = /\b(phb|dmg|mm|srd|core ?rules?|rulebook|player'?s? ?handbook|monster ?manual|dungeon ?master|bestiary|gm ?guide|game ?master)\b|правил|книга игрока|руководство мастера|энциклопедия чудовищ|бестиарий|справочник/i;
    const looksRules = (p) => RULES_RX.test(`${p.metadata.label} ${p.collection}`);
    const packRows = packs.length
      ? packs.map(p => `<label class="gmw-check gmw-pack"><input type="checkbox" name="pack-${esc(p.collection)}" ${chosen.has(p.collection) || (!saved && looksRules(p)) ? "checked" : ""}> ${esc(p.metadata.label)} <span class="gmw-muted">· ${esc(p.collection)}${looksRules(p) ? ` · ${T("GMW.Settings.LooksRules")}` : ""}</span></label>`).join("")
      : `<p class="hint">${T("GMW.Settings.NoPacks")}</p>`;
    return `
      <p class="hint">${T("GMW.Settings.SourcesIntro")}</p>
      <table class="gmw-table gmw-sources"><thead><tr><th>${T("GMW.Settings.ColFolder")}</th><th>${T("GMW.Settings.ColKind")}</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>
      <p class="hint"><b>${T("GMW.Settings.PacksTitle")}</b> ${T("GMW.Settings.PacksIntro")}</p>
      <div class="gmw-packs">${packRows}</div>`;
  }

  _speakersRows() {
    if (!this.speakers.length) return `<p class="hint">${T("GMW.Settings.SpeakersEmpty")}</p>`;
    return `<table class="gmw-table"><thead><tr><th>${T("GMW.Settings.ColNick")}</th><th>${T("GMW.Settings.ColName")}</th><th></th></tr></thead><tbody>
      ${this.speakers.map((s, i) => `<tr>
        <td><input type="text" name="spk-key-${i}" value="${esc(s.key)}" placeholder="${esc(T("GMW.Settings.NickPlaceholder"))}"></td>
        <td><input type="text" name="spk-name-${i}" value="${esc(s.name)}" placeholder="${esc(T("GMW.Settings.NamePlaceholder"))}" ${s.key === s.name ? 'class="gmw-unmapped"' : ""}></td>
        <td><a data-action="removeSpeaker" data-index="${i}" data-tooltip-text="${esc(T("GMW.Settings.RemoveRow"))}"><i class="fas fa-xmark"></i></a></td>
      </tr>`).join("")}
    </tbody></table>`;
  }

  /** Какой провайдер показан в блоке «Ключ API»: выбранный мастером, иначе первый с заданным ключом, иначе Claude. */
  _keyProvider() {
    if (this.keyProvider && PROVIDERS[this.keyProvider]) return this.keyProvider;
    return PROVIDER_ORDER.find(p => this.data?.keys?.[p]?.set) ?? "anthropic";
  }

  _keysHTML(d) {
    const cur = this._keyProvider();
    const setCount = PROVIDER_ORDER.filter(p => d.keys?.[p]?.set).length;
    const opts = PROVIDER_ORDER.map(p => {
      const title = p === "custom" ? (d.custom?.name ? `${providerTitle(p)}: ${d.custom.name}` : providerTitle(p)) : providerTitle(p);
      return `<option value="${p}" ${p === cur ? "selected" : ""}>${esc(title)}${d.keys?.[p]?.set ? " ✓" : ""}</option>`;
    }).join("");
    return `
      <fieldset>
        <legend><i class="fas fa-key"></i> ${T("GMW.Settings.ApiKey")}</legend>
        <p class="hint">${T("GMW.Settings.KeysIntro")}${setCount > 1 ? ` ${T("GMW.Settings.KeysMany", { n: setCount })}` : ""}</p>
        <div class="gmw-field"><label>${T("GMW.Settings.Service")}</label><select name="key_provider">${opts}</select></div>
        ${PROVIDER_ORDER.map(p => `<div class="gmw-key-row" data-provider="${p}" ${p === cur ? "" : "hidden"}>${this._keyRow(p)}</div>`).join("")}
      </fieldset>`;
  }

  _advancedConnectHTML(d) {
    return `
      <details class="gmw-adv">
        <summary><i class="fas fa-sliders"></i> ${T("GMW.Settings.AdvancedTitle")}</summary>
        <p class="hint">${T("GMW.Settings.AdvancedIntro")}</p>
        <div class="gmw-grid gmw-three">${["lore", "tactics", "fast"].map(r => this._modelSelect(r)).join("")}</div>
        <div class="gmw-grid gmw-two">
          <div class="gmw-field"><label>${T("GMW.Settings.ServerUrl")}</label><input type="text" name="serverUrl" value="${esc(game.settings.get(MODULE_ID, "serverUrl"))}" placeholder="http://127.0.0.1:8765"><p class="hint">${T("GMW.Settings.ServerUrlHint")}</p></div>
          <div class="gmw-field"><label>${T("GMW.Settings.Origins")}</label><input type="text" name="allowed_origins" value="${esc(d.allowed_origins ?? "")}" placeholder="${esc(T("GMW.Settings.OriginsPlaceholder"))}"><p class="hint">${T("GMW.Settings.OriginsHint")}</p></div>
        </div>
      </details>`;
  }

  async _renderHTML() {
    const root = document.createElement("div");
    root.className = "gmw-settings-root";
    if (!this.data && !this.error) {
      root.innerHTML = `<p class="gmw-pending"><i class="fas fa-spinner fa-spin"></i> ${T("GMW.Settings.Loading")}</p>`;
      return root;
    }
    const d = this.data ?? {};
    const connection = `
      <fieldset>
        <legend><i class="fas fa-plug"></i> ${T("GMW.Settings.ServerLegend")}</legend>
        <p class="hint">${T("GMW.Settings.ServerIntro", { cmd: "<code>server\\start.bat</code>" })}</p>
        <div class="gmw-field"><label>${T("GMW.Settings.TokenLabel")}</label>
          <div class="gmw-inline">
            <input type="password" name="token" autocomplete="off" value="${esc(game.settings.get(MODULE_ID, "token"))}" placeholder="${esc(T("GMW.Settings.TokenPlaceholder"))}">
            <button type="button" data-action="testServer"><i class="fas fa-satellite-dish"></i> ${T("GMW.Settings.TestServer")}</button>
          </div>
          <p class="hint"><span class="gmw-test-result">${esc(this.testResult ?? "")}</span></p>
        </div>
        ${this.error ? `<p class="gmw-error"><i class="fas fa-triangle-exclamation"></i> ${esc(this.error)} <a data-action="reload">${T("GMW.Settings.Retry")}</a></p>` : ""}
      </fieldset>`;
    if (!this.data) {
      root.innerHTML = connection;
      return root;
    }
    const TABS = [
      ["connect", "fa-plug", T("GMW.Settings.TabConnect")],
      ["campaign", "fa-dragon", T("GMW.Settings.TabCampaign")],
      ["voice", "fa-microphone", T("GMW.Settings.TabVoice")],
    ];
    const noKey = !Object.values(d.keys ?? {}).some(k => k.set);
    const badge = (id) => (id === "connect" && noKey) ? `<span class="gmw-badge" title="${esc(T("GMW.Settings.NoKeyBadge"))}">!</span>` : "";
    const nav = `<nav class="gmw-tabs">${TABS.map(([id, icon, title]) => `<a data-action="switchTab" data-tab="${id}" class="${this.tab === id ? "active" : ""}"><i class="fas ${icon}"></i> ${title}${badge(id)}</a>`).join("")}</nav>`;
    const section = (id, html) => `<section class="gmw-tab ${this.tab === id ? "active" : ""}" data-tab="${id}">${html}</section>`;
    root.innerHTML = `
      ${nav}
      ${section("connect", `
      ${connection}
      ${this._keysHTML(d)}
      ${this._advancedConnectHTML(d)}`)}
      ${section("campaign", `
      <fieldset>
        <legend><i class="fas fa-dragon"></i> ${T("GMW.Settings.CampaignLegend")}</legend>
        <p class="hint">${T("GMW.Settings.CampaignIntro")}</p>
        ${this._campaignHTML()}
      </fieldset>
      <fieldset>
        <legend><i class="fas fa-book-open"></i> ${T("GMW.Settings.SourcesLegend")}</legend>
        ${this._sourcesHTML()}
      </fieldset>
      <fieldset>
        <legend><i class="fas fa-book"></i> ${T("GMW.Settings.BibleLegend")}</legend>
        ${this._bibleHTML()}
      </fieldset>`)}
      ${section("voice", `
      <fieldset>
        <legend><i class="fas fa-microphone"></i> ${T("GMW.Settings.VoiceLegend")}</legend>
        <p class="hint">${T("GMW.Settings.VoiceIntro")}</p>
        <div class="gmw-field">
          <label>${T("GMW.Settings.CraigFolder")} ${d.craig_inbox ? (d.craig_inbox_exists ? `<span class="gmw-ok">· ${T("GMW.Settings.CraigFound")}</span>` : `<span class="gmw-bad">· ${T("GMW.Settings.CraigNotFound")}</span>`) : ""}</label>
          <input type="text" name="craig_inbox" value="${esc(d.craig_inbox ?? "")}" placeholder="D:\\Google Drive\\Craig">
          <p class="hint">${T("GMW.Settings.CraigFolderHint")}</p>
        </div>
        <label class="gmw-check"><input type="checkbox" name="craig_auto" ${d.craig_auto ? "checked" : ""}> ${T("GMW.Settings.CraigAuto")}</label>
        <div class="gmw-grid gmw-two">
          <div class="gmw-field"><label>${T("GMW.Settings.SpeechLang")}</label>
            <select name="whisper_language">${(() => { const cur = d.whisper_language || "ru"; const opts = SPEECH_LANGS.some(([v]) => v === cur) ? SPEECH_LANGS.map(([v, k]) => [v, T(k)]) : [...SPEECH_LANGS.map(([v, k]) => [v, T(k)]), [cur, cur]]; return opts.map(([v, t]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${t}</option>`).join(""); })()}</select>
            <p class="hint">${T("GMW.Settings.SpeechLangHint")}</p></div>
        </div>
      </fieldset>
      <fieldset>
        <legend><i class="fas fa-users"></i> ${T("GMW.Settings.SpeakersLegend")}</legend>
        <p class="hint">${T("GMW.Settings.SpeakersIntro")}</p>
        ${this._speakersRows()}
        <button type="button" data-action="addSpeaker"><i class="fas fa-plus"></i> ${T("GMW.Settings.Add")}</button>
      </fieldset>
      <fieldset>
        <legend><i class="fas fa-ban"></i> ${T("GMW.Settings.IgnoreLegend")}</legend>
        <div class="gmw-grid gmw-two">
          <div class="gmw-field"><label>${T("GMW.Settings.IgnoreVoice")}</label><input type="text" name="ignore_voice" value="${esc((d.ignore?.voice ?? []).join(", "))}" placeholder="kenku, musicbot"><p class="hint">${T("GMW.Settings.IgnoreVoiceHint")}</p></div>
          <div class="gmw-field"><label>${T("GMW.Settings.IgnoreChat")}</label><input type="text" name="ignore_chat" value="${esc((d.ignore?.chat ?? []).join(", "))}" placeholder="${esc(T("GMW.Settings.IgnoreChatPlaceholder"))}"><p class="hint">${T("GMW.Settings.IgnoreChatHint")}</p></div>
        </div>
      </fieldset>
      <fieldset>
        <legend><i class="fas fa-box-archive"></i> ${T("GMW.Settings.StorageLegend")}</legend>
        <label class="gmw-check"><input type="checkbox" name="cleanup_on" ${Number(d.sessions_keep_days) > 0 ? "checked" : ""}> ${T("GMW.Settings.Cleanup")}</label>
        <div class="gmw-grid gmw-two">
          <div class="gmw-field"><label>${T("GMW.Settings.KeepDays")}</label><input type="number" name="sessions_keep_days" min="1" max="3650" value="${Number(d.sessions_keep_days) > 0 ? esc(d.sessions_keep_days) : 90}"><p class="hint">${T("GMW.Settings.KeepDaysHint")}</p></div>
        </div>
        <p class="hint">${T("GMW.Settings.TransferHint")}</p>
        <div class="gmw-inline">
          <button type="button" data-action="exportSettings"><i class="fas fa-file-export"></i> ${T("GMW.Settings.Export")}</button>
          <button type="button" data-action="importSettings"><i class="fas fa-file-import"></i> ${T("GMW.Settings.Import")}</button>
        </div>
      </fieldset>`)}
      <footer class="gmw-row">
        <button type="button" data-action="openSetup" data-tooltip="${esc(T("GMW.Settings.SetupWizardTooltip"))}"><i class="fas fa-hat-wizard"></i> ${T("GMW.Common.SetupWizard")}</button>
        <button type="button" data-action="rebuildKb" data-tooltip="${esc(T("GMW.Settings.RebuildKbTooltip"))}"><i class="fas fa-rotate"></i> ${T("GMW.Settings.RebuildKb")}</button>
        <span class="gmw-spacer"></span>
        <button type="button" data-action="reload" data-tooltip="${esc(T("GMW.Settings.CancelTooltip"))}"><i class="fas fa-rotate-left"></i> ${T("GMW.Settings.Cancel")}</button>
        <button type="button" class="gmw-send" data-action="save" ${this.saving ? "disabled" : ""}><i class="fas fa-floppy-disk"></i> ${T("GMW.Settings.Save")}</button>
      </footer>`;
    return root;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  _onFirstRender() {
    if (!this.data && !this.error) this.load();
  }

  _onRender() {
    this.element.querySelector('select[name="key_provider"]')?.addEventListener("change", (ev) => {
      this.keyProvider = ev.target.value;
      for (const row of this.element.querySelectorAll(".gmw-key-row")) row.hidden = row.dataset.provider !== this.keyProvider;
    });
    this.element.querySelector('select[name="camp_system_sel"]')?.addEventListener("change", (ev) => {
      const other = this.element.querySelector('input[name="camp_system"]');
      if (other) { other.hidden = ev.target.value !== "other"; if (!other.hidden) other.focus(); }
    });
    // Ввод в поле ключа снимает пометку «удалить».
    for (const p of Object.keys(PROVIDERS)) {
      this.element.querySelector(`input[name="key-${p}"]`)?.addEventListener("input", () => {
        if (this.clearKeys.delete(p)) this._rerender();
      });
    }
  }

  /* ------------------------------------------------------------ сбор формы */

  _field(name) {
    return this.element?.querySelector(`[name="${name}"]`);
  }

  _collectSpeakers() {
    const out = {};
    this.speakers.forEach((_s, i) => {
      const key = this._field(`spk-key-${i}`)?.value.trim();
      const name = this._field(`spk-name-${i}`)?.value.trim();
      if (key) out[key] = name || key;
    });
    return out;
  }

  _collectSources() {
    const out = {};
    for (const r of this._folderTree()) { const v = this._field(`src-${r.id}`)?.value; if (v && v !== "auto") out[r.id] = v; }
    const root = this._field("src-root")?.value; if (root && root !== "auto") out[""] = root;
    return out;
  }

  _collectPacks() {
    return game.packs.filter(p => p.documentName === "JournalEntry" && this._field(`pack-${p.collection}`)?.checked).map(p => p.collection).join(", ");
  }

  _syncSpeakersFromForm() {
    this.speakers = this.speakers.map((s, i) => ({
      key: this._field(`spk-key-${i}`)?.value ?? s.key,
      name: this._field(`spk-name-${i}`)?.value ?? s.name,
    }));
    if (this.element?.querySelector("[name=src-root]")) {
      const all = {};
      for (const r of this._folderTree()) all[r.id] = this._field(`src-${r.id}`)?.value ?? "auto";
      all[""] = this._field("src-root")?.value ?? "auto";
      this.sources = all;
    }
  }

  _payload() {
    const body = {
      model_lore: this._field("model-lore")?.value,
      model_tactics: this._field("model-tactics")?.value,
      model_fast: this._field("model-fast")?.value,
      openai_reasoning: this._field("openai_reasoning")?.value,
      openai_reasoning_fast: this._field("openai_reasoning_fast")?.value,
      craig_inbox: this._field("craig_inbox")?.value.trim() ?? "",
      craig_auto: !!this._field("craig_auto")?.checked,
      whisper_model: this._field("whisper_model")?.value.trim() || undefined, // в окне поля нет — значение в .env не трогаем
      whisper_language: this._field("whisper_language")?.value.trim().toLowerCase() || "ru",
      sessions_keep_days: this._field("cleanup_on")?.checked ? Math.max(1, Number(this._field("sessions_keep_days")?.value) || 90) : 0,
      allowed_origins: this._field("allowed_origins")?.value.trim() ?? "",
      custom_name: this._field("custom_name")?.value.trim() ?? "",
      custom_base_url: this._field("custom_base_url")?.value.trim() ?? "",
      custom_model: this._field("custom_model")?.value.trim() ?? "",
      speakers: this._collectSpeakers(),
      campaign: {
        name: this._field("camp_name")?.value.trim() ?? "",
        system: (this._field("camp_system_sel")?.value ?? "other") === "other" ? (this._field("camp_system")?.value.trim() ?? "") : this._field("camp_system_sel").value,
        description: this._field("camp_description")?.value.trim() ?? "",
        tone: this._field("camp_tone")?.value.trim() ?? "",
        special_rules: this._field("camp_rules")?.value.trim() ?? "",
        lang: this._field("camp_lang")?.value ?? "auto",
        answer_length: this._field("camp_length")?.value ?? "normal",
        lines_only: this._field("camp_lines_only")?.checked ? "1" : "0",
        no_improv: this._field("camp_no_improv")?.checked ? "1" : "0",
        player_names: this._field("camp_player_names")?.checked ? "1" : "0",
      },
      ignore: { voice: this._field("ignore_voice")?.value ?? "", chat: this._field("ignore_chat")?.value ?? "" },
    };
    for (const p of Object.keys(PROVIDERS)) {
      const typed = this._field(`key-${p}`)?.value.trim();
      if (typed) body[`${p}_api_key`] = typed;
      else if (this.clearKeys.has(p)) body[`${p}_api_key`] = "";
    }
    return body;
  }

  /* ------------------------------------------------------------ действия */

  static async #onTab(_event, target) {
    const id = target.dataset.tab;
    if (!id || id === this.tab) return;
    this.tab = id;
    // Переключение без перерисовки: все вкладки уже в DOM, прячем/показываем.
    for (const el of this.element.querySelectorAll(".gmw-tab")) el.classList.toggle("active", el.dataset.tab === id);
    for (const el of this.element.querySelectorAll(".gmw-tabs a")) el.classList.toggle("active", el.dataset.tab === id);
  }

  static async #onTestServer() {
    await game.settings.set(MODULE_ID, "serverUrl", this._field("serverUrl")?.value.trim() || "http://127.0.0.1:8765");
    await game.settings.set(MODULE_ID, "token", this._field("token")?.value.trim() || "");
    this.testResult = T("GMW.Settings.Checking");
    this.render();
    try {
      const h = await request("/health", { timeout: 8000 });
      this.testResult = `${T("GMW.Settings.TestOk", { version: h.version })}${h.kb?.pages ? `, ${T("GMW.Settings.TestOkPages", { n: h.kb.pages })}` : ""}`;
      if (!this.data) await this.load();
    } catch (err) {
      this.testResult = err.message;
    }
    this.render();
    foundry.applications.instances?.get?.("gm-whispers-panel")?.checkServer?.();
  }

  static async #onCheckKey(_event, target) {
    const provider = target.dataset.provider;
    const typed = this._field(`key-${provider}`)?.value.trim();
    if (!typed && !this.data?.keys?.[provider]?.set) {
      this.keyStatus[provider] = T("GMW.Settings.KeyFirst");
      return this.render();
    }
    this.keyStatus[provider] = T("GMW.Settings.Checking");
    this._syncSpeakersFromForm();
    const keep = this._payload(); // чтобы перерисовка не стёрла набранное
    await this.render();
    this._restore(keep, typed, provider);
    try {
      const baseUrl = provider === "custom" ? (this._field("custom_base_url")?.value.trim() || null) : null;
      if (provider === "custom" && !baseUrl) throw new Error(T("GMW.Settings.CustomUrlFirst"));
      const res = await request("/settings/models", { method: "POST", body: { provider, api_key: typed || null, base_url: baseUrl }, timeout: 45000 });
      this.models[provider] = res.models ?? [];
      for (const m of Object.values(res.defaults ?? {})) this._addModel(m);
      this.keyStatus[provider] = T("GMW.Settings.KeyAccepted", { n: res.models?.length ?? 0 });
    } catch (err) {
      this.keyStatus[provider] = err instanceof ServerError && err.status === 401 && /токен/i.test(err.message) ? err.message : T("GMW.Settings.KeyRejected", { reason: err.message });
    }
    await this.render();
    this._restore(keep, typed, provider);
  }

  /** Перерисовать окно, не потеряв набранное, но ещё не сохранённое. */
  async _rerender() {
    this._syncSpeakersFromForm();
    const keep = this._payload();
    const typed = Object.fromEntries(Object.keys(PROVIDERS).map(p => [p, this._field(`key-${p}`)?.value ?? ""]));
    await this.render();
    this._restore(keep);
    for (const [p, v] of Object.entries(typed)) { const f = this._field(`key-${p}`); if (f && v) f.value = v; }
  }

  /** Вернуть в форму набранные, но не сохранённые значения после перерисовки. */
  _restore(keep, typedKey, provider) {
    if (typedKey) { const f = this._field(`key-${provider}`); if (f) f.value = typedKey; }
    for (const [name, val] of [["craig_inbox", keep.craig_inbox], ["whisper_language", keep.whisper_language], ["allowed_origins", keep.allowed_origins], ["ignore_voice", keep.ignore?.voice], ["ignore_chat", keep.ignore?.chat], ["custom_name", keep.custom_name], ["custom_base_url", keep.custom_base_url], ["custom_model", keep.custom_model]]) {
      const f = this._field(name); if (f && typeof val === "string") f.value = val;
    }
    const auto = this._field("craig_auto"); if (auto && typeof keep.craig_auto === "boolean") auto.checked = keep.craig_auto;
    const ch = this._systemChoice(keep.campaign.system);
    { const sel = this._field("camp_system_sel"); if (sel) sel.value = ch.sel; const other = this._field("camp_system"); if (other) { other.value = ch.other; other.hidden = ch.sel !== "other"; } }
    for (const [name, val] of [["camp_name", keep.campaign.name], ["camp_description", keep.campaign.description], ["camp_tone", keep.campaign.tone], ["camp_rules", keep.campaign.special_rules], ["camp_lang", keep.campaign.lang], ["camp_length", keep.campaign.answer_length]]) {
      const f = this._field(name); if (f) f.value = val;
    }
    for (const [name, val] of [["camp_lines_only", keep.campaign.lines_only], ["camp_no_improv", keep.campaign.no_improv], ["camp_player_names", keep.campaign.player_names]]) {
      const f = this._field(name); if (f) f.checked = val === "1";
    }
    const cl = this._field("cleanup_on"); if (cl && keep.sessions_keep_days != null) cl.checked = keep.sessions_keep_days > 0;
    if (keep.sessions_keep_days > 0) { const f = this._field("sessions_keep_days"); if (f) f.value = keep.sessions_keep_days; }
    for (const r of ["lore", "tactics", "fast"]) { const f = this._field(`model-${r}`); if (f && keep[`model_${r}`]) f.value = keep[`model_${r}`]; }
  }

  static async #onClearKey(_event, target) {
    const p = target.dataset.provider;
    if (this.clearKeys.has(p)) this.clearKeys.delete(p); else this.clearKeys.add(p);
    await this._rerender();
  }

  static async #onAddSpeaker() {
    this._syncSpeakersFromForm();
    this.speakers.push({ key: "", name: "" });
    await this._rerender();
    this._field(`spk-key-${this.speakers.length - 1}`)?.focus();
  }

  static async #onRemoveSpeaker(_event, target) {
    this._syncSpeakersFromForm();
    this.speakers.splice(Number(target.dataset.index), 1);
    await this._rerender();
  }

  /** Экспорт: всё, кроме ключей и токена; плюс настройки модуля (компендиумы, журнал, автообновление). */
  static #onExport() {
    this._syncSpeakersFromForm();
    const body = this._payload();
    for (const p of PROVIDER_ORDER) delete body[`${p}_api_key`];
    const data = {
      gmWhispers: game.modules.get(MODULE_ID)?.version ?? "",
      exported: new Date().toISOString(),
      server: body,
      module: Object.fromEntries(["kbPacks", "kbSources", "serverUrl"].map(k => [k, game.settings.get(MODULE_ID, k)])),
    };
    const save = foundry.utils.saveDataToFile ?? globalThis.saveDataToFile;
    save(JSON.stringify(data, null, 2), "application/json", `gm-whispers-settings-${new Date().toISOString().slice(0, 10)}.json`);
  }

  static async #onImport() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      let data;
      try { data = JSON.parse(await file.text()); } catch (_) { return ui.notifications.error(T("GMW.Settings.ImportNotSettings")); }
      if (!data?.server) return ui.notifications.error(T("GMW.Settings.ImportNoServer"));
      try {
        for (const [k, v] of Object.entries(data.module ?? {})) {
          if (["kbPacks", "kbSources", "serverUrl"].includes(k)) await game.settings.set(MODULE_ID, k, v);
        }
        const body = { ...data.server };
        for (const p of PROVIDER_ORDER) delete body[`${p}_api_key`];
        const res = await request("/settings", { method: "POST", body, timeout: 20000 });
        this.data = res;
        this.speakers = Object.entries(res.speakers ?? {}).map(([key, name]) => ({ key, name }));
        ui.notifications.info(T("GMW.Settings.ImportDone"));
      } catch (err) {
        ui.notifications.error(T("GMW.Settings.ImportFailed", { reason: err.message }));
      }
      this.render();
    });
    input.click();
  }

  static async #onOpenSetup() { const { openSetupWizard } = await import("./setup.js"); this.close(); openSetupWizard(); }

  static #onOpenBible() { bibleEntry()?.sheet?.render({ force: true }); }

  static async #onBuildBible() {
    if (this.bibleBusy) return;
    const folderId = this._field("bible_folder")?.value ?? "";
    const panel = await openPanel();
    if (!panel) return;
    this.bibleBusy = true;
    await this._rerender();
    try {
      await buildBible(panel, { folderId, count: 4 });
    } finally {
      this.bibleBusy = false;
      await this._rerender();
    }
  }

  static #onRebuildKb() {
    const panel = foundry.applications.instances?.get?.("gm-whispers-panel");
    (panel ?? game.gmWhispers)?.refreshKb?.();
  }

  static async #onReload() {
    this.clearKeys.clear();
    this.keyStatus = Object.fromEntries(PROVIDER_ORDER.map(p => [p, ""]));
    await this.load();
  }

  static async #onSave() {
    if (this.saving) return;
    this.saving = true;
    const body = this._payload();
    try {
      await game.settings.set(MODULE_ID, "serverUrl", this._field("serverUrl")?.value.trim() || "http://127.0.0.1:8765");
      await game.settings.set(MODULE_ID, "token", this._field("token")?.value.trim() || "");
      const before = JSON.stringify([game.settings.get(MODULE_ID, "kbSources"), game.settings.get(MODULE_ID, "kbPacks")]);
      await game.settings.set(MODULE_ID, "kbSources", this._collectSources());
      await game.settings.set(MODULE_ID, "kbPacks", this._collectPacks());
      await game.settings.set(MODULE_ID, "bibleQuentaFolder", this._field("bible_folder")?.value ?? "");
      const sourcesChanged = before !== JSON.stringify([game.settings.get(MODULE_ID, "kbSources"), game.settings.get(MODULE_ID, "kbPacks")]);
      this.sources = null;
      const res = await request("/settings", { method: "POST", body, timeout: 20000 });
      this.data = res;
      this.clearKeys.clear();
      this.speakers = Object.entries(res.speakers ?? {}).map(([key, name]) => ({ key, name }));
      ui.notifications.info(sourcesChanged ? T("GMW.Settings.SavedRebuild") : T("GMW.Settings.Saved"));
      const panel = foundry.applications.instances?.get?.("gm-whispers-panel");
      panel?.checkServer?.();
      if (sourcesChanged) (panel ?? game.gmWhispers)?.refreshKb?.();
    } catch (err) {
      ui.notifications.error(T("GMW.Settings.SaveFailed", { reason: err.message }));
    } finally {
      this.saving = false;
      this.render();
    }
  }
}

export function openServerSettings() {
  if (!game.user.isGM) return ui.notifications.warn(T("GMW.Common.GmOnly"));
  const open = foundry.applications.instances?.get?.("gm-whispers-settings");
  if (open) return open.bringToFront?.() ?? open.render({ force: true });
  return new ServerSettingsApp().render({ force: true });
}
