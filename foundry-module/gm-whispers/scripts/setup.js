/**
 * Мастер первого запуска: по шагам спрашивает всё, что нужно модулю, и объясняет, зачем это.
 * Открывается сам в мире, где модуль ещё не настраивали; потом — только по кнопке в настройках
 * или через game.gmWhispers.setup().
 *
 * Устроен как ServerSettingsApp (те же поля и логика сохранения), но показывает их по одному шагу.
 * Все шаги лежат в DOM одновременно — поэтому набранное не теряется при переходах, а сохранение
 * работает тем же _payload(), что и в окне настроек.
 */

import { MODULE_ID, request } from "./api.js";
import { esc } from "./md.js";
import { ServerSettingsApp } from "./settings.js";
import { T } from "./i18n.js";

const FEEDBACK_URL = "https://github.com/HeavySoulDM/gm-whispers/issues";

const STEPS = [
  { id: "welcome", title: "GMW.Setup.StepWelcome" },
  { id: "server", title: "GMW.Setup.StepServer" },
  { id: "key", title: "GMW.Setup.StepKey" },
  { id: "campaign", title: "GMW.Setup.StepCampaign" },
  { id: "sources", title: "GMW.Setup.StepSources" },
  { id: "voice", title: "GMW.Setup.StepVoice" },
  { id: "done", title: "GMW.Setup.StepDone" },
];

export class SetupWizard extends ServerSettingsApp {
  static DEFAULT_OPTIONS = {
    id: "gm-whispers-setup",
    classes: ["gm-whispers", "gmw-settings", "gmw-wizard"],
    tag: "div",
    window: { title: T("GMW.Setup.Title"), icon: "fas fa-hat-wizard", resizable: true },
    position: { width: 640, height: "auto" },
    actions: {
      ...ServerSettingsApp.DEFAULT_OPTIONS.actions,
      next: SetupWizard.#onNext,
      back: SetupWizard.#onBack,
      finish: SetupWizard.#onFinish,
      later: SetupWizard.#onLater,
    },
  };

  constructor(options = {}) {
    super(options);
    this.step = 0;
    this.stepError = "";
  }

  /* ------------------------------------------------------------ тексты шагов */

  _welcomeHTML() {
    return `
      <h3>${T("GMW.Setup.WelcomeTitle")}</h3>
      <p>${T("GMW.Setup.WelcomeWhat")}</p>
      <p><b>${T("GMW.Setup.WelcomePartsTitle")}</b> ${T("GMW.Setup.WelcomeParts", { core: "<b>GM Whispers Core</b>" })}</p>
      <p><b>${T("GMW.Setup.WelcomeCostTitle")}</b> ${T("GMW.Setup.WelcomeCost")}</p>
      <p><b>${T("GMW.Setup.WelcomeDataTitle")}</b> ${T("GMW.Setup.WelcomeData")}</p>
      <p class="hint">${T("GMW.Setup.WelcomeTime")}</p>
      <p class="hint">${T("GMW.Setup.WelcomeFeedback")} <a href="${esc(FEEDBACK_URL)}" target="_blank" rel="noopener">${esc(FEEDBACK_URL.replace(/^https?:\/\//, ""))}</a></p>`;
  }

