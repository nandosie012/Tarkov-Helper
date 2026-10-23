export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Tagged template: interpolations are escaped unless wrapped with raw(). */
export function html(strings, ...values) {
  let out = "";
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += render(values[i]);
  });
  return new Raw(out);
}
class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Raw(String(s ?? ""));
function render(v) {
  if (v == null || v === false) return "";
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join("");
  return esc(v);
}

export function rub(n) {
  if (n == null || !Number.isFinite(n)) return "–";
  return `${Math.round(n).toLocaleString("nl-NL")} ₽`;
}

export function pct(n) {
  if (n == null) return "?";
  const v = n * 100;
  return `${v >= 10 || v === 0 ? Math.round(v) : v.toFixed(1)}%`;
}

export function timeAgo(iso) {
  if (!iso) return "nooit";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return "zojuist";
  if (s < 3600) return `${Math.round(s / 60)} min geleden`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} uur geleden`;
  return `${Math.round(s / 86400)} dagen geleden`;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

export const TRADER_COLORS = {
  prapor: "#d08a4a",
  therapist: "#db7a9b",
  fence: "#9aa0a6",
  skier: "#5b9ae0",
  peacekeeper: "#45c1b2",
  mechanic: "#e6c24f",
  ragman: "#a77be0",
  jaeger: "#79b85a",
  ref: "#e06464",
  lightkeeper: "#f1e6a2",
  "btr driver": "#8fa6bb",
};
export function traderColor(name) {
  return TRADER_COLORS[String(name ?? "").toLowerCase()] ?? "#9aa0a6";
}

export const KIND_LABEL = {
  handover: "Inleveren",
  find: "Vinden",
  questitem: "Quest-item",
  required: "Meenemen",
  key: "Sleutel",
  plant: "Plaatsen",
  mark: "Markeren",
  use: "Gebruiken",
  build: "Bouwen",
  sell: "Verkopen",
  other: "Overig",
};

export function itemIcon(item, cls = "") {
  if (item?.icon) return html`<img class="icon-img ${cls}" src="${item.icon}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  return html`<span class="icon-ph ${cls}"></span>`;
}

export function openLightbox(src, caption) {
  const box = document.getElementById("lightbox");
  box.innerHTML = String(html`<div><img src="${src}" alt="" referrerpolicy="no-referrer"><div class="cap">${caption ?? ""}</div></div>`);
  box.hidden = false;
  box.onclick = () => (box.hidden = true);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.getElementById("lightbox").hidden = true;
});
