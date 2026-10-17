/**
 * Небольшой Markdown → HTML для ответов советника и итогов сессии.
 * Ссылки [S3] превращаются в номера источников: в панели — кликабельные значки,
 * в журнале — ссылки Foundry @UUID[...]{n}.
 */

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function inline(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

/**
 * @param {string} md
 * @param {object} [opts]
 * @param {Array} [opts.citations]  [{uuid,title,ids:[S#]}]
 * @param {boolean} [opts.journal]  true — заголовки h2/h3/h4 и ссылки @UUID для журнала
 */
export function renderMarkdown(md, { citations = [], journal = false } = {}) {
  const num = new Map();
  citations.forEach((c, i) => (c.ids ?? [c.id]).forEach(sid => num.set(sid, i + 1)));
  let text = esc(md);
  if (journal) text = text.replace(/@/g, "&#64;").replace(/\[\[/g, "&#91;[");
  const lines = text.split(/\r?\n/);
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) out.push(`<p>${para.join("<br>")}</p>`); para = []; };
  const closeList = () => { if (list) out.push(`</${list}>`); list = null; };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara(); closeList();
      const tag = journal ? `h${Math.min(m[1].length + 1, 4)}` : "h4";
      out.push(`<${tag}>${inline(m[2])}</${tag}>`);
      continue;
    }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { flushPara(); if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    closeList();
    para.push(inline(line));
  }
  flushPara();
  closeList();
  return out.join("").replace(/\[(S\d+(?:\s*[,;]\s*S\d+)*)\]/g, (_all, group) => {
    const nums = [...new Set(group.split(/\s*[,;]\s*/).map(sid => num.get(sid)).filter(Boolean))];
    return nums.map(n => {
      const c = citations[n - 1];
      if (journal) return `@UUID[${c.uuid}]{[${n}]}`;
      return `<a class="gmw-ref" data-action="openCite" data-uuid="${esc(c.uuid)}" data-tooltip-text="${esc(c.title)}">${n}</a>`;
    }).join("");
  });
}

/** Список источников для журнала. */
export function sourcesHtml(citations = []) {
  if (!citations.length) return "";
  const items = citations.map(c => `<li>@UUID[${c.uuid}]{${esc(String(c.title).replace(/[{}\[\]]/g, ""))}} <em>(${esc(c.source)})</em></li>`).join("");
  return `<h3>Источники</h3><ol>${items}</ol>`;
}
