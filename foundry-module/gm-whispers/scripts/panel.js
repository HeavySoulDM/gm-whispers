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
import { bibleEntry, buildBible, getBible, guessQuentaFolder, openOrBuildBible } from "./bible.js";
import { openServerSettings } from "./settings.js";
import { loggerState } from "./logger.js";
import { T, TList } from "./i18n.js";

const TACTIC_WORDS = /тактик|местност|укрыт|позици|стен|двер|(?:^|\s)ход|атак|отступ|засад|окруж|фланг|tactic|terrain|cover|position|wall|door|\bmove|attack|retreat|ambush|flank|\bturn\b/i;

const { ApplicationV2 } = foundry.applications.api;

/** Примеры вопросов: общие и по ситуации (бой, выделенный токен, сцена). Тексты — lang/*.json (GMW.Examples.<группа>.<n>).
 * Каждый раз показываются три случайных. */
function pickExamples(n = 3) {
  const general = TList("GMW.Examples.general");
  const pool = [];
  if (game.combat?.started) pool.push(...TList("GMW.Examples.combat"));
  const tok = canvas?.tokens?.controlled?.[0];
  if (tok?.name) pool.push(...TList("GMW.Examples.token").map(q => q.replace("{name}", tok.name)));
  if (canvas?.scene) pool.push(...TList("GMW.Examples.scene"));
  // Ситуативные — в приоритете: берём их первыми, остальное добираем случайно.
  const situational = pool.sort(() => Math.random() - 0.5);
  return [...situational.slice(0, 2), ...general.sort(() => Math.random() - 0.5)].slice(0, n);
}


const PHASES = {
  start: "GMW.Panel.PhaseStart",
  model: "GMW.Panel.PhaseModel",
  read: "GMW.Panel.PhaseRead",
  speech: "GMW.Panel.PhaseSpeech",
  save: "GMW.Panel.PhaseSave",
};

function fmtLeft(sec) {
  if (sec == null) return T("GMW.Panel.Estimating");
  if (sec < 90) return T("GMW.Panel.LeftSec", { n: Math.max(5, Math.round(sec)) });
  if (sec < 3600) return T("GMW.Panel.LeftMin", { n: Math.round(sec / 60) });
  return T("GMW.Panel.LeftHourMin", { h: Math.floor(sec / 3600), m: Math.round((sec % 3600) / 60) });
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return T("GMW.Panel.Sec", { n: s });
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Полоска прогресса длинной операции (расшифровка Craig, итоги). it.progress — от сервера, it.indeterminate — без процентов. */
function pendingHTML(it) {
  const p = it.progress;
  let html = `<div class="gmw-pending"><div><i class="fas fa-spinner fa-spin"></i> ${esc(it.phase ?? T("GMW.Panel.Thinking"))} · <span class="gmw-timer" data-started="${it.started}">${fmtElapsed(Date.now() - it.started)}</span></div>`;
  if (it.partial) html += `<div class="gmw-a gmw-partial">${renderAnswer(it.partial, [])}</div>`;
  if (p) {
    const pct = p.pct;
    html += pct == null
      ? `<div class="gmw-bar gmw-bar-ind"><div></div></div>`
      : `<div class="gmw-bar"><div style="width:${Math.min(100, Math.max(0, pct))}%"></div></div>`;
    const parts = [];
    if (pct != null) parts.push(`${Math.floor(pct)}%`);
    if (p.tracks) parts.push(`${T("GMW.Panel.Track", { track: p.track || 0, tracks: p.tracks })}${p.name ? ` (${esc(p.name)})` : ""}`);
    if (PHASES[p.phase]) parts.push(T(PHASES[p.phase]));
    if (p.phase === "speech" || p.phase === "read") parts.push(T("GMW.Panel.Left", { time: fmtLeft(p.eta) }));
    html += `<div class="gmw-progress-meta">${parts.join(" · ")}<span class="gmw-ago" data-at="${Number(p.at) || 0}"></span></div>`;
  } else if (it.indeterminate) {
    html += `<div class="gmw-bar gmw-bar-ind"><div></div></div>`;
  }
  return html + "</div>";
}

export function renderAnswer(md, citations = []) {
  return renderMarkdown(md, { citations });
}

/** Лента ответов: одна на вкладку браузера (закрыл панель — ответы не пропали) и копия в localStorage на случай F5.
 *  Хранятся только завершённые карточки, не больше MAX_ITEMS; ключ — по миру. */
const feedStore = {
  items: null,
  draft: "",
  _timer: null,
  key() { return `gm-whispers.feed.${game.world?.id ?? "world"}`; },
  load() {
    if (this.items) return this.items;
    this.items = [];
    try {
      const raw = localStorage.getItem(this.key());
      const saved = raw ? JSON.parse(raw) : null;
      if (Array.isArray(saved?.items)) this.items.push(...saved.items.filter(it => it && !it.pending && it.question));
      this.draft = typeof saved?.draft === "string" ? saved.draft : "";
    } catch (_) { /* приватный режим или битые данные — начинаем с пустой ленты */ }
    return this.items;
  },
  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      try {
        const items = (this.items ?? []).filter(it => !it.pending).slice(-20);
        localStorage.setItem(this.key(), JSON.stringify({ items, draft: this.draft }));
      } catch (_) { /* место кончилось или приватный режим — лента живёт только до перезагрузки */ }
    }, 800);
  },
};

