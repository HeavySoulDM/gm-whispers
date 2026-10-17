/**
 * Панель «GM Whispers — советник». Открывается только у мастера.
 */

import { MODULE_ID, ServerError, ask, askStream, health, importKnowledge } from "./api.js";
import { gatherContext } from "./context.js";
import { collectAllPages, kbSyncState } from "./kbsync.js";
import { tacticalSnapshot } from "./tactics.js";
import { esc, renderMarkdown } from "./md.js";
import { openSummaryDialog } from "./session.js";
import { openPrepDialog } from "./prep.js";
import { getBible, openOrBuildBible } from "./bible.js";
import { openServerSettings } from "./settings.js";
import { loggerState } from "./logger.js";

const TACTIC_WORDS = /тактик|местност|укрыт|позици|стен|двер|(?:^|\s)ход|атак|отступ|засад|окруж|фланг/i;

const { ApplicationV2 } = foundry.applications.api;

/** Примеры вопросов: общие и по ситуации (бой, выделенный токен, сцена). Тексты — lang/*.json (GMW.Examples.<группа>.<n>),
 * запасные русские — здесь. Каждый раз показываются три случайных. */
const EXAMPLES_FALLBACK = {
  general: [
    "Что партия может найти в этой локации?",
    "Какие фракции действуют рядом и как они отнесутся к партии?",
    "Какие особые правила кампании могут сработать здесь?",
    "Какие слухи партия могла услышать в таверне за последние дни?",
    "Что случилось в прошлой сессии и какие нити остались незакрытыми?",
    "Какой крючок подвести к следующей главе, если партия замешкается?",
    "Какие последствия будут у решения партии, принятого в прошлый раз?",
    "Какая награда уместна за это задание по книге?",
    "Какие случайные встречи подходят для этой части пути?",
    "Что знают о партии в этих местах и как к ней относятся?",
  ],
  combat: [
    "Как врагам использовать местность в этом бою?",
    "Кто из врагов должен отступить или сдаться и при каком раскладе?",
    "Что произойдёт, если бой затянется — кто придёт на шум?",
    "Как по правилам работает укрытие и захват в этой ситуации?",
  ],
  token: [
    "Что «{name}» знает о партии и что скрывает?",
    "Как «{name}» отреагирует, если партия попросит помощи?",
    "Что «{name}» может предложить партии взамен?",
  ],
  scene: [
    "Опиши эту сцену игрокам: что они видят, слышат, чувствуют.",
    "Какие тайны и зацепки спрятаны в этой локации по книге?",
  ],
};

function exampleGroup(group) {
  const out = [];
  for (let i = 1; i < 30; i++) {
    const key = `GMW.Examples.${group}.${i}`;
    const s = game.i18n?.localize?.(key);
    if (!s || s === key) break;
    out.push(s);
  }
  return out.length ? out : (EXAMPLES_FALLBACK[group] ?? []);
}

const EXAMPLES = new Proxy({}, { get: (_t, group) => exampleGroup(group) });

function pickExamples(n = 3) {
  const pool = [...EXAMPLES.general];
  if (game.combat?.started) pool.push(...EXAMPLES.combat);
  const tok = canvas?.tokens?.controlled?.[0];
  if (tok?.name) pool.push(...EXAMPLES.token.map(q => q.replace("{name}", tok.name)));
  if (canvas?.scene) pool.push(...EXAMPLES.scene);
  // Ситуативные — в приоритете: берём их первыми, остальное добираем случайно.
  const situational = pool.slice(EXAMPLES.general.length).sort(() => Math.random() - 0.5);
  const general = EXAMPLES.general.slice().sort(() => Math.random() - 0.5);
  return [...situational.slice(0, 2), ...general].slice(0, n);
}


const PHASES = {
  start: "запускаю распознавание",
  model: "загружаю модель на видеокарту",
  read: "читаю дорожку",
  speech: "распознаю голос",
  save: "сохраняю расшифровку",
};