  _serverHTML() {
    const ok = !!this.data;
    return `
      <h3>${T("GMW.Setup.ServerTitle")}</h3>
      <p>${T("GMW.Setup.ServerHow", { setup: "<code>server\\setup.bat</code>", start: "<code>server\\start.bat</code>" })}</p>
      <p>${T("GMW.Setup.ServerCode")}</p>
      <div class="gmw-field"><label>${T("GMW.Settings.TokenLabel")}</label>
        <div class="gmw-inline">
          <input type="password" name="token" autocomplete="off" value="${esc(game.settings.get(MODULE_ID, "token"))}" placeholder="${esc(T("GMW.Settings.TokenPlaceholder"))}">
          <button type="button" data-action="testServer"><i class="fas fa-satellite-dish"></i> ${T("GMW.Settings.TestServer")}</button>
        </div>
        <p class="hint">${ok ? `<span class="gmw-ok">${T("GMW.Setup.ServerOk")}</span> ` : ""}<span class="gmw-test-result">${esc(this.testResult ?? "")}</span>${!ok && this.error && !this.testResult ? `<span class="gmw-muted">${esc(this.error)}</span>` : ""}</p>
      </div>
      <details class="gmw-adv"><summary><i class="fas fa-sliders"></i> ${T("GMW.Setup.ServerOther")}</summary>
        <div class="gmw-field"><label>${T("GMW.Settings.ServerUrl")}</label><input type="text" name="serverUrl" value="${esc(game.settings.get(MODULE_ID, "serverUrl"))}" placeholder="http://127.0.0.1:8765"><p class="hint">${T("GMW.Settings.ServerUrlHint")}</p></div>
      </details>`;
  }

  _keyStepHTML(d) {
    return `
      <h3>${T("GMW.Setup.KeyTitle")}</h3>
      <p>${T("GMW.Setup.KeyWhat")}</p>
      <p>${T("GMW.Setup.KeyWhich")}</p>
      ${this._keysHTML(d)}`;
  }

  _campaignStepHTML() {
    return `
      <h3>${T("GMW.Setup.CampaignTitle")}</h3>
      <p>${T("GMW.Setup.CampaignIntro")}</p>
      ${this._campaignHTML()}`;
  }

  _sourcesStepHTML() {
    return `
      <h3>${T("GMW.Setup.SourcesTitle")}</h3>
      <p>${T("GMW.Setup.SourcesIntro")}</p>
      ${this._sourcesHTML()}`;
  }

  _voiceStepHTML(d) {
    return `
      <h3>${T("GMW.Setup.VoiceTitle")}</h3>
      <p>${T("GMW.Setup.VoiceIntro", { craig: '<a href="https://craig.chat" target="_blank" rel="noopener">Craig</a>' })}</p>
      <p class="hint">${T("GMW.Setup.VoiceFormat")}</p>
      <div class="gmw-field">
        <label>${T("GMW.Settings.CraigFolder")} ${d.craig_inbox ? (d.craig_inbox_exists ? `<span class="gmw-ok">· ${T("GMW.Settings.CraigFound")}</span>` : `<span class="gmw-bad">· ${T("GMW.Settings.CraigNotFound")}</span>`) : ""}</label>
        <input type="text" name="craig_inbox" value="${esc(d.craig_inbox ?? "")}" placeholder="D:\\Google Drive\\Craig">
        <p class="hint">${T("GMW.Setup.CraigFolderHint")}</p>
      </div>
      <label class="gmw-check"><input type="checkbox" name="craig_auto" ${d.craig_auto ? "checked" : ""}> ${T("GMW.Setup.CraigAuto")}</label>
      <div class="gmw-grid gmw-two">
        <div class="gmw-field"><label>${T("GMW.Settings.SpeechLang")}</label>
          <select name="whisper_language">${[["ru", "GMW.Settings.LangRu"], ["en", "GMW.Settings.LangEn"], ["auto", "GMW.Setup.SpeechAuto"]].map(([v, t]) => `<option value="${v}" ${v === (d.whisper_language || "ru") ? "selected" : ""}>${T(t)}</option>`).join("")}</select></div>
      </div>
      <input type="hidden" name="ignore_voice" value="${esc((d.ignore?.voice ?? []).join(", "))}">
      <input type="hidden" name="ignore_chat" value="${esc((d.ignore?.chat ?? []).join(", "))}">`;
  }