export class AdvisorPanel extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "gm-whispers-panel",
    classes: ["gm-whispers"],
    tag: "div",
    window: { title: "GM Whispers", icon: "fas fa-hat-wizard", resizable: true },
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
      openSetup: AdvisorPanel.#onOpenSetup,
    },
  };

  static MAX_ITEMS = 40; // лента не растёт бесконечно

  constructor(options = {}, { poll = true } = {}) {
    super(options);
    // Лента общая для всех открытий панели в этой вкладке и переживает F5 (хранится в браузере мастера).
    this.items = feedStore.load();
    this.draft = feedStore.draft;
    this.useScene = true;
    this.fast = false;
    this.busy = false;
    this.status = { state: "unknown", text: T("GMW.Panel.CheckingServer"), kb: null };
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
        text: h.apiKey ? T("GMW.Panel.ServerOk", { model: (h.models?.lore ?? "").replace(/^claude-/, "").replace(/^[a-z]+:/, "") }) : T("GMW.Panel.ServerNoKey"),
        kb: h.kb,
        craig: h.craig ?? null,
        usage: h.usage ?? null,
      };
      this._notifyCraig(h.craig);
      this._autoBuildKb(h);
    } catch (err) {
      this.status = { state: "bad", text: err.message, kb: this.status.kb ?? null, craig: null };
    }
    // Перерисовываем только при изменениях, чтобы не сбивать набор вопроса.
    if (this.rendered && JSON.stringify(this.status) !== before) this.render();
  }

  /** База собирается сама: при первом запуске (сервер и ключ есть, база пуста) и после смены источников в настройках.
   *  Повторная попытка — не чаще раза в 10 минут, чтобы не долбить сервер при постоянной ошибке. */
  _autoBuildKb(h) {
    if (!h?.apiKey || h.kb?.chunks || this._kbBusy) return;
    if (this._kbAutoAt && Date.now() - this._kbAutoAt < 600000) return;
    this._kbAutoAt = Date.now();
    this.refreshKb({ quiet: true });
  }

  /** Первая библия кампании собирается сама сразу после первой сборки базы — один раз за сеанс; дальше её обновляют «Итоги». */
  async _autoBuildBible() {
    if (this._bibleAutoTried || bibleEntry() || this.busy) return;
    this._bibleAutoTried = true;
    try {
      await buildBible(this, { folderId: guessQuentaFolder()?.id ?? "", count: 4 });
    } catch (err) {
      console.warn(`${MODULE_ID} | автосборка библии`, err);
    }
  }

  /** Уведомление, когда сервер закончил обработку записи Craig из облачной папки. */
  _notifyCraig(craig) {
    const jobs = craig?.jobs ?? [];
    this._craigSeen ??= new Set(jobs.filter(j => j.state !== "running").map(j => `${j.file}|${j.finished}`));
    for (const j of jobs) {
      const key = `${j.file}|${j.finished}`;
      if (j.state === "running" || this._craigSeen.has(key)) continue;
      this._craigSeen.add(key);
      if (j.state === "done") ui.notifications.info(T("GMW.Panel.CraigDone", { file: j.file, session: j.session }));
      else ui.notifications.error(T("GMW.Panel.CraigError", { file: j.file, message: j.message }));
    }
  }

  /** Пока модуль не настроен (сервер, ключ или база) — вместо пустой ленты короткая подсказка и ссылка на мастер. */
  _setupHTML() {
    const st = this.status;
    const server = st.state !== "bad" && st.state !== "unknown";
    const key = st.state === "ok";
    const kb = !!st.kb?.chunks;
    if (server && key && kb) return null;
    let line;
    if (!server) line = T("GMW.Panel.SetupNoServer", { cmd: "<code>server\\start.bat</code>", andToken: String(game.settings.get(MODULE_ID, "token") || "").trim() ? "" : " " + T("GMW.Panel.SetupAndToken") });
    else if (!key) line = T("GMW.Panel.SetupNoKey");
    else line = this._kbBusy ? T("GMW.Panel.SetupKbBuilding") : T("GMW.Panel.SetupKbEmpty");
    return `<div class="gmw-setup">
      <p><b>${T("GMW.Panel.SetupNotReady")}</b></p>
      <p>${line}</p>
      <p><a data-action="openSetup"><i class="fas fa-hat-wizard"></i> ${T("GMW.Common.SetupWizard")}</a></p>
    </div>`;
  }

  _usageText() {
    const u = this.status.usage?.today;
    if (!u) return "";
    const kinds = { ask: "GMW.Panel.KindAsk", session_summary: "GMW.Panel.KindSummary", prep: "GMW.Panel.KindPrep", bible: "GMW.Panel.KindBible" };
    const parts = Object.entries(u.byKind ?? {}).map(([k, v]) => `${kinds[k] ? T(kinds[k]) : k} ${v.calls}`).join(", ");
    return ` · ${T("GMW.Panel.Today", { usd: (u.usd ?? 0).toFixed(2) })}${parts ? ` (${parts})` : ""}`;
  }

  _emptyHTML() {
    const show = game.settings.get(MODULE_ID, "showExamples");
    const head = `<p>${esc(T("GMW.Panel.EmptyHead"))}
      <a class="gmw-link" data-action="toggleExamples">${show ? T("GMW.Panel.HideExamples") : T("GMW.Panel.ShowExamples")}</a></p>`;
    if (!show) return `<div class="gmw-empty">${head}</div>`;
    this._examples ??= pickExamples();
    return `<div class="gmw-empty">${head}
      ${this._examples.map(e => `<a class="gmw-example" data-action="example">${esc(e)}</a>`).join("")}
      <a class="gmw-link gmw-more" data-action="moreExamples"><i class="fas fa-shuffle"></i> ${T("GMW.Panel.MoreExamples")}</a></div>`;
  }

  _kbText() {
    const kb = this.status.kb;
    if (this._kbBusy) return T("GMW.Panel.KbBuilding");
    if (!kb || !kb.chunks) return T("GMW.Panel.KbEmpty") + this._usageText();
    // Подробности (очередь журнала, недошедшие правки) показываем только когда что-то не так.
    const offline = (loggerState.pending && loggerState.lastError) || kbSyncState.stale ? ` · ${T("GMW.Panel.Offline")}` : "";
    const running = (this.status.craig?.jobs ?? []).find(j => j.state === "running");
    const pct = running?.progress?.pct;
    const craig = running ? ` · ${T("GMW.Panel.Transcribing", { file: running.file })}${pct != null ? ` (${Math.floor(pct)}%)` : ""}` : "";
    return `${T("GMW.Panel.KbKnown", { n: kb.pages })}${this._usageText()}${offline}${craig}`;
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
        body += `<div class="gmw-journal"><a data-action="openDoc" data-uuid="${esc(it.journalUuid)}"><i class="fas fa-book-open"></i> ${esc(it.journalName ?? T("GMW.Panel.OpenInJournal"))}</a></div>`;
      }
      const u = it.usage ?? {};
      body += `<div class="gmw-meta">${esc((u.model ?? "").replace(/^claude-/, "").replace(/^[a-z]+:/, ""))} · ${T("GMW.Panel.Sec", { n: it.seconds })} · ${T("GMW.Panel.Calls", { n: u.calls ?? "?" })} · ${u.cost_estimated ? "≈" : "~"}$${(u.cost_usd ?? 0).toFixed(3)}
        <a data-action="toChat" data-index="${idx}" data-tooltip="${esc(T("GMW.Panel.ToChat"))}"><i class="fas fa-comment-dots"></i></a></div>`;
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
          <button type="button" data-action="prep" data-tooltip="${esc(T("GMW.Prep.ButtonTooltip"))}" ${this.busy ? "disabled" : ""}><i class="fas fa-compass"></i> ${esc(T("GMW.Prep.Button"))}</button>
          <button type="button" data-action="summary" data-tooltip="${esc(T("GMW.Summary.ButtonTooltip"))}" ${this.busy ? "disabled" : ""}><i class="fas fa-scroll"></i> ${esc(T("GMW.Summary.Button"))}</button>
          <span class="gmw-spacer"></span>
          <button type="button" data-action="checkServer" data-tooltip="${esc(T("GMW.Panel.CheckServer"))}"><i class="fas fa-plug"></i></button>
          <button type="button" data-action="openSettings" data-tooltip="${esc(T("GMW.Panel.SettingsTooltip"))}"><i class="fas fa-sliders"></i></button>
        </div>
      </header>
      <section class="gmw-feed">${feed}</section>
      <footer class="gmw-input">
        <textarea name="question" rows="3" placeholder="${esc(T("GMW.Panel.Placeholder"))}">${esc(this.draft)}</textarea>
        <div class="gmw-row">
          <label data-tooltip="${esc(T("GMW.Panel.UseSceneTooltip"))}"><input type="checkbox" name="useScene" ${this.useScene ? "checked" : ""}> ${esc(T("GMW.Panel.UseScene"))}</label>
          <label data-tooltip="${esc(T("GMW.Panel.FastTooltip"))}"><input type="checkbox" name="fast" ${this.fast ? "checked" : ""}> <i class="fas fa-bolt"></i> ${esc(T("GMW.Panel.Fast"))}</label>
          <button type="button" data-action="tactics" ${this.busy ? "disabled" : ""} data-tooltip="${esc(T("GMW.Panel.TacticsTooltip"))}"><i class="fas fa-chess-knight"></i> ${esc(T("GMW.Panel.Tactics"))}</button>
          <button type="button" data-action="clear" data-tooltip="${esc(T("GMW.Panel.Clear"))}"><i class="fas fa-broom"></i></button>
          <button type="button" class="gmw-send" data-action="ask" ${this.busy ? "disabled" : ""}><i class="fas fa-paper-plane"></i> ${esc(T("GMW.Panel.Ask"))}</button>
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
          a.textContent = a.dataset.at > 0 && quiet > 90000 ? ` · ${T("GMW.Panel.NoProgress", { time: fmtElapsed(quiet) })}` : "";
        }
      }, 1000);
    }
  }

  /** Событие потока: статус, кусок текста или сброс (модель пошла искать дальше). Перерисовка не чаще 8 раз в секунду. */
  _onStreamEvent(item, ev) {
    if (ev.type === "status") { item.phase = ev.text; }
    else if (ev.type === "delta") { item.partial = (item.partial ?? "") + ev.text; item.phase = T("GMW.Panel.Answering"); }
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
    feedStore.save();
  }

  /** Перерисовать одну карточку ленты (прогресс), не трогая поле ввода и прокрутку. */
  updateItem(item) {
    if (!item.pending) feedStore.save();
    const idx = this.items.indexOf(item);
    const el = this.element?.querySelector(`.gmw-item[data-index="${idx}"]`);
    if (idx < 0 || !el) return this.render();
    el.outerHTML = this._itemHTML(item, idx);
  }

  async _onClose(options) {
    clearInterval(this._timer);
    clearInterval(this._poll);
    feedStore.draft = this.element?.querySelector("textarea[name=question]")?.value ?? this.draft;
    feedStore.save();
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
      shown = presetShown ?? `${T("GMW.Panel.TurnShown", { name: who })}${question ? " — " + question : ""}`;
      question = question ? T("GMW.Panel.TacticsQuestionWish", { name: who, wish: question }) : T("GMW.Panel.TacticsQuestion", { name: who });
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
      feedStore.save();
      if (this.rendered) this.render();
    }
  }

  /** Вопрос о конкретном токене из его меню (HUD). kind: who / line / tactics. */
  async askAboutToken(token, kind) {
    const name = token?.name ?? "?";
    const sideKey = { [CONST.TOKEN_DISPOSITIONS.HOSTILE]: "GMW.Panel.SideHostile", [CONST.TOKEN_DISPOSITIONS.FRIENDLY]: "GMW.Panel.SideFriendly", [CONST.TOKEN_DISPOSITIONS.NEUTRAL]: "GMW.Panel.SideNeutral" }[token?.document?.disposition];
    const side = sideKey ? T(sideKey) : "";
    if (kind === "tactics") return this.submit({ tactics: true, token, shown: T("GMW.Panel.TurnShown", { name }) });
    if (kind === "line") {
      return this.submit({
        token,
        role: "fast",
        shown: T("GMW.Panel.LineShown", { name }),
        question: T("GMW.Panel.LineQuestion", { name, side: side ? ` (${side})` : "" }),
      });
    }
    return this.submit({
      token,
      shown: T("GMW.Panel.WhoShown", { name }),
      question: T("GMW.Panel.WhoQuestion", { name, side: side ? ` (${T("GMW.Panel.Now", { side })})` : "" }),
    });
  }

  /** Пересобрать базу знаний из журналов мира и компендиумов. quiet — без уведомлений о ходе (автосборка). */
  async refreshKb({ quiet = false } = {}) {
    if (this._kbBusy) return;
    this._kbBusy = true;
    if (this.rendered) this.render();
    const n = quiet ? null : ui.notifications.info(T("GMW.Panel.KbReading"), { permanent: true });
    try {
      const pages = await collectAllPages(label => console.log(`gm-whispers | читаю компендиум ${label}`));
      const stats = await importKnowledge({ world: game.world.id, pages });
      ui.notifications.info(T("GMW.Panel.KbReady", { n: stats.pages }));
      this.status.kb = stats;
      if (this.status.state === "unknown") await this.checkServer();
      if (quiet) this._autoBuildBible();
    } catch (err) {
      ui.notifications.error(T("GMW.Panel.KbFailed", { reason: err.message }));
    } finally {
      this._kbBusy = false;
      if (n) try { ui.notifications.remove(n); } catch (_) { /* старый API уведомлений */ }
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
  static async #onOpenSetup() { const { openSetupWizard } = await import("./setup.js"); openSetupWizard(); }
  static #onCheckServer() { this.status = { state: "unknown", text: T("GMW.Panel.CheckingServer"), kb: this.status.kb }; this.render(); this.checkServer(); }
  static #onClear() { if (!this.busy) { this.items.length = 0; feedStore.save(); this._examples = null; this.render(); } }
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
    if (!doc) return ui.notifications.warn(T("GMW.Panel.PageNotFound"));
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
  if (!token) return ui.notifications.warn(T("GMW.Panel.SelectToken"));
  const panel = await openPanel();
  if (panel?.busy) return ui.notifications.warn(T("GMW.Panel.Busy"));
  panel?.askAboutToken?.(token, kind);
}

export function openPanel() {
  if (!game.user.isGM) return ui.notifications.warn(T("GMW.Common.GmOnly"));
  const open = foundry.applications.instances?.get?.("gm-whispers-panel");
  if (open) { open.bringToFront?.(); return open; }
  return new AdvisorPanel().render({ force: true });
}

export async function refreshKnowledge(opts) {
  const open = foundry.applications.instances?.get?.("gm-whispers-panel");
  if (open) return open.refreshKb(opts);
  // Без опроса сервера: временный объект, который не оставит после себя таймер.
  return new AdvisorPanel({}, { poll: false }).refreshKb(opts);
}

/** При входе в мир: если сервер и ключ готовы, а база пуста — собрать её без участия мастера. */
export async function autoBuildKnowledgeOnReady() {
  try {
    const h = await health();
    if (h.apiKey && !h.kb?.chunks) await refreshKnowledge({ quiet: true });
  } catch (_) { /* сервер не запущен — панель покажет шаги первого запуска */ }
}

export { MODULE_ID };