function fmtLeft(sec) {
  if (sec == null) return "оцениваю…";
  if (sec < 90) return `~${Math.max(5, Math.round(sec))} с`;
  if (sec < 3600) return `~${Math.round(sec / 60)} мин`;
  return `~${Math.floor(sec / 3600)} ч ${Math.round((sec % 3600) / 60)} мин`;
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Полоска прогресса длинной операции (расшифровка Craig, итоги). it.progress — от сервера, it.indeterminate — без процентов. */
function pendingHTML(it) {
  const p = it.progress;
  let html = `<div class="gmw-pending"><div><i class="fas fa-spinner fa-spin"></i> ${esc(it.phase ?? "Думаю…")} · <span class="gmw-timer" data-started="${it.started}">${fmtElapsed(Date.now() - it.started)}</span></div>`;
  if (it.partial) html += `<div class="gmw-a gmw-partial">${renderAnswer(it.partial, [])}</div>`;
  if (p) {
    const pct = p.pct;
    html += pct == null
      ? `<div class="gmw-bar gmw-bar-ind"><div></div></div>`
      : `<div class="gmw-bar"><div style="width:${Math.min(100, Math.max(0, pct))}%"></div></div>`;
    const parts = [];
    if (pct != null) parts.push(`${Math.floor(pct)}%`);
    if (p.tracks) parts.push(`дорожка ${p.track || 0}/${p.tracks}${p.name ? ` (${esc(p.name)})` : ""}`);
    if (PHASES[p.phase]) parts.push(PHASES[p.phase]);
    if (p.phase === "speech" || p.phase === "read") parts.push(`осталось ${fmtLeft(p.eta)}`);
    html += `<div class="gmw-progress-meta">${parts.join(" · ")}<span class="gmw-ago" data-at="${Number(p.at) || 0}"></span></div>`;
  } else if (it.indeterminate) {
    html += `<div class="gmw-bar gmw-bar-ind"><div></div></div>`;
  }
  return html + "</div>";
}

/** Текст из lang/*.json; если языковые файлы ещё не подхвачены (module.json читается при старте Foundry) — запасной русский. */
const FALLBACK = {
  "GMW.Bible.Button": "Библия кампании: выжимка о партии, NPC, фракциях и текущем положении, которую модель получает с каждым вопросом. Shift+клик — пересобрать заново",
  "GMW.Prep.Button": "К игре",
  "GMW.Prep.ButtonTooltip": "Сводка перед сессией: где остановились, незакрытые нити, кто впереди, что пригодится из книги → журнал",
};
export function L(key) {
  const s = game.i18n?.localize?.(key);
  return !s || s === key ? (FALLBACK[key] ?? key) : s;
}

export function renderAnswer(md, citations = []) {
  return renderMarkdown(md, { citations });
}

export class AdvisorPanel extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "gm-whispers-panel",
    classes: ["gm-whispers"],
    tag: "div",
    window: { title: "GM Whispers — советник", icon: "fas fa-hat-wizard", resizable: true },
    position: { width: 500, height: 700 },
    actions: {
      ask: AdvisorPanel.#onAsk,
      tactics: AdvisorPanel.#onTactics,
      summary: AdvisorPanel.#onSummary,
      prep: AdvisorPanel.#onPrep,
      bible: AdvisorPanel.#onBible,
      openDoc: AdvisorPanel.#onOpenCite,
      refreshKb: AdvisorPanel.#onRefreshKb,
      checkServer: AdvisorPanel.#onCheckServer,
      openCite: AdvisorPanel.#onOpenCite,
      clear: AdvisorPanel.#onClear,
      example: AdvisorPanel.#onExample,
      moreExamples: AdvisorPanel.#onMoreExamples,
      toggleExamples: AdvisorPanel.#onToggleExamples,
      toChat: AdvisorPanel.#onToChat,
      openSettings: AdvisorPanel.#onOpenSettings,
    },
  };

  static MAX_ITEMS = 40; // лента не растёт бесконечно

  constructor(options = {}, { poll = true } = {}) {
    super(options);
    this.items = [];
    this.draft = "";
    this.useScene = true;
    this.fast = false;
    this.busy = false;
    this.status = { state: "unknown", text: "Проверяю сервер…", kb: null };
    if (poll) {
      this.checkServer();
      this._poll = setInterval(() => this.checkServer(), 60000);
    }
  }

  async checkServer() {
    const before = JSON.stringify(this.status);
    try {
      const h = await health();
      this.status = {
        state: h.apiKey ? "ok" : "warn",
        text: h.apiKey ? `Сервер подключён · ${(h.models?.lore ?? "").replace(/^claude-/, "").replace(/^[a-z]+:/, "")}` : "Сервер подключён, но ключ API не задан — открой «Настройки сервера» (⚙)",
        kb: h.kb,
        craig: h.craig ?? null,
        usage: h.usage ?? null,
      };
      this._notifyCraig(h.craig);
    } catch (err) {
      this.status = { state: "bad", text: err.message, kb: this.status.kb ?? null, craig: null };
    }
    // Перерисовываем только при изменениях, чтобы не сбивать набор вопроса.
    if (this.rendered && JSON.stringify(this.status) !== before) this.render();
  }

  /** Уведомление, когда сервер закончил обработку записи Craig из облачной папки. */
  _notifyCraig(craig) {
    const jobs = craig?.jobs ?? [];
    this._craigSeen ??= new Set(jobs.filter(j => j.state !== "running").map(j => `${j.file}|${j.finished}`));
    for (const j of jobs) {
      const key = `${j.file}|${j.finished}`;
      if (j.state === "running" || this._craigSeen.has(key)) continue;
      this._craigSeen.add(key);
      if (j.state === "done") ui.notifications.info(`GM Whispers: запись Craig «${j.file}» расшифрована и привязана к сессии ${j.session}. Можно делать «Итоги».`);
      else ui.notifications.error(`GM Whispers: не удалось обработать запись Craig «${j.file}»: ${j.message}`);
    }
  }

  /** Три шага первого запуска вместо пустой ленты, пока сервер, токен, ключ или база не готовы. */
  _setupHTML() {
    const st = this.status;
    const hasToken = !!String(game.settings.get(MODULE_ID, "token") || "").trim();
    const server = st.state !== "bad" && st.state !== "unknown";
    const key = st.state === "ok";
    const kb = !!st.kb?.chunks;
    if (server && key && kb) return null;
    const step = (done, active, title, body) => `<li class="${done ? "done" : active ? "active" : ""}"><i class="fas ${done ? "fa-circle-check" : active ? "fa-circle-dot" : "fa-circle"}"></i><div><b>${title}</b><div>${body}</div></div></li>`;
    return `<div class="gmw-setup">
      <p><b>Первый запуск — три шага.</b> Подробнее: README.md в папке GM_Whispers.</p>
      <ol>
        ${step(server, !server, "Запустить сервер и связать с ним модуль",
          server ? "сервер отвечает" : `Запусти <code>server\\start.bat</code> (или <code>start_tray.bat</code> — в трей). ${hasToken ? "Токен задан, но сервер не отвечает — проверь, что он запущен." : "В его окне есть локальный токен — вставь его в"} <a data-action="openSettings">настройках сервера (⚙)</a> и нажми «Проверить связь».`)}
        ${step(key, server && !key, "Вписать ключ API",
          key ? "ключ задан" : `В <a data-action="openSettings">настройках сервера (⚙)</a> вставь ключ Claude или OpenAI (достаточно одного) и нажми «Проверить» рядом с ним — модели подберутся сами.`)}
        ${step(kb, server && key && !kb, "Собрать базу знаний",
          kb ? "база собрана" : `Нажми <a data-action="refreshKb">«База»</a>: журналы мира и компендиумы правил уйдут в поиск советника (минута-две).`)}
      </ol></div>`;
  }

  _usageText() {
    const u = this.status.usage?.today;
    if (!u || !u.calls) return "";
    const kinds = { ask: "вопросы", session_summary: "итоги" };
    const parts = Object.entries(u.byKind ?? {}).map(([k, v]) => `${kinds[k] ?? k}: ${v.calls} — $${v.usd.toFixed(2)}`).join(", ");
    return ` · сегодня ~$${u.usd.toFixed(2)} за ${u.calls} обращ.${parts ? ` (${parts})` : ""}`;
  }

  _emptyHTML() {
    const show = game.settings.get(MODULE_ID, "showExamples");
    const head = `<p>Спроси что-нибудь о приключении. Ответ будет со ссылками на страницы журналов.
      <a class="gmw-link" data-action="toggleExamples">${show ? "скрыть примеры" : "показать примеры"}</a></p>`;
    if (!show) return `<div class="gmw-empty">${head}</div>`;
    this._examples ??= pickExamples();
    return `<div class="gmw-empty">${head}
      ${this._examples.map(e => `<a class="gmw-example" data-action="example">${esc(e)}</a>`).join("")}
      <a class="gmw-link gmw-more" data-action="moreExamples"><i class="fas fa-shuffle"></i> другие примеры</a></div>`;
  }

  _kbText() {
    const kb = this.status.kb;
    if (!kb || !kb.chunks) return "База знаний пуста" + this._usageText();
    const log = loggerState.pending ? ` · журнал: ${loggerState.pending} в очереди${loggerState.lastError ? " (нет связи)" : ""}` : "";
    const stale = kbSyncState.stale ? ` · не дошло правок журналов: ${kbSyncState.stale}` : "";
    const running = (this.status.craig?.jobs ?? []).find(j => j.state === "running");
    const pct = running?.progress?.pct;
    const craig = running ? ` · Craig: обрабатываю ${running.file}${pct != null ? ` (${Math.floor(pct)}%)` : ""}` : "";
    return `База: ${kb.pages} стр., ${kb.chunks} фрагм. · ${kb.updated ?? ""}${this._usageText()}${log}${stale}${craig}`;
  }

  _itemHTML(it, idx) {
    let body;
    if (it.pending) {
      body = pendingHTML(it);
    } else if (it.error) {
      body = `<div class="gmw-error"><i class="fas fa-triangle-exclamation"></i> ${esc(it.error)}</div>`;
    } else {
      body = `<div class="gmw-a">${renderAnswer(it.answer, it.citations)}</div>`;
      if (it.citations?.length) {
        body += `<ol class="gmw-cites">${it.citations.map(c =>
          `<li><a data-action="openCite" data-uuid="${esc(c.uuid)}">${esc(c.title)}</a> <span class="gmw-src">${esc(c.source)}</span></li>`).join("")}</ol>`;
      }
      if (it.journalUuid) {
        body += `<div class="gmw-journal"><a data-action="openDoc" data-uuid="${esc(it.journalUuid)}"><i class="fas fa-book-open"></i> ${esc(it.journalName ?? "Открыть в журнале")}</a></div>`;
      }
      const u = it.usage ?? {};
      body += `<div class="gmw-meta">${esc((u.model ?? "").replace(/^claude-/, "").replace(/^[a-z]+:/, ""))} · ${it.seconds} с · обращений: ${u.calls ?? "?"} · ${u.cost_estimated ? "≈" : "~"}$${(u.cost_usd ?? 0).toFixed(3)}
        <a data-action="toChat" data-index="${idx}" data-tooltip="Шёпотом себе в чат"><i class="fas fa-comment-dots"></i></a></div>`;
    }
    return `<article class="gmw-item" data-index="${idx}"><div class="gmw-q">${esc(it.question)}</div>${body}</article>`;
  }

  async _renderHTML(_context, _options) {
    const st = this.status;
    const setup = this.items.length ? null : this._setupHTML();
    const feed = this.items.length
      ? this.items.map((it, i) => this._itemHTML(it, i)).join("")
      : setup ?? this._emptyHTML();
    const root = document.createElement("div");
    root.className = "gmw-root";
    root.innerHTML = `
      <header class="gmw-status">
        <span class="gmw-dot gmw-${st.state}"></span>
        <div class="gmw-status-text"><div title="${esc(st.text)}">${esc(st.text)}</div><div class="gmw-kb" title="${esc(this._kbText())}">${esc(this._kbText())}</div></div>
        <div class="gmw-actions">
          <button type="button" data-action="prep" data-tooltip="${esc(L("GMW.Prep.ButtonTooltip"))}" ${this.busy ? "disabled" : ""}><i class="fas fa-compass"></i> ${esc(L("GMW.Prep.Button"))}</button>
          <button type="button" data-action="summary" data-tooltip="Итоги сессии по чату Foundry и твоим заметкам → «Дневник кампании»" ${this.busy ? "disabled" : ""}><i class="fas fa-scroll"></i> Итоги</button>
          <button type="button" data-action="refreshKb" data-tooltip="Выгрузить журналы мира в базу знаний"><i class="fas fa-rotate"></i> База</button>
          <span class="gmw-spacer"></span>
          <button type="button" data-action="bible" data-tooltip="${esc(L("GMW.Bible.Button"))}"><i class="fas fa-book"></i></button>
          <button type="button" data-action="checkServer" data-tooltip="Проверить связь с сервером"><i class="fas fa-plug"></i></button>
          <button type="button" data-action="openSettings" data-tooltip="Настройки сервера: ключи, модели, запись Craig, кто есть кто"><i class="fas fa-sliders"></i></button>
        </div>
      </header>
      <section class="gmw-feed">${feed}</section>
      <footer class="gmw-input">
        <textarea name="question" rows="3" placeholder="Вопрос мастера… Enter — отправить, Shift+Enter — новая строка">${esc(this.draft)}</textarea>
        <div class="gmw-row">
          <label data-tooltip="Сцена, токены и их стороны, партия, бой"><input type="checkbox" name="useScene" ${this.useScene ? "checked" : ""}> сцена и партия</label>
          <label data-tooltip="Одно обращение к быстрой модели, только по найденному сразу. Для реплик и подсказок в бою."><input type="checkbox" name="fast" ${this.fast ? "checked" : ""}> <i class="fas fa-bolt"></i> быстро</label>
          <button type="button" data-action="tactics" ${this.busy ? "disabled" : ""} data-tooltip="Варианты хода для того, чей ход в бою (или выделенного токена): расстояния, видимость, укрытия, двери, зоны. Текст в поле — доп. пожелание."><i class="fas fa-chess-knight"></i> Тактика</button>
          <button type="button" data-action="clear" data-tooltip="Очистить ленту"><i class="fas fa-broom"></i></button>
          <button type="button" class="gmw-send" data-action="ask" ${this.busy ? "disabled" : ""}><i class="fas fa-paper-plane"></i> Спросить</button>
        </div>
      </footer>`;
    return root;
  }

  _replaceHTML(result, content, _options) {
    content.replaceChildren(result);
  }

  _onRender(_context, _options) {
    const el = this.element;
    const ta = el.querySelector("textarea[name=question]");
    ta?.addEventListener("input", () => { this.draft = ta.value; });
    ta?.addEventListener("keydown", ev => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        this.submit();
      }
    });
    el.querySelector("input[name=useScene]")?.addEventListener("change", ev => { this.useScene = ev.target.checked; });
    el.querySelector("input[name=fast]")?.addEventListener("change", ev => { this.fast = ev.target.checked; });
    // Прокрутка к началу последнего ответа, чтобы длинный ответ читался сверху, а не с конца.
    const feed = el.querySelector(".gmw-feed");
    const last = feed?.lastElementChild;
    if (feed && last) feed.scrollTop = Math.max(0, last.offsetTop - feed.offsetTop - 6);
    if (!this.busy) ta?.focus();

    clearInterval(this._timer);
    if (this.items.some(i => i.pending)) {
      this._timer = setInterval(() => {
        for (const t of this.element?.querySelectorAll(".gmw-timer") ?? []) {
          t.textContent = fmtElapsed(Date.now() - Number(t.dataset.started));
        }
        // Если сервер долго не присылал прогресс — показываем, сколько уже тихо.
        for (const a of this.element?.querySelectorAll(".gmw-ago") ?? []) {
          const quiet = Date.now() - Number(a.dataset.at);
          a.textContent = a.dataset.at > 0 && quiet > 90000 ? ` · новостей нет ${fmtElapsed(quiet)}` : "";
        }
      }, 1000);
    }
  }

  /** Событие потока: статус, кусок текста или сброс (модель пошла искать дальше). Перерисовка не чаще 8 раз в секунду. */
  _onStreamEvent(item, ev) {
    if (ev.type === "status") { item.phase = ev.text; }
    else if (ev.type === "delta") { item.partial = (item.partial ?? "") + ev.text; item.phase = "Отвечаю…"; }
    else if (ev.type === "reset") { item.partial = ""; }
    else return;
    const now = Date.now();
    if (now - (this._streamAt ?? 0) < 120) {
      clearTimeout(this._streamTimer);
      this._streamTimer = setTimeout(() => this.updateItem(item), 130);
      return;
    }
    this._streamAt = now;
    this.updateItem(item);
  }

  /** Добавить карточку в ленту, не давая ей расти бесконечно (старые завершённые ответы уходят). */
  pushItem(item) {
    this.items.push(item);
    while (this.items.length > AdvisorPanel.MAX_ITEMS) {
      const i = this.items.findIndex(it => !it.pending);
      if (i < 0) break;
      this.items.splice(i, 1);
    }
  }

  /** Перерисовать одну карточку ленты (прогресс), не трогая поле ввода и прокрутку. */
  updateItem(item) {
    const idx = this.items.indexOf(item);
    const el = this.element?.querySelector(`.gmw-item[data-index="${idx}"]`);
    if (idx < 0 || !el) return this.render();
    el.outerHTML = this._itemHTML(item, idx);
  }

  async _onClose(options) {
    clearInterval(this._timer);
    clearInterval(this._poll);
    return super._onClose?.(options);
  }

  /**
   * @param {object} [o]
   * @param {boolean} [o.tactics]   варианты хода
   * @param {string} [o.question]   готовый вопрос вместо текста из поля
   * @param {string} [o.shown]      как подписать вопрос в ленте
   * @param {Token} [o.token]       токен, о котором спрашиваем (из меню токена)
   * @param {string} [o.role]       lore / fast / tactics
   */
  async submit({ tactics = false, question: preset = null, shown: presetShown = null, token = null, role: presetRole = null } = {}) {
    if (this.busy) return;
    let question = (preset ?? this.draft).trim();
    if (!question && !tactics) return;
    const context = gatherContext({ includeScene: this.useScene || tactics || !!token, tokens: token ? [token] : null }) ?? {};

    // Тактическая сводка: по кнопке «Тактика» или если вопрос про бой/местность во время боя.
    let snap = null;
    if (tactics || (game.combat?.started && TACTIC_WORDS.test(question))) {
      snap = tacticalSnapshot({ focusToken: tactics ? token : null });
      if (snap.error) {
        if (tactics) return ui.notifications.warn(`GM Whispers: ${snap.error}`);
        snap = null;
      } else {
        context.tactics = snap;
      }
    }
    let shown = presetShown ?? question;
    if (tactics) {
      const who = snap.focus?.name ?? "?";
      shown = presetShown ?? `⚔ Ход: ${who}${question ? " — " + question : ""}`;
      question = question ? `Тактика для «${who}». Пожелание мастера: ${question}` : `Как лучше сходить «${who}» в этом раунде?`;
    }

    const history = this.items.filter(i => i.answer).slice(-3).map(i => ({ q: i.question, a: i.answer }));
    const item = { question: shown, pending: true, started: Date.now() };
    this.pushItem(item);
    if (preset == null) this.draft = "";
    this.busy = true;
    this.render();
    try {
      const role = presetRole ?? (tactics ? "tactics" : (this.fast ? "fast" : "lore"));
      const payload = { question, context, history, role, lang: game.i18n.lang, bible: getBible() };
      let res;
      try {
        res = await askStream(payload, (ev) => this._onStreamEvent(item, ev));
      } catch (err) {
        // Старый сервер без /ask/stream — обычный запрос.
        if (err instanceof ServerError && err.status === 404) res = await ask(payload);
        else throw err;
      }
      Object.assign(item, res, { pending: false, question: shown, partial: null, phase: null });
    } catch (err) {
      Object.assign(item, { pending: false, error: err.message });
      if (err instanceof ServerError && err.status === 0) this.status = { state: "bad", text: err.message, kb: this.status.kb };
    } finally {
      this.busy = false;
      if (this.rendered) this.render();
    }
  }

  /** Вопрос о конкретном токене из его меню (HUD). kind: who / line / tactics. */
  async askAboutToken(token, kind) {
    const name = token?.name ?? "?";
    const side = { [CONST.TOKEN_DISPOSITIONS.HOSTILE]: "враг", [CONST.TOKEN_DISPOSITIONS.FRIENDLY]: "союзник", [CONST.TOKEN_DISPOSITIONS.NEUTRAL]: "нейтрал" }[token?.document?.disposition] ?? "";
    if (kind === "tactics") return this.submit({ tactics: true, token, shown: `⚔ Ход: ${name}` });
    if (kind === "line") {
      return this.submit({
        token,
        role: "fast",
        shown: `💬 Реплика: ${name}`,
        question: `Дай 2–3 реплики, которые «${name}»${side ? ` (${side})` : ""} может сказать партии прямо сейчас, в его манере и с учётом ситуации. Только реплики, коротко.`,
      });
    }
    return this.submit({
      token,
      shown: `❔ Кто это: ${name}`,
      question: `Кто такой «${name}»${side ? ` (сейчас: ${side})` : ""}? Коротко: кто он, чего хочет, как говорит и держится, что знает о партии и её делах, как поведёт себя в текущей ситуации. Если в материалах его нет — скажи и предложи образ (с пометкой «Импровизация»).`,
    });
  }

  async refreshKb() {
    const n = ui.notifications.info("GM Whispers: собираю журналы мира и компендиумы правил…", { permanent: true });
    const pages = await collectAllPages(label => console.log(`gm-whispers | читаю компендиум ${label}`));
    ui.notifications.info(`GM Whispers: выгружаю ${pages.length} страниц в базу знаний…`);
    try {
      const stats = await importKnowledge({ world: game.world.id, pages });
      ui.notifications.info(`GM Whispers: база обновлена — ${stats.pages} страниц, ${stats.chunks} фрагментов.`);
      this.status.kb = stats;
      if (this.status.state === "unknown") await this.checkServer();
    } catch (err) {
      ui.notifications.error(`GM Whispers: ${err.message}`);
    } finally {
      try { ui.notifications.remove(n); } catch (_) { /* старый API уведомлений */ }
      if (this.rendered) this.render();
    }
  }

  static #onAsk() { this.submit(); }
  static #onTactics() { this.submit({ tactics: true }); }
  static #onSummary() { openSummaryDialog(this); }
  static #onPrep() { openPrepDialog(this); }
  static #onBible(event) { openOrBuildBible(this, { rebuild: !!event?.shiftKey }); }
  static #onRefreshKb() { this.refreshKb(); }
  static #onOpenSettings() { openServerSettings(); }
  static #onCheckServer() { this.status = { state: "unknown", text: "Проверяю сервер…", kb: this.status.kb }; this.render(); this.checkServer(); }
  static #onClear() { if (!this.busy) { this.items = []; this._examples = null; this.render(); } }
  static #onExample(_event, target) { this.draft = target.textContent; this.render(); }
  static #onMoreExamples() { this._examples = pickExamples(); this.render(); }
  static async #onToggleExamples() {
    await game.settings.set(MODULE_ID, "showExamples", !game.settings.get(MODULE_ID, "showExamples"));
    this._examples = null;
    this.render();
  }

  static async #onOpenCite(event, target) {
    event.preventDefault();
    const doc = await fromUuid(target.dataset.uuid);
    if (!doc) return ui.notifications.warn("GM Whispers: страница не найдена (возможно, удалена — обнови базу).");
    if (doc.documentName === "JournalEntryPage") return doc.parent.sheet.render({ force: true, pageId: doc.id });
    return doc.sheet?.render({ force: true });
  }

  static async #onToChat(_event, target) {
    const it = this.items[Number(target.dataset.index)];
    if (!it?.answer) return;
    await ChatMessage.create({
      content: `<div class="gmw-chat"><strong>GM Whispers:</strong> ${esc(it.question)}<hr>${renderAnswer(it.answer, it.citations)}</div>`,
      whisper: game.users.filter(u => u.isGM).map(u => u.id),
      speaker: { alias: "GM Whispers" },
    });
  }
}