  _doneHTML() {
    return `
      <h3>${T("GMW.Setup.DoneTitle")}</h3>
      <p>${T("GMW.Setup.DoneNext")}</p>
      <ul>
        <li>${T("GMW.Setup.DoneKb")}</li>
        <li>${T("GMW.Setup.DoneBible")}</li>
      </ul>
      <p>${T("GMW.Setup.DoneHowTo")}</p>
      <ul>
        <li>${T("GMW.Setup.DoneUse1")}</li>
        <li>${T("GMW.Setup.DoneUse2")}</li>
        <li>${T("GMW.Setup.DoneUse3")}</li>
      </ul>
      <p class="hint">${T("GMW.Setup.DoneSettings")}</p>`;
  }

  /* ------------------------------------------------------------ разметка */

  async _renderHTML() {
    const root = document.createElement("div");
    root.className = "gmw-settings-root gmw-wizard-root";
    const d = this.data ?? {};
    const needServer = !this.data;
    const steps = STEPS.map((s, i) => {
      let body;
      switch (s.id) {
        case "welcome": body = this._welcomeHTML(); break;
        case "server": body = this._serverHTML(); break;
        case "key": body = needServer ? "" : this._keyStepHTML(d); break;
        case "campaign": body = needServer ? "" : this._campaignStepHTML(); break;
        case "sources": body = needServer ? "" : this._sourcesStepHTML(); break;
        case "voice": body = needServer ? "" : this._voiceStepHTML(d); break;
        case "done": body = this._doneHTML(); break;
      }
      if (needServer && !body) body = `<h3>${T("GMW.Setup.NeedServerTitle")}</h3><p class="hint">${T("GMW.Setup.NeedServer", { cmd: "<code>server\\start.bat</code>" })}</p>`;
      return `<section class="gmw-step" data-step="${s.id}" ${i === this.step ? "" : "hidden"}>${body}</section>`;
    }).join("");
    const dots = STEPS.map((s, i) => `<span class="gmw-dot-step ${i < this.step ? "done" : i === this.step ? "active" : ""}" title="${esc(T(s.title))}">${i < this.step ? '<i class="fas fa-check"></i>' : i + 1}</span><span class="gmw-dot-title ${i === this.step ? "active" : ""}">${esc(T(s.title))}</span>`).join("");
    const last = this.step === STEPS.length - 1;
    const first = this.step === 0;
    root.innerHTML = `
      <nav class="gmw-steps">${dots}</nav>
      ${steps}
      ${this.stepError ? `<p class="gmw-error"><i class="fas fa-triangle-exclamation"></i> ${esc(this.stepError)}</p>` : ""}
      <footer class="gmw-row">
        <button type="button" data-action="later" data-tooltip="${esc(T("GMW.Setup.LaterTooltip"))}"><i class="fas fa-clock"></i> ${T("GMW.Setup.Later")}</button>
        <span class="gmw-spacer"></span>
        ${first ? "" : `<button type="button" data-action="back"><i class="fas fa-arrow-left"></i> ${T("GMW.Setup.Back")}</button>`}
        ${last
          ? `<button type="button" class="gmw-send" data-action="finish" ${this.saving ? "disabled" : ""}><i class="fas fa-check"></i> ${T("GMW.Setup.Finish")}</button>`
          : `<button type="button" class="gmw-send" data-action="next" ${this.saving ? "disabled" : ""}>${first ? T("GMW.Setup.Start") : T("GMW.Setup.Next")} <i class="fas fa-arrow-right"></i></button>`}
      </footer>`;
    return root;
  }

  _onFirstRender() {
    // Данные сервера пробуем прочитать сразу, но ошибку не показываем: мастер сам ведёт к шагу «Сервер».
    if (!this.data && !this.error) this.load();
  }

  /** В мастере нет части полей окна настроек (архив, адреса, кто есть кто) — их значения на сервере не трогаем. */
  _payload() {
    const body = super._payload();
    if (!this._field("cleanup_on")) delete body.sessions_keep_days;
    if (!this._field("allowed_origins")) delete body.allowed_origins;
    if (!this._field("craig_inbox")) { delete body.craig_inbox; delete body.craig_auto; }
    if (!this._field("whisper_language")) delete body.whisper_language;
    if (!this._field("ignore_voice")) delete body.ignore;
    delete body.speakers;
    return body;
  }

