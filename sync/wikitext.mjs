// Minimal wikitext parsing: templates, sections, bullet lists, wikitables, links, galleries,
// and a safe inline wikitext -> HTML converter (all text is escaped; only known markup becomes tags).

import { wikiUrl, normTitle } from "./wiki.mjs";

const NON_ARTICLE = /^(file|image|category|template|media|special|user|[a-z]{2}(-[a-z]{2})?):/i;

export function stripNoise(text) {
  return String(text ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<\/?(noinclude|includeonly|onlyinclude)>/gi, "")
    .replace(/__[A-Z]+__/g, "");
}

/** Index of the matching close for an opener at `start` ("{{" or "[["). */
function matchClose(text, start, open, close) {
  let depth = 0;
  for (let i = start; i < text.length - 1; i++) {
    if (text.startsWith(open, i)) {
      depth++;
      i++;
    } else if (text.startsWith(close, i)) {
      depth--;
      i++;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Split on `sep` but not inside [[...]] or {{...}}. */
export function splitTopLevel(text, sep = "|") {
  const parts = [];
  let depthLink = 0;
  let depthTpl = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith("[[", i)) { depthLink++; i++; continue; }
    if (text.startsWith("]]", i) && depthLink > 0) { depthLink--; i++; continue; }
    if (text.startsWith("{{", i)) { depthTpl++; i++; continue; }
    if (text.startsWith("}}", i) && depthTpl > 0) { depthTpl--; i++; continue; }
    if (depthLink === 0 && depthTpl === 0 && text.startsWith(sep, i)) {
      parts.push(text.slice(last, i));
      i += sep.length - 1;
      last = i + 1;
    }
  }
  parts.push(text.slice(last));
  return parts;
}

/** Find the first {{name ...}} template. Returns { name, params, positional } or null. */
export function findTemplate(text, name) {
  const re = new RegExp(`\\{\\{\\s*${name.replace(/[ _]/g, "[ _]")}\\s*(\\||\\}\\})`, "i");
  const m = re.exec(text);
  if (!m) return null;
  const end = matchClose(text, m.index, "{{", "}}");
  if (end < 0) return null;
  return parseTemplateBody(text.slice(m.index + 2, end - 2));
}

export function findTemplates(text, name) {
  const out = [];
  const re = new RegExp(`\\{\\{\\s*${name.replace(/[ _]/g, "[ _]")}\\s*(\\||\\}\\})`, "gi");
  let m;
  while ((m = re.exec(text))) {
    const end = matchClose(text, m.index, "{{", "}}");
    if (end < 0) break;
    out.push(parseTemplateBody(text.slice(m.index + 2, end - 2)));
    re.lastIndex = end;
  }
  return out;
}

function parseTemplateBody(inner) {
  const [head, ...rest] = splitTopLevel(inner, "|");
  const params = {};
  const positional = [];
  for (const part of rest) {
    const eq = splitTopLevel(part, "=");
    if (eq.length > 1 && /^[\w\s-]+$/.test(eq[0])) {
      params[eq[0].trim().toLowerCase()] = eq.slice(1).join("=").trim();
    } else {
      positional.push(part.trim());
    }
  }
  return { name: head.trim(), params, positional };
}

/** Level-N sections: Map(lowercase title -> body incl. deeper subsections). */
export function sections(text, level = 2) {
  const out = new Map();
  const re = /^(={2,6})\s*(.*?)\s*\1\s*$/gm;
  const heads = [];
  let m;
  while ((m = re.exec(text))) heads.push({ level: m[1].length, title: m[2], start: m.index, bodyStart: m.index + m[0].length });
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    if (h.level !== level) continue;
    let end = text.length;
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j].level <= level) { end = heads[j].start; break; }
    }
    const key = plain(h.title).toLowerCase();
    if (!out.has(key)) out.set(key, text.slice(h.bodyStart, end));
  }
  return out;
}