/** Токен для горячих клавиш: выделенный, иначе тот, чей ход в бою. */
function hotkeyToken() {
  return canvas?.tokens?.controlled?.[0] ?? game.combat?.combatant?.token?.object ?? null;
}

export async function askHotkey(kind) {
  if (!game.user.isGM) return;
  const token = hotkeyToken();
  if (!token) return ui.notifications.warn("GM Whispers: выдели токен (или начни бой — возьму того, чей ход).");
  const panel = await openPanel();
  if (panel?.busy) return ui.notifications.warn("GM Whispers: дождись ответа на предыдущий вопрос.");
  panel?.askAboutToken?.(token, kind);
}

export function openPanel() {
  if (!game.user.isGM) return ui.notifications.warn("GM Whispers доступен только мастеру.");
  const open = foundry.applications.instances?.get?.("gm-whispers-panel");
  if (open) { open.bringToFront?.(); return open; }
  return new AdvisorPanel().render({ force: true });
}

export async function refreshKnowledge() {
  const open = foundry.applications.instances?.get?.("gm-whispers-panel");
  if (open) return open.refreshKb();
  // Без опроса сервера: временный объект, который не оставит после себя таймер.
  return new AdvisorPanel({}, { poll: false }).refreshKb();
}

export { MODULE_ID };
