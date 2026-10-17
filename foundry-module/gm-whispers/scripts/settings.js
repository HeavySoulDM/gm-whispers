/**
 * Окно «Настройки сервера GM Whispers»: ключи API и модели, папка записей Craig,
 * словарь «кто есть кто» и исключения — всё, что раньше правилось в server/.env и config/*.json.
 *
 * Ключи уходят только на локальный сервер (127.0.0.1) и хранятся в server/.env; обратно
 * сервер отдаёт лишь «задан / не задан» и последние 4 символа.
 */

import { MODULE_ID, ServerError, request, serverUrl } from "./api.js";
import { esc } from "./md.js";

const { ApplicationV2 } = foundry.applications.api;

const PROVIDERS = {
  anthropic: { title: "Claude (Anthropic)", where: "console.anthropic.com → API keys", prefix: "sk-ant-" },
  openai: { title: "OpenAI", where: "platform.openai.com → API keys", prefix: "sk-" },
  gemini: { title: "Gemini (Google)", where: "aistudio.google.com → Get API key", prefix: "AIza" },
  deepseek: { title: "DeepSeek", where: "platform.deepseek.com → API keys", prefix: "sk-" },
  openrouter: { title: "OpenRouter", where: "openrouter.ai → Keys; даёт доступ к сотням моделей через один ключ", prefix: "sk-or-" },
  custom: { title: "Свой провайдер", where: "любой сервис с API, совместимым с OpenAI (RouterAI, локальные серверы и т. п.)", prefix: "" },
};
const PROVIDER_ORDER = ["anthropic", "openai", "gemini", "deepseek", "openrouter", "custom"];
const KINDS_ORDER = ["auto", "gm", "diary", "adventure", "setting", "rules", "other", "exclude"];
const ROLES = {
  lore: { title: "Лор и итоги", hint: "Вопросы о приключении, НПС, итоги сессии. Самая сильная модель." },
  tactics: { title: "Тактика", hint: "Ход монстра в бою с учётом карты." },
  fast: { title: "Быстрые реплики", hint: "Режим «быстро», реплики НПС. Дешёвая и быстрая модель." },
};
const KIND_LABELS = {
  auto: "авто (по правилам)", gm: "материалы мастера", diary: "дневник кампании", adventure: "книга приключения",
  setting: "справочник мира", rules: "правила системы", other: "прочее", exclude: "не включать",
};
const KIND_HINTS = {
  gm: "шпаргалки, база NPC, квенты — самый высокий приоритет при расхождениях",
  diary: "итоги сессий — что реально произошло",
  adventure: "текст приключения",
  setting: "мир, фракции, лор",
  rules: "книги правил системы",
  other: "обычный вес",
  exclude: "в базу не попадает",
};
const LANGS = [["auto", "как в Foundry"], ["ru", "русский"], ["en", "English"], ["uk", "українська"], ["de", "Deutsch"], ["fr", "français"], ["es", "español"], ["pl", "polski"]];