/** Ordered list of sections at a level with their raw heading. */
export function sectionList(text, level) {
  const re = /^(={2,6})\s*(.*?)\s*\1\s*$/gm;
  const heads = [];
  let m;
  while ((m = re.exec(text))) heads.push({ level: m[1].length, title: m[2], start: m.index, bodyStart: m.index + m[0].length });
  const out = [];
  for (let i = 0; i < heads.length; i++) {
    if (heads[i].level !== level) continue;
    let end = text.length;
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j].level <= level) { end = heads[j].start; break; }
    }
    out.push({ title: heads[i].title, body: text.slice(heads[i].bodyStart, end) });
  }
  return out;
}

export function bullets(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = /^([*#]+)\s*(.*)$/.exec(line.trim());
    if (m && m[2].trim()) out.push({ depth: m[1].length, text: m[2].trim() });
  }
  return out;
}

/** All wikitables in text: [{ rows: [[{ header, text, colspan }]] }] */
export function tables(text) {
  const out = [];
  const lines = String(text ?? "").split("\n");
  const stack = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("{|")) {
      stack.push({ rows: [], row: null, cell: null });
      continue;
    }
    const t = stack[stack.length - 1];
    if (!t) continue;
    if (line.startsWith("|}")) {
      stack.pop();
      if (t.row) t.rows.push(t.row);
      out.push({ rows: t.rows.filter((r) => r.length) });
      if (stack.length) {
        // nested table: keep its text inside the parent cell
        const parent = stack[stack.length - 1];
        if (parent.cell) parent.cell.text += "\n[table]";
      }
      continue;
    }
    if (stack.length > 1) continue;
    if (line.startsWith("|+")) continue;
    if (line.startsWith("|-")) {
      if (t.row) t.rows.push(t.row);
      t.row = [];
      t.cell = null;
      continue;
    }
    if (line.startsWith("!") || line.startsWith("|")) {
      t.row ??= [];
      const header = line.startsWith("!");
      const body = line.slice(1);
      const pieces = header ? splitTopLevel(body, "!!").flatMap((p) => splitTopLevel(p, "||")) : splitTopLevel(body, "||");
      for (const piece of pieces) {
        const cell = makeCell(piece, header);
        t.row.push(cell);
        t.cell = cell;
      }
      continue;
    }
    if (t.cell) t.cell.text += "\n" + raw;
  }
  return out;
}

function makeCell(piece, header) {
  const parts = splitTopLevel(piece, "|");
  let attrs = "";
  let text = piece;
  if (parts.length > 1 && /^\s*([a-z-]+\s*=\s*("[^"]*"|'[^']*'|[^\s"']+)\s*)+$/i.test(parts[0])) {
    attrs = parts[0];
    text = parts.slice(1).join("|");
  }
  const colspan = Number(/colspan\s*=\s*"?(\d+)/i.exec(attrs)?.[1] ?? 1);
  return { header, text: text.trim(), colspan };
}

/** Article links: [{ target, label }] (no files/categories/interwiki). */
export function links(text) {
  const out = [];
  const re = /\[\[([^\[\]|]+)(?:\|((?:[^\[\]]|\[\[[^\]]*\]\])*))?\]\]/g;
  let m;
  while ((m = re.exec(String(text ?? "")))) {
    const target = m[1].trim();
    if (NON_ARTICLE.test(target) || target.startsWith(":")) continue;
    out.push({ target: normTitle(target.split("#")[0]), anchor: target.split("#")[1] ?? null, label: plain(m[2] ?? target) });
  }
  return out.filter((l) => l.target);
}

/** File references from [[File:..]] links and <gallery> blocks: [{ file, caption }] */
export function files(text) {
  const out = [];
  const src = String(text ?? "");
  const re = /\[\[(?:File|Image):([^|\]]+)((?:\|(?:[^\[\]]|\[\[[^\]]*\]\])*)?)\]\]/gi;
  let m;
  while ((m = re.exec(src))) {
    const opts = splitTopLevel(m[2].replace(/^\|/, ""), "|").map((s) => s.trim()).filter(Boolean);
    const caption = opts.filter((o) => !/^(\d+(x\d+)?px|x\d+px|thumb|thumbnail|frame|frameless|left|right|center|none|border|upright.*|link=.*|alt=.*|class=.*)$/i.test(o)).pop() ?? "";
    out.push({ file: normTitle(m[1]), caption: plain(caption) });
  }
  const gal = /<gallery[^>]*>([\s\S]*?)<\/gallery>/gi;
  while ((m = gal.exec(src))) {
    for (const line of m[1].split("\n")) {
      const g = /^\s*(?:File:|Image:)?([^|]+\.(?:png|jpe?g|gif|webp|svg))\s*(?:\|(.*))?$/i.exec(line);
      if (g) out.push({ file: normTitle(g[1]), caption: plain(g[2] ?? "") });
    }
  }
  const seen = new Set();
  return out.filter((f) => (seen.has(f.file) ? false : seen.add(f.file)));
}

const ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", mdash: "—", ndash: "–", times: "×", hellip: "…", rarr: "→", larr: "←" };

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (all, name) => ENTITIES[name.toLowerCase()] ?? all);
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Remove balanced constructs that start with `opener` and satisfy `test(content)`. */
function removeBalanced(text, opener, open, close, replace) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const idx = text.indexOf(opener, i);
    if (idx < 0) break;
    const end = matchClose(text, idx, open, close);
    if (end < 0) break;
    out += text.slice(i, idx) + replace(text.slice(idx, end));
    i = end;
  }
  return out + text.slice(i);
}

export const unknownTemplates = new Map();

function renderTemplate(raw, ctx) {
  const tpl = parseTemplateBody(raw.slice(2, -2));
  const name = tpl.name.toLowerCase();
  if (name === "pagename" || name === "fullpagename") return ctx.title ?? "";
  if (name === "!") return "|";
  if (name === "quote" || name === "event content" || name.startsWith("navbox") || name.startsWith("infobox")) return "";
  if (name === "fir" || name === "found in raid") return "[[Found in raid|<font color=\"red\">in raid</font>]]";
  if (name === "color" && tpl.positional.length >= 2) return `<font color="${tpl.positional[0]}">${tpl.positional[1]}</font>`;
  if (name === "nowrap" || name === "small" || name === "big") return tpl.positional[0] ?? "";
  unknownTemplates.set(tpl.name, (unknownTemplates.get(tpl.name) ?? 0) + 1);
  return tpl.positional.length ? tpl.positional[tpl.positional.length - 1] : "";
}