  /* ------------------------------------------------------------ действия */

  /** Проверка перед переходом дальше; возвращает текст ошибки или пусто. */
  async _validate() {
    const id = STEPS[this.step].id;
    if (id === "server") {
      if (!this.data) {
        await ServerSettingsApp.DEFAULT_OPTIONS.actions.testServer.call(this);
        if (!this.data) return T("GMW.Setup.NoServer");
      }
    }
    if (id === "key") {
      const typed = Object.keys(this.data?.keys ?? {}).some(p => this._field(`key-${p}`)?.value.trim());
      const set = Object.values(this.data?.keys ?? {}).some(k => k.set);
      if (!typed && !set) return T("GMW.Setup.NoKey");
    }
    return "";
  }

  /** Сохранить всё, что уже заполнено (как кнопка «Сохранить» в настройках), без уведомлений. */
  async _saveQuiet() {
    if (!this.data) return;
    this._syncSpeakersFromForm();
    const body = this._payload();
    await game.settings.set(MODULE_ID, "serverUrl", this._field("serverUrl")?.value.trim() || "http://127.0.0.1:8765");
    await game.settings.set(MODULE_ID, "token", this._field("token")?.value.trim() || "");
    await game.settings.set(MODULE_ID, "kbSources", this._collectSources());
    await game.settings.set(MODULE_ID, "kbPacks", this._collectPacks());
    const res = await request("/settings", { method: "POST", body, timeout: 20000 });
    this.data = res;
    this.clearKeys.clear();
    this.sources = null;
  }

  static async #onNext() {
    if (this.saving) return;
    this.saving = true;
    this.stepError = "";
    try {
      this.stepError = await this._validate();
      if (!this.stepError) {
        if (this.data && STEPS[this.step].id !== "welcome") await this._saveQuiet();
        this.step += 1;
      }
    } catch (err) {
      this.stepError = err.message;
    } finally {
      this.saving = false;
      await this._rerender();
    }
  }

  static async #onBack() { this.stepError = ""; this.step = Math.max(0, this.step - 1); await this._rerender(); }

  static async #onLater() {
    try { if (this.data) await this._saveQuiet(); } catch (_) { /* сервера нет — сохранять нечего */ }
    this.close();
  }

  static async #onFinish() {
    if (this.saving) return;
    this.saving = true;
    try {
      await this._saveQuiet();
      await game.settings.set(MODULE_ID, "setupDone", true);
      ui.notifications.info(T("GMW.Setup.Finished"));
      this.close();
      const { openPanel } = await import("./panel.js");
      const panel = await openPanel();
      panel?.refreshKb?.({ quiet: true });
    } catch (err) {
      this.stepError = T("GMW.Setup.SaveFailed", { reason: err.message });
      this.saving = false;
      await this._rerender();
    }
  }
}

export function openSetupWizard() {
  if (!game.user.isGM) return ui.notifications.warn(T("GMW.Common.GmOnly"));
  const open = foundry.applications.instances?.get?.("gm-whispers-setup");
  if (open) return open.bringToFront?.() ?? open.render({ force: true });
  return new SetupWizard().render({ force: true });
}

/** Открыть мастер в новом мире. В мире, где модуль уже настраивали руками до появления мастера, — отметить настройку сделанной. */
export async function maybeOpenSetup() {
  if (!game.user.isGM || game.settings.get(MODULE_ID, "setupDone")) return;
  const configuredBefore = !!String(game.settings.get(MODULE_ID, "token") || "").trim() && Object.keys(game.settings.get(MODULE_ID, "kbSources") || {}).length > 0;
  if (configuredBefore) { await game.settings.set(MODULE_ID, "setupDone", true); return; }
  openSetupWizard();
}