const REASONING = [["", "по умолчанию модели"], ["none", "без размышлений (только gpt-6-luna)"], ["low", "немного"], ["medium", "средне"], ["high", "глубоко"]];

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
    window: { title: "GM Whispers — настройки сервера", icon: "fas fa-sliders", resizable: true },
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
      tab: ServerSettingsApp.#onTab,
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
        <div class="gmw-field"><label>Название (для списков)</label><input type="text" name="custom_name" value="${esc(c.name ?? "")}" placeholder="RouterAI"><p class="hint">Как подписывать этого провайдера в окне.</p></div>
        <div class="gmw-field"><label>Адрес API (base URL)</label><input type="text" name="custom_base_url" value="${esc(c.base_url ?? "")}" placeholder="https://api.example.com/v1"><p class="hint">Из документации сервиса: обычно заканчивается на /v1. Без завершающего «/».</p></div>
        <div class="gmw-field"><label>Модель по умолчанию</label><input type="text" name="custom_model" value="${esc(c.model ?? "")}" placeholder="имя модели у провайдера"><p class="hint">Подставляется при «авто», если задан только этот ключ. После «Проверить» можно выбрать из списка.</p></div>
      </div>`;
  }

  _keyRow(provider) {
    const info = PROVIDERS[provider];
    const k = this.data?.keys?.[provider] ?? { set: false, hint: "" };
    const cleared = this.clearKeys.has(provider);
    const state = cleared ? "будет удалён" : k.set ? `задан ${esc(k.hint)}` : "не задан";
    const cls = cleared ? "gmw-bad" : k.set ? "gmw-ok" : "gmw-muted";
    return `
      <div class="gmw-field">
        <label>${info.title} <span class="gmw-key-state ${cls}">· ${state}</span></label>
        <div class="gmw-inline">
          <input type="password" name="key-${provider}" autocomplete="off" spellcheck="false"
                 placeholder="${k.set ? "оставить как есть или вставить новый" : `вставь ключ (${info.prefix}…)`}">
          <button type="button" data-action="checkKey" data-provider="${provider}" data-tooltip="Запросить у провайдера список моделей — заодно проверяется ключ"><i class="fas fa-plug-circle-check"></i> Проверить</button>
          ${k.set ? `<button type="button" data-action="clearKey" data-provider="${provider}" data-tooltip="Удалить ключ из server/.env при сохранении"><i class="fas fa-trash"></i></button>` : ""}
        </div>
        <p class="hint">Где взять: ${info.where}. ${this.keyStatus[provider] ? `<span class="gmw-key-result">${esc(this.keyStatus[provider])}</span>` : ""}</p>
        ${provider === "custom" ? this._customRow() : ""}
      </div>`;
  }

  _modelSelect(role) {
    const cur = this.data?.models?.[role] ?? "auto";
    const resolved = this.data?.resolved?.[role] ?? "";
    const opts = [`<option value="auto" ${cur === "auto" ? "selected" : ""}>авто — сейчас ${esc(resolved)}</option>`];
    for (const p of PROVIDER_ORDER) {
      const list = [...this.models[p]].sort();
      if (!list.length) continue;
      const title = p === "custom" ? (this.data?.custom?.name || PROVIDERS.custom.title) : PROVIDERS[p].title;
      opts.push(`<optgroup label="${esc(title)}">${list.map(m => `<option value="${esc(m)}" ${m === cur ? "selected" : ""}>${esc(m.replace(/^[a-z]+:/, ""))}</option>`).join("")}</optgroup>`);
    }
    return `
      <div class="gmw-field">
        <label>${ROLES[role].title}</label>
        <select name="model-${role}">${opts.join("")}</select>
        <p class="hint">${ROLES[role].hint}</p>
      </div>`;
  }

  _reasoningSelect(name, value, label, hint) {
    return `
      <div class="gmw-field">
        <label>${label}</label>
        <select name="${name}">${REASONING.map(([v, t]) => `<option value="${v}" ${v === (value ?? "") ? "selected" : ""}>${t}</option>`).join("")}</select>
        <p class="hint">${hint}</p>
      </div>`;
  }

  /* ------------------------------------------------------------ кампания и источники */

  _campaignHTML() {
    const c = this.data?.campaign ?? {};
    const sys = `${game.system?.title ?? game.system?.id ?? ""}${game.system?.version ? " " + game.system.version : ""}`;
    return `
      <div class="gmw-grid gmw-two">
        <div class="gmw-field"><label>Название кампании</label><input type="text" name="camp_name" value="${esc(c.name ?? "")}" placeholder="Dungeons of Drakkenheim"><p class="hint">Как называть кампанию в ответах и дневнике.</p></div>
        <div class="gmw-field"><label>Игровая система</label><input type="text" name="camp_system" value="${esc(c.system ?? "")}" placeholder="${esc(sys)}"><p class="hint">В этом мире Foundry: ${esc(sys || "—")}. Можно уточнить редакцию: «D&D 5e (правила 2024)».</p></div>
      </div>
      <div class="gmw-field"><label>О мире и сюжете</label><textarea name="camp_description" rows="3" placeholder="2–5 предложений: где, когда, кто за что борется, кто партия.">${esc(c.description ?? "")}</textarea><p class="hint">Попадает в каждый запрос к модели — без этого она отвечает «по книге вообще», а не про вашу игру.</p></div>
      <div class="gmw-grid gmw-two">
        <div class="gmw-field"><label>Тон и стиль ответов</label><textarea name="camp_tone" rows="3" placeholder="Мрачно по миру, живо за столом; NPC говорят как живые люди; коротко.">${esc(c.tone ?? "")}</textarea><p class="hint">Как модель должна говорить с мастером и за NPC.</p></div>
        <div class="gmw-field"><label>Особые и домашние правила</label><textarea name="camp_rules" rows="3" placeholder="Что важнее общих правил системы; варианты написания имён; что не использовать.">${esc(c.special_rules ?? "")}</textarea><p class="hint">Модель ставит их выше книг правил.</p></div>
      </div>
      <div class="gmw-grid gmw-two">
        <div class="gmw-field"><label>Язык ответов</label><select name="camp_lang">${LANGS.map(([v, t]) => `<option value="${v}" ${v === (c.lang || "auto") ? "selected" : ""}>${t}</option>`).join("")}</select><p class="hint">«Как в Foundry» — язык интерфейса мастера.</p></div>
        <div class="gmw-field"><label>Длина ответов</label><select name="camp_length">${[["short", "коротко — 1–3 предложения"], ["normal", "обычно — суть и немного деталей"], ["long", "подробно — с вариантами и нюансами"]].map(([v, t]) => `<option value="${v}" ${v === (c.answer_length || "normal") ? "selected" : ""}>${t}</option>`).join("")}</select><p class="hint">Для вопросов в панели. Итоги и «К игре» всегда полные.</p></div>
      </div>
      <label class="gmw-check"><input type="checkbox" name="camp_lines_only" ${c.lines_only === "1" ? "checked" : ""}> Реплики NPC — только сами реплики, без пояснений и советов</label>
      <label class="gmw-check"><input type="checkbox" name="camp_no_improv" ${c.no_improv === "1" ? "checked" : ""}> Не предлагать импровизацию, если в материалах ответа нет (только сказать, что нет)</label>
      <label class="gmw-check"><input type="checkbox" name="camp_player_names" ${c.player_names === "1" ? "checked" : ""}> Рядом с персонажем упоминать игрока: «Мира (Лера)»</label>`;
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
    const kindOpts = (cur) => KINDS_ORDER.map(k => `<option value="${k}" ${k === cur ? "selected" : ""}>${KIND_LABELS[k]}</option>`).join("");
    const rows = this._folderTree().map(r => {
      const cur = this.sources[r.id] ?? "auto";
      const s = this._suggestKind(r.folder);
      return `<tr><td style="padding-left:${r.depth * 18}px"><i class="fas fa-folder"></i> ${esc(r.name)} <span class="gmw-muted">· ${s.n}</span></td>
        <td><select name="src-${esc(r.id)}">${kindOpts(cur)}</select></td>
        <td class="gmw-muted">${cur === "auto" ? `→ ${KIND_LABELS[s.kind]}` : esc(KIND_HINTS[cur] ?? "")}</td></tr>`;
    });
    const rootS = this._suggestKind(null);
    const rootCur = this.sources[""] ?? "auto";
    rows.push(`<tr><td><i class="fas fa-book"></i> Журналы без папки <span class="gmw-muted">· ${rootS.n}</span></td>
      <td><select name="src-root">${kindOpts(rootCur)}</select></td>
      <td class="gmw-muted">${rootCur === "auto" ? `→ ${KIND_LABELS[rootS.kind]}` : esc(KIND_HINTS[rootCur] ?? "")}</td></tr>`);
    const packs = game.packs.filter(p => p.documentName === "JournalEntry");
    const saved = String(game.settings.get(MODULE_ID, "kbPacks") || "");
    const chosen = new Set(saved.split(/[,;\s]+/).filter(Boolean));
    // Похоже на книгу правил: по названию или id. Если мастер ещё ничего не выбирал — такие отмечаем сразу.
    const RULES_RX = /\b(phb|dmg|mm|srd|core ?rules?|rulebook|player'?s? ?handbook|monster ?manual|dungeon ?master|bestiary|gm ?guide|game ?master)\b|правил|книга игрока|руководство мастера|энциклопедия чудовищ|бестиарий|справочник/i;
    const looksRules = (p) => RULES_RX.test(`${p.metadata.label} ${p.collection}`);
    const packRows = packs.length
      ? packs.map(p => `<label class="gmw-check gmw-pack"><input type="checkbox" name="pack-${esc(p.collection)}" ${chosen.has(p.collection) || (!saved && looksRules(p)) ? "checked" : ""}> ${esc(p.metadata.label)} <span class="gmw-muted">· ${esc(p.collection)}${looksRules(p) ? " · похоже на правила" : ""}</span></label>`).join("")
      : `<p class="hint">В этом мире нет компендиумов с журналами.</p>`;
    return `
      <p class="hint">Вид папки задаёт приоритет при расхождениях (материалы мастера &gt; дневник &gt; приключение &gt; мир &gt; правила) и что не включать в базу. «Авто» — по правилам в server/config/sources.json (стрелка показывает, что они дают сейчас). Вложенные папки наследуют вид родителя, если свой не задан. После изменений нажми «База».</p>
      <table class="gmw-table gmw-sources"><thead><tr><th>Папка журналов</th><th>Вид</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>
      <p class="hint"><b>Компендиумы правил</b> — журналы из подключённых модулей (книги правил, переводы). Попадают в базу как «правила системы».</p>
      <div class="gmw-packs">${packRows}</div>`;
  }

  _speakersRows() {
    if (!this.speakers.length) return `<p class="hint">Пока пусто: имена участников появятся здесь после первой расшифровки записи Craig.</p>`;
    return `<table class="gmw-table"><thead><tr><th>Ник в записи Craig</th><th>Как подписывать в дневнике</th><th></th></tr></thead><tbody>
      ${this.speakers.map((s, i) => `<tr>
        <td><input type="text" name="spk-key-${i}" value="${esc(s.key)}" placeholder="ник в Discord"></td>
        <td><input type="text" name="spk-name-${i}" value="${esc(s.name)}" placeholder="Аня (Мира)" ${s.key === s.name ? 'class="gmw-unmapped"' : ""}></td>
        <td><a data-action="removeSpeaker" data-index="${i}" data-tooltip-text="Убрать строку"><i class="fas fa-xmark"></i></a></td>
      </tr>`).join("")}
    </tbody></table>`;
  }

  async _renderHTML() {
    const root = document.createElement("div");
    root.className = "gmw-settings-root";
    if (!this.data && !this.error) {
      root.innerHTML = `<p class="gmw-pending"><i class="fas fa-spinner fa-spin"></i> Читаю настройки сервера…</p>`;
      return root;
    }
    const d = this.data ?? {};
    const connection = `
      <fieldset>
        <legend><i class="fas fa-plug"></i> Связь с сервером</legend>
        <div class="gmw-grid gmw-two">
          <div class="gmw-field"><label>Адрес</label><input type="text" name="serverUrl" value="${esc(game.settings.get(MODULE_ID, "serverUrl"))}" placeholder="http://127.0.0.1:8765"><p class="hint">Обычно менять не нужно. Как в окне сервера: адрес и порт.</p></div>
          <div class="gmw-field"><label>Локальный токен</label><input type="password" name="token" autocomplete="off" value="${esc(game.settings.get(MODULE_ID, "token"))}" placeholder="строка из окна start.bat"><p class="hint">Печатает start.bat при запуске (GMW_LOCAL_TOKEN в server/.env). Хранится только в этом браузере.</p></div>
        </div>
        <p class="hint gmw-inline-hint"><button type="button" data-action="testServer"><i class="fas fa-satellite-dish"></i> Проверить связь</button> <span class="gmw-test-result">${esc(this.testResult ?? "")}</span></p>
        ${this.error ? `<p class="gmw-error"><i class="fas fa-triangle-exclamation"></i> ${esc(this.error)} <a data-action="reload">Повторить</a></p>` : ""}
      </fieldset>`;
    if (!this.data) {
      root.innerHTML = connection;
      return root;
    }
    const TABS = [
      ["connect", "fa-plug", "Подключение"],
      ["campaign", "fa-dragon", "Кампания"],
      ["sources", "fa-book-open", "Источники"],
      ["voice", "fa-microphone", "Голос"],
      ["storage", "fa-box-archive", "Хранение"],
    ];
    const noKey = !Object.values(d.keys ?? {}).some(k => k.set);
    const badge = (id) => (id === "connect" && noKey) ? `<span class="gmw-badge" title="Ключ API не задан">!</span>` : "";
    const nav = `<nav class="gmw-tabs">${TABS.map(([id, icon, title]) => `<a data-action="tab" data-tab="${id}" class="${this.tab === id ? "active" : ""}"><i class="fas ${icon}"></i> ${title}${badge(id)}</a>`).join("")}</nav>`;
    const section = (id, html) => `<section class="gmw-tab ${this.tab === id ? "active" : ""}" data-tab="${id}">${html}</section>`;
    root.innerHTML = `
      ${nav}
      <p class="hint gmw-legend-hint">Во всех полях: несколько значений — через запятую; пути к папкам — как в Проводнике; пустое поле = выключено. Кнопка «Сохранить» внизу сохраняет все вкладки сразу.</p>
      ${section("connect", `
      ${connection}
      <fieldset>
        <legend><i class="fas fa-key"></i> Ключи API</legend>
        <p class="hint">Достаточно одного ключа — модели подберутся сами («авто»; если задано несколько, порядок: Claude, OpenAI, Gemini, DeepSeek, OpenRouter, свой). Можно смешивать провайдеров по ролям. Ключ вставляй целиком, без пробелов. Хранятся в ${esc(d.env_path ?? "server/.env")} и никуда, кроме самого провайдера, не уходят.</p>
        ${PROVIDER_ORDER.map(p => this._keyRow(p)).join("")}
      </fieldset>
      <fieldset>
        <legend><i class="fas fa-brain"></i> Модели</legend>
        <p class="hint">Нажми «Проверить» у ключа — в списках появятся все модели, доступные этому ключу. Модель хранится как «провайдер:модель» (например openrouter:anthropic/claude-sonnet-4.5); для Claude и OpenAI префикс не нужен. Цена для моделей не из известного списка оценивается приблизительно (≈).</p>
        <div class="gmw-grid gmw-three">${["lore", "tactics", "fast"].map(r => this._modelSelect(r)).join("")}</div>
        <div class="gmw-grid gmw-two">
          ${this._reasoningSelect("openai_reasoning", d.openai_reasoning, "Размышления (OpenAI)", "Для лора и тактики. Глубже — умнее, дольше и дороже. На модели Claude не влияет.")}
          ${this._reasoningSelect("openai_reasoning_fast", d.openai_reasoning_fast, "Размышления в режиме «быстро»", "Для реплик и подсказок в бою.")}
        </div>
      </fieldset>`)}
      ${section("campaign", `
      <fieldset>
        <legend><i class="fas fa-dragon"></i> Кампания</legend>
        <p class="hint">Профиль кампании попадает во все запросы к модели. Заполни один раз — и модуль будет говорить про вашу игру, а не про абстрактное фэнтези.</p>
        ${this._campaignHTML()}
      </fieldset>`)}
      ${section("sources", `
      <fieldset>
        <legend><i class="fas fa-book-open"></i> Источники знаний</legend>
        ${this._sourcesHTML()}
      </fieldset>`)}
      ${section("voice", `
      <fieldset>
        <legend><i class="fas fa-microphone"></i> Запись голоса (Craig)</legend>
        <div class="gmw-field">
          <label>Папка, куда облако кладёт записи ${d.craig_inbox ? (d.craig_inbox_exists ? '<span class="gmw-ok">· найдена</span>' : '<span class="gmw-bad">· не найдена на этом компьютере</span>') : ""}</label>
          <input type="text" name="craig_inbox" value="${esc(d.craig_inbox ?? "")}" placeholder="D:\\Google Drive\\Craig">
          <p class="hint">Полный путь, как в Проводнике (можно скопировать из адресной строки). Пусто — записи забираются только вручную: перетащить zip на server\\transcribe.bat.</p>
        </div>
        <label class="gmw-check"><input type="checkbox" name="craig_auto" ${d.craig_auto ? "checked" : ""}> Следить за папкой самому (раз в минуту) и расшифровывать новые записи сразу. Выключено — по кнопке в «Итогах».</label>
        <div class="gmw-grid gmw-two">
          <div class="gmw-field"><label>Модель распознавания</label><input type="text" name="whisper_model" value="${esc(d.whisper_model ?? "large-v3-turbo")}" placeholder="large-v3-turbo"><p class="hint">Название модели faster-whisper: large-v3-turbo (по умолчанию), large-v3, medium. Скачивается один раз (~1,6 ГБ).</p></div>
          <div class="gmw-field"><label>Язык речи</label><input type="text" name="whisper_language" value="${esc(d.whisper_language ?? "ru")}" placeholder="ru"><p class="hint">Код из двух букв: ru, en, uk… Или auto — определить по записи (медленнее, чаще ошибается).</p></div>
        </div>
      </fieldset>
      <fieldset>
        <legend><i class="fas fa-users"></i> Кто есть кто в записи</legend>
        <p class="hint">Слева — ник участника, как он называется в файле дорожки Craig (появляется сам после первой расшифровки). Справа — как подписывать в дневнике: обычно имя и персонаж, например «Аня (Мира)». Подсвечены те, кому имя ещё не задано.</p>
        ${this._speakersRows()}
        <button type="button" data-action="addSpeaker"><i class="fas fa-plus"></i> Добавить</button>
      </fieldset>
      <fieldset>
        <legend><i class="fas fa-ban"></i> Не учитывать в итогах</legend>
        <div class="gmw-grid gmw-two">
          <div class="gmw-field"><label>Дорожки голоса (боты с музыкой)</label><input type="text" name="ignore_voice" value="${esc((d.ignore?.voice ?? []).join(", "))}" placeholder="kenku, musicbot"><p class="hint">Через запятую. Совпадение по части ника, регистр не важен: «kenku» отбросит дорожку «Kenku#1234».</p></div>
          <div class="gmw-field"><label>Авторы сообщений чата</label><input type="text" name="ignore_chat" value="${esc((d.ignore?.chat ?? []).join(", "))}" placeholder="Подсказки, Dice So Nice"><p class="hint">Через запятую. Имя автора, как оно показано в чате Foundry: служебные сообщения модулей, ботов.</p></div>
        </div>
      </fieldset>`)}
      ${section("storage", `
      <fieldset>
        <legend><i class="fas fa-box-archive"></i> Хранение и доступ</legend>
        <label class="gmw-check"><input type="checkbox" name="cleanup_on" ${Number(d.sessions_keep_days) > 0 ? "checked" : ""}> Старые сессии убирать в архив. Журнал событий и расшифровка упаковываются в data\\archive\\&lt;сессия&gt;.zip и пропадают из списка «Итогов»; дневник в Foundry не трогается.</label>
        <div class="gmw-grid gmw-two">
          <div class="gmw-field"><label>Через сколько дней</label><input type="number" name="sessions_keep_days" min="1" max="3650" value="${Number(d.sessions_keep_days) > 0 ? esc(d.sessions_keep_days) : 90}"><p class="hint">Целое число дней с конца сессии. Самая свежая сессия в архив не уходит.</p></div>
          <div class="gmw-field"><label>Доп. адреса Foundry (хостинг)</label><input type="text" name="allowed_origins" value="${esc(d.allowed_origins ?? "")}" placeholder="https://имя.forge-vtt.com"><p class="hint">Через запятую, с https:// и без завершающего «/». Нужно, только если Foundry открыт не с этого компьютера (localhost). Применяется после перезапуска сервера.</p></div>
        </div>
      </fieldset>
      <fieldset>
        <legend><i class="fas fa-file-export"></i> Перенос настроек</legend>
        <p class="hint">Файл без ключей API и токена: профиль, источники, Craig, исключения, настройки модуля. Для второго компьютера или на всякий случай.</p>
        <div class="gmw-inline">
          <button type="button" data-action="exportSettings"><i class="fas fa-file-export"></i> Экспорт в файл</button>
          <button type="button" data-action="importSettings"><i class="fas fa-file-import"></i> Импорт из файла</button>
        </div>
      </fieldset>`)}
      <footer class="gmw-row">
        <span class="hint">Сохраняются все вкладки сразу.</span>
        <button type="button" data-action="reload" data-tooltip="Перечитать настройки с сервера, отбросив несохранённое"><i class="fas fa-rotate"></i> Перечитать</button>
        <button type="button" class="gmw-send" data-action="save" ${this.saving ? "disabled" : ""}><i class="fas fa-floppy-disk"></i> Сохранить</button>
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
      openai_reasoning: this._field("openai_reasoning")?.value ?? "",
      openai_reasoning_fast: this._field("openai_reasoning_fast")?.value ?? "",
      craig_inbox: this._field("craig_inbox")?.value.trim() ?? "",
      craig_auto: !!this._field("craig_auto")?.checked,
      whisper_model: this._field("whisper_model")?.value.trim() || "large-v3-turbo",
      whisper_language: this._field("whisper_language")?.value.trim().toLowerCase() || "ru",
      sessions_keep_days: this._field("cleanup_on")?.checked ? Math.max(1, Number(this._field("sessions_keep_days")?.value) || 90) : 0,
      allowed_origins: this._field("allowed_origins")?.value.trim() ?? "",
      custom_name: this._field("custom_name")?.value.trim() ?? "",
      custom_base_url: this._field("custom_base_url")?.value.trim() ?? "",
      custom_model: this._field("custom_model")?.value.trim() ?? "",
      speakers: this._collectSpeakers(),
      campaign: {
        name: this._field("camp_name")?.value.trim() ?? "",
        system: this._field("camp_system")?.value.trim() ?? "",
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
    this.testResult = "проверяю…";
    this.render();
    try {
      const h = await request("/health", { timeout: 8000 });
      this.testResult = `сервер ${h.version} отвечает на ${serverUrl()}; база: ${h.kb?.chunks ?? 0} фрагментов`;
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
      this.keyStatus[provider] = "сначала вставь ключ";
      return this.render();
    }
    this.keyStatus[provider] = "проверяю…";
    this._syncSpeakersFromForm();
    const keep = this._payload(); // чтобы перерисовка не стёрла набранное
    await this.render();
    this._restore(keep, typed, provider);
    try {
      const baseUrl = provider === "custom" ? (this._field("custom_base_url")?.value.trim() || null) : null;
      if (provider === "custom" && !baseUrl) throw new Error("сначала впиши адрес API");
      const res = await request("/settings/models", { method: "POST", body: { provider, api_key: typed || null, base_url: baseUrl }, timeout: 45000 });
      this.models[provider] = res.models ?? [];
      for (const m of Object.values(res.defaults ?? {})) this._addModel(m);
      this.keyStatus[provider] = `ключ рабочий, моделей доступно: ${res.models?.length ?? 0}`;
    } catch (err) {
      this.keyStatus[provider] = err instanceof ServerError && err.status === 401 && /токен/i.test(err.message) ? err.message : `ключ не принят: ${err.message}`;
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
    for (const [name, val] of [["craig_inbox", keep.craig_inbox], ["whisper_model", keep.whisper_model], ["whisper_language", keep.whisper_language], ["allowed_origins", keep.allowed_origins], ["ignore_voice", keep.ignore.voice], ["ignore_chat", keep.ignore.chat], ["custom_name", keep.custom_name], ["custom_base_url", keep.custom_base_url], ["custom_model", keep.custom_model]]) {
      const f = this._field(name); if (f && typeof val === "string") f.value = val;
    }
    const auto = this._field("craig_auto"); if (auto) auto.checked = keep.craig_auto;
    for (const [name, val] of [["camp_name", keep.campaign.name], ["camp_system", keep.campaign.system], ["camp_description", keep.campaign.description], ["camp_tone", keep.campaign.tone], ["camp_rules", keep.campaign.special_rules], ["camp_lang", keep.campaign.lang], ["camp_length", keep.campaign.answer_length]]) {
      const f = this._field(name); if (f) f.value = val;
    }
    for (const [name, val] of [["camp_lines_only", keep.campaign.lines_only], ["camp_no_improv", keep.campaign.no_improv], ["camp_player_names", keep.campaign.player_names]]) {
      const f = this._field(name); if (f) f.checked = val === "1";
    }
    const cl = this._field("cleanup_on"); if (cl) cl.checked = keep.sessions_keep_days > 0;
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
      module: Object.fromEntries(["kbPacks", "kbSources", "logSession", "kbAutoSync", "serverUrl"].map(k => [k, game.settings.get(MODULE_ID, k)])),
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
      try { data = JSON.parse(await file.text()); } catch (_) { return ui.notifications.error("GM Whispers: это не файл настроек."); }
      if (!data?.server) return ui.notifications.error("GM Whispers: в файле нет настроек сервера.");
      try {
        for (const [k, v] of Object.entries(data.module ?? {})) {
          if (["kbPacks", "kbSources", "logSession", "kbAutoSync", "serverUrl"].includes(k)) await game.settings.set(MODULE_ID, k, v);
        }
        const body = { ...data.server };
        for (const p of PROVIDER_ORDER) delete body[`${p}_api_key`];
        const res = await request("/settings", { method: "POST", body, timeout: 20000 });
        this.data = res;
        this.speakers = Object.entries(res.speakers ?? {}).map(([key, name]) => ({ key, name }));
        ui.notifications.info("GM Whispers: настройки загружены из файла (ключи API впиши отдельно).");
      } catch (err) {
        ui.notifications.error(`GM Whispers: импорт не удался — ${err.message}`);
      }
      this.render();
    });
    input.click();
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
      await game.settings.set(MODULE_ID, "kbSources", this._collectSources());
      await game.settings.set(MODULE_ID, "kbPacks", this._collectPacks());
      this.sources = null;
      const res = await request("/settings", { method: "POST", body, timeout: 20000 });
      this.data = res;
      this.clearKeys.clear();
      this.speakers = Object.entries(res.speakers ?? {}).map(([key, name]) => ({ key, name }));
      const r = res.resolved ?? {};
      ui.notifications.info(`GM Whispers: настройки сохранены. Модели: ${r.lore} / ${r.tactics} / ${r.fast}.`);
      foundry.applications.instances?.get?.("gm-whispers-panel")?.checkServer?.();
    } catch (err) {
      ui.notifications.error(`GM Whispers: не удалось сохранить — ${err.message}`);
    } finally {
      this.saving = false;
      this.render();
    }
  }
}

export function openServerSettings() {
  if (!game.user.isGM) return ui.notifications.warn("GM Whispers доступен только мастеру.");
  const open = foundry.applications.instances?.get?.("gm-whispers-settings");
  if (open) return open.bringToFront?.() ?? open.render({ force: true });
  return new ServerSettingsApp().render({ force: true });
}