function preprocess(text, ctx) {
  let t = stripNoise(text);
  t = removeBalanced(t, "{{", "{{", "}}", (raw) => renderTemplate(raw, ctx));
  t = removeBalanced(t, "[[", "[[", "]]", (raw) => (/^\[\[\s*(file|image|category|[a-z]{2}(-[a-z]{2})?):/i.test(raw) ? "" : raw));
  t = t.replace(/<gallery[\s\S]*?<\/gallery>/gi, "");
  return decodeEntities(t);
}

const COLOR_CLASS = { red: "c-red", green: "c-green", "#ff0000": "c-red", "#008000": "c-green", orange: "c-orange", blue: "c-blue", gold: "c-orange", yellow: "c-orange" };

/** Inline wikitext -> safe HTML. */
export function toHtml(text, ctx = {}) {
  const store = [];
  const ph = (html) => `\u0001${store.push(html) - 1}\u0002`;
  let t = preprocess(text, ctx);

  // internal links
  t = t.replace(/\[\[([^\[\]|]+)(?:\|((?:[^\[\]]|\[\[[^\]]*\]\])*))?\]\]([a-z]*)/g, (_, target, label, suffix) => {
    const page = normTitle(target.split("#")[0]);
    const inner = toHtml((label ?? target.replace(/^:/, "")) + (suffix ?? ""), ctx);
    if (!page) return ph(inner);
    return ph(`<a class="wl" href="${escapeHtml(wikiUrl(target.trim()))}" data-wiki="${escapeHtml(page)}" target="_blank" rel="noopener">${inner}</a>`);
  });
  // external links
  t = t.replace(/\[(https?:\/\/[^\s\]]+)(?:\s+([^\]]*))?\]/g, (_, url, label) =>
    ph(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label ?? url)}</a>`)
  );
  // tags we keep
  t = t.replace(/<br\s*\/?>/gi, () => ph("<br>"));
  t = t.replace(/<font[^>]*color\s*=\s*["']?([#\w]+)["']?[^>]*>/gi, (_, color) => ph(`<span class="${COLOR_CLASS[color.toLowerCase()] ?? "c-other"}">`));
  t = t.replace(/<\/font>/gi, () => ph("</span>"));
  t = t.replace(/<(\/?)(sup|sub|s|del|u|b|i|strong|em|small)\b[^>]*>/gi, (_, slash, tag) => ph(`<${slash}${tag.toLowerCase()}>`));
  t = t.replace(/<\/?[a-z][^>]*>/gi, "");

  t = escapeHtml(t);
  t = t.replace(/'''''(.+?)'''''/g, "<b><i>$1</i></b>").replace(/'''(.+?)'''/g, "<b>$1</b>").replace(/''(.+?)''/g, "<i>$1</i>");
  for (let pass = 0; pass < 3 && t.includes("\u0001"); pass++) {
    t = t.replace(/\u0001(\d+)\u0002/g, (_, n) => store[Number(n)]);
  }
  return balanceSpans(t.trim());
}

function balanceSpans(html) {
  let depth = 0;
  const out = html.replace(/<span\b[^>]*>|<\/span>/g, (tag) => {
    if (tag.startsWith("</")) {
      if (depth === 0) return "";
      depth--;
      return tag;
    }
    depth++;
    return tag;
  });
  return out + "</span>".repeat(depth);
}

export function plain(text, ctx) {
  return htmlToText(toHtml(text, ctx));
}

export function htmlToText(html) {
  return decodeEntities(String(html).replace(/<br>/g, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/** Block-level wikitext (paragraphs, bullets, sub-headings) -> HTML. Tables and galleries are dropped. */
export function blocksToHtml(text, ctx = {}) {
  let t = stripNoise(text);
  // drop tables (handled separately) and gallery/list wrappers
  t = dropTables(t)
    .replace(/<gallery[\s\S]*?<\/gallery>/gi, "")
    .replace(/<\/?(li|ul|div|center|tabber|table-progress-tracking)[^>]*>/gi, "\n");
  const out = [];
  let list = [];
  let para = [];
  const flushPara = () => {
    const joined = para.join(" ").trim();
    if (joined) {
      const html = toHtml(joined, ctx);
      if (html) out.push(`<p>${html}</p>`);
    }
    para = [];
  };
  const flushList = () => {
    if (list.length) out.push(renderList(list, ctx));
    list = [];
  };
  for (const raw of t.split("\n")) {
    const line = raw.trim();
    const h = /^(={2,6})\s*(.*?)\s*\1$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      const html = toHtml(h[2], ctx);
      if (html) out.push(`<h4>${html}</h4>`);
      continue;
    }
    const b = /^([*#]+)\s*(.*)$/.exec(line);
    if (b) {
      flushPara();
      if (b[2].trim()) list.push({ depth: b[1].length, text: b[2] });
      continue;
    }
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join("\n");
}

export function renderList(items, ctx) {
  let html = "";
  let depth = 0;
  for (const item of items) {
    while (depth < item.depth) { html += "<ul>"; depth++; }
    while (depth > item.depth) { html += "</ul>"; depth--; }
    html += `<li>${toHtml(item.text, ctx)}</li>`;
  }
  while (depth > 0) { html += "</ul>"; depth--; }
  return html;
}

export function dropTables(text) {
  const lines = text.split("\n");
  const out = [];
  let depth = 0;
  for (const line of lines) {
    const tl = line.trim();
    if (tl.startsWith("{|")) { depth++; continue; }
    if (depth > 0 && tl.startsWith("|}")) { depth--; continue; }
    if (depth === 0) out.push(line);
  }
  return out.join("\n");
}
