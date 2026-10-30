import { store, go, dataPath } from "../app.js";
import { html, norm, rub, debounce } from "../util.js";

const PREF_KEY = "tarkov-helper-ammo";
const GROUP_ORDER = ["Pistool", "PDW", "Geweer", "Marksman", "Shotgun", "Overig"];
const MAX_COMPARE = 3; // the categorical palette validates all-pairs for 3 slots only
const CLASSES = [1, 2, 3, 4, 5, 6];
const EFFECT = [
  { min: 10, label: "Goed", cls: "eff-good" },
  { min: 0, label: "Ok", cls: "eff-ok" },
  { min: -10, label: "Matig", cls: "eff-poor" },
  { min: -Infinity, label: "Nee", cls: "eff-none" },
];

let root;
let data = null;
let state = { selected: ["Caliber762x39"], slots: { Caliber762x39: 1 }, sort: "pen", dir: -1, search: "", highlight: null };
let resizeObs = null;

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREF_KEY) ?? "null");
    if (saved?.selected?.length) Object.assign(state, { selected: saved.selected, slots: saved.slots ?? {}, sort: saved.sort ?? "pen", dir: saved.dir ?? -1 });
  } catch {
    /* ignore */
  }
}
function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ selected: state.selected, slots: state.slots, sort: state.sort, dir: state.dir }));
  } catch {
    /* ignore */
  }
}

export const totalDamage = (a) => a.damage * (a.projectiles || 1);
export function tierOf(pen) {
  if (pen >= 60) return "S";
  if (pen >= 50) return "A";
  if (pen >= 40) return "B";
  if (pen >= 30) return "C";
  if (pen >= 20) return "D";
  return "F";
}
/** Rule of thumb: armor class N ≈ armor value N×10; compare with penetration. */
function effect(pen, cls) {
  return EFFECT.find((e) => pen - cls * 10 >= e.min);
}

export async function mount(el, route) {
  root = el;
  loadPrefs();
  el.innerHTML = `<div class="page"><div class="loading">Ammo laden…</div></div>`;
  if (!store.ammo) {
    const res = await fetch(dataPath("ammo.json"), { cache: "no-cache" });
    if (!res.ok) {
      el.innerHTML = `<div class="empty">Nog geen ammo-data. Draai een sync via de pagina Data.</div>`;
      return;
    }
    store.ammo = await res.json();
  }
  data = store.ammo;
  data.calById = new Map(data.calibers.map((c) => [c.id, c]));
  state.selected = state.selected.filter((id) => data.calById.has(id));
  if (!state.selected.length) select("Caliber762x39", false);

  const groups = GROUP_ORDER.map((g) => ({ g, cals: data.calibers.filter((c) => c.group === g).sort((a, b) => a.name.localeCompare(b.name, "nl", { numeric: true })) })).filter((x) => x.cals.length);
  el.innerHTML = String(html`
    <div class="page">
      <div class="page-head ammo-head">
        <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;width:100%">
          <h2>Ammo</h2>
          <input class="input" id="a-search" type="search" placeholder="Zoek kogel in alle kalibers…" style="max-width:280px" value="${state.search}">
          <span class="muted" style="font-size:12px">Klik een kaliber · Shift-klik om tot ${MAX_COMPARE} kalibers te vergelijken</span>
        </div>
        <div class="cal-groups" id="a-cals">
          ${groups.map(({ g, cals }) => html`<div class="cal-group"><span class="cal-label">${g}</span>${cals.map((c) => html`<button class="chip" data-cal="${c.id}" data-name="${c.name}">${c.name}</button>`)}</div>`)}
        </div>
      </div>
      <div class="page-body scroll" id="a-body">
        <div class="card">
          <div class="chart-head">
            <div><h3 id="a-title" style="margin:0"></h3><div class="muted" id="a-sub" style="font-size:12px"></div></div>
            <div class="legend" id="a-legend"></div>
          </div>
          <div class="chart-wrap" id="a-chart"></div>
        </div>
        <div class="card">
          <h3 id="a-table-title">Tabel</h3>
          <div style="overflow-x:auto"><table class="agg-table ammo-table" id="a-table"></table></div>
          <p class="faint" style="font-size:12px;margin:10px 0 0">Tier en klasse-kolommen zijn een vuistregel: penetratie vergeleken met armor-klasse × 10, zonder rekening te houden met de durability van de armor. Stats uit de game-data (json.tarkov.dev).</p>
        </div>
      </div>
    </div>`);

  el.querySelector("#a-cals").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cal]");
    if (!b) return;
    select(b.dataset.cal, e.shiftKey);
    go(`#/ammo/${encodeURIComponent(state.selected[0])}`);
    render();
  });
  el.querySelector("#a-search").addEventListener("input", debounce((e) => {
    state.search = e.target.value;
    renderTable();
  }, 120));
  el.querySelector("#a-table").addEventListener("click", (e) => {
    const th = e.target.closest("[data-sort]");
    if (th) {
      if (state.sort === th.dataset.sort) state.dir *= -1;
      else Object.assign(state, { sort: th.dataset.sort, dir: th.dataset.sort === "name" ? 1 : -1 });
      savePrefs();
      renderTable();
      return;
    }
    const cal = e.target.closest("[data-pick-cal]");
    if (cal) {
      select(cal.dataset.pickCal, false);
      state.search = "";
      el.querySelector("#a-search").value = "";
      go(`#/ammo/${encodeURIComponent(cal.dataset.pickCal)}`);
      render();
    }
  });
  resizeObs = new ResizeObserver(debounce(() => renderChart(), 80));
  resizeObs.observe(el.querySelector("#a-chart"));
  update(route);
}

export function unmount() {
  resizeObs?.disconnect();
  resizeObs = null;
}

export function update(route) {
  if (!data) return;
  if (route.param && data.calById.has(route.param) && !state.selected.includes(route.param)) select(route.param, false);
  render();
}

/** Single click replaces the selection; shift adds/removes. Each caliber keeps its color slot while selected. */
function select(id, add) {
  if (!add) {
    state.selected = [id];
    state.slots = { [id]: 1 };
  } else if (state.selected.includes(id)) {
    if (state.selected.length > 1) {
      state.selected = state.selected.filter((x) => x !== id);
      delete state.slots[id];
    }
  } else if (state.selected.length < MAX_COMPARE) {
    const used = new Set(Object.values(state.slots));
    state.slots[id] = [1, 2, 3].find((s) => !used.has(s));
    state.selected = [...state.selected, id];
  }
  state.highlight = null;
  savePrefs();
}

function rounds() {
  return data.ammo.filter((a) => state.selected.includes(a.caliber));
}

function render() {
  for (const b of root.querySelectorAll("[data-cal]")) {
    const on = state.selected.includes(b.dataset.cal);
    b.classList.toggle("on", on);
    const name = escapeXml(b.dataset.name);
    b.innerHTML = on && state.selected.length > 1 ? `<span class="dot" style="background:var(--series-${state.slots[b.dataset.cal]})"></span>${name}` : name;
  }
  const cals = state.selected.map((id) => data.calById.get(id));
  root.querySelector("#a-title").textContent = `${cals.map((c) => c.name).join(" vs ")}: penetratie vs damage`;
  root.querySelector("#a-sub").textContent = `${rounds().length} soorten · lijnen = armor-klasse (penetratie ≥ klasse × 10 gaat er meestal doorheen)`;
  root.querySelector("#a-legend").innerHTML = cals.length > 1
    ? cals.map((c) => `<span class="legend-item"><span class="dot" style="background:var(--series-${state.slots[c.id]})"></span>${escapeXml(c.name)}</span>`).join("")
    : "";
  renderChart();
  renderTable();
}

// ---------------------------------------------------------------------------
// Chart (hand-built SVG scatter)
// ---------------------------------------------------------------------------

function niceStep(range, target) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
}

function renderChart() {
  const wrap = root?.querySelector("#a-chart");
  if (!wrap || !data) return;
  const list = rounds();
  const W = Math.max(320, wrap.clientWidth);
  const H = 460;
  const m = { l: 46, r: 70, t: 14, b: 44 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;

  const dmg = list.map(totalDamage);
  const xStep = niceStep(Math.max(...dmg) - Math.min(...dmg) + 20, 8);
  const x0 = Math.max(0, Math.floor((Math.min(...dmg) - xStep / 2) / xStep) * xStep);
  const x1 = Math.ceil((Math.max(...dmg) + xStep / 2) / xStep) * xStep;
  const y1 = Math.max(70, Math.ceil((Math.max(...list.map((a) => a.pen)) + 6) / 10) * 10);
  const sx = (v) => m.l + ((v - x0) / (x1 - x0)) * pw;
  const sy = (v) => m.t + ph - (v / y1) * ph;

  const xTicks = [];
  for (let v = x0; v <= x1 + 1e-9; v += xStep) xTicks.push(v);
  const yTicks = [];
  for (let v = 0; v <= y1; v += 10) yTicks.push(v);

  // points + label placement (labels that can't be placed without overlap are left to the tooltip/table)
  const pts = list.map((a) => ({ a, x: sx(totalDamage(a)), y: sy(a.pen), slot: state.slots[a.caliber] ?? 1 }));
  const boxes = pts.map((p) => ({ x: p.x - 7, y: p.y - 7, w: 14, h: 14 }));
  const overlaps = (b) => boxes.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y);
  const inPlot = (b) => b.x >= m.l && b.x + b.w <= m.l + pw + m.r - 4 && b.y >= m.t - 2 && b.y + b.h <= m.t + ph;
  const labels = [];
  for (const p of [...pts].sort((a, b) => b.a.pen - a.a.pen)) {
    const text = p.a.shortName;
    const w = text.length * 7 + 4;
    const h = 13;
    const cands = [
      { x: p.x + 9, y: p.y - h / 2, anchor: "start" },
      { x: p.x - 9 - w, y: p.y - h / 2, anchor: "end" },
      { x: p.x - w / 2, y: p.y - 9 - h, anchor: "middle" },
      { x: p.x - w / 2, y: p.y + 9, anchor: "middle" },
      { x: p.x + 7, y: p.y - h - 4, anchor: "start" },
      { x: p.x + 7, y: p.y + 4, anchor: "start" },
    ];
    const spot = cands.map((c) => ({ ...c, w, h })).find((b) => inPlot(b) && !overlaps(b));
    if (!spot) continue;
    boxes.push(spot);
    const tx = spot.anchor === "start" ? spot.x + 2 : spot.anchor === "end" ? spot.x + w - 2 : spot.x + w / 2;
    labels.push(`<text x="${tx.toFixed(1)}" y="${(spot.y + h - 3).toFixed(1)}" text-anchor="${spot.anchor}" class="pt-label">${escapeXml(text)}</text>`);
  }

  wrap.innerHTML = `
    <svg class="scatter" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Penetratie tegen damage per kogel">
      ${yTicks.map((v) => `<line class="${v > 0 && v <= 60 ? "grid class-line" : "grid"}" x1="${m.l}" x2="${m.l + pw}" y1="${sy(v)}" y2="${sy(v)}"/>
        <text class="tick" x="${m.l - 8}" y="${sy(v) + 4}" text-anchor="end">${v}</text>
        ${v > 0 && v <= 60 ? `<text class="class-label" x="${m.l + pw + 8}" y="${sy(v) + 4}">Klasse ${v / 10}</text>` : ""}`).join("")}
      ${xTicks.map((v) => `<line class="tickmark" x1="${sx(v)}" x2="${sx(v)}" y1="${m.t + ph}" y2="${m.t + ph + 5}"/><text class="tick" x="${sx(v)}" y="${m.t + ph + 19}" text-anchor="middle">${v}</text>`).join("")}
      <line class="axis" x1="${m.l}" x2="${m.l + pw}" y1="${m.t + ph}" y2="${m.t + ph}"/>
      <text class="axis-title" x="${m.l + pw / 2}" y="${H - 6}" text-anchor="middle">Damage per schot (hagel: pellets × damage)</text>
      <text class="axis-title" transform="translate(13 ${m.t + ph / 2}) rotate(-90)" text-anchor="middle">Penetratie</text>
      ${labels.join("")}
      ${pts.map((p, i) => `<circle class="pt ${state.highlight === p.a.id ? "hl" : ""}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${state.highlight === p.a.id ? 7 : 5}" style="fill:var(--series-${p.slot})" data-i="${i}"/>`).join("")}
      ${pts.map((p, i) => `<circle class="hit" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="12" data-i="${i}" tabindex="0" aria-label="${escapeXml(`${p.a.name}: damage ${totalDamage(p.a)}, penetratie ${p.a.pen}`)}"/>`).join("")}
    </svg>
    <div class="chart-tip" id="a-tip" hidden></div>`;

  const svg = wrap.querySelector("svg");
  const tip = wrap.querySelector("#a-tip");
  const show = (i) => {
    const p = pts[i];
    if (!p) return;
    tip.innerHTML = tooltip(p.a);
    tip.hidden = false;
    const scale = svg.getBoundingClientRect().width / W;
    const left = p.x * scale;
    const top = p.y * scale;
    tip.style.left = `${Math.min(left + 14, wrap.clientWidth - tip.offsetWidth - 4)}px`;
    tip.style.top = `${Math.max(0, top - tip.offsetHeight / 2)}px`;
    if (left + 14 + tip.offsetWidth > wrap.clientWidth) tip.style.left = `${Math.max(0, left - tip.offsetWidth - 14)}px`;
    svg.querySelectorAll(".pt.hover").forEach((c) => c.classList.remove("hover"));
    svg.querySelector(`.pt[data-i="${i}"]`)?.classList.add("hover");
  };
  const hide = () => {
    tip.hidden = true;
    svg.querySelectorAll(".pt.hover").forEach((c) => c.classList.remove("hover"));
  };
  // nearest point within 24px of the cursor, so small dots don't need pixel-perfect aim
  svg.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const scale = r.width / W;
    const mx = (e.clientX - r.left) / scale;
    const my = (e.clientY - r.top) / scale;
    let best = -1;
    let bestD = 24 / scale;
    pts.forEach((p, i) => {
      const d = Math.hypot(p.x - mx, p.y - my);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) show(best);
    else hide();
  });
  svg.addEventListener("mouseleave", hide);
  svg.addEventListener("focusin", (e) => e.target.dataset.i && show(Number(e.target.dataset.i)));
  svg.addEventListener("focusout", hide);
  svg.addEventListener("click", (e) => {
    const hit = e.target.closest(".hit");
    if (!hit) return;
    state.highlight = pts[Number(hit.dataset.i)].a.id;
    renderChart();
    renderTable();
    root.querySelector(`tr[data-ammo="${CSS.escape(state.highlight)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

function escapeXml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

const signedPct = (v) => (v ? `${v > 0 ? "+" : ""}${Math.round(v * 100)}%` : "0");

function cheapestTrader(a) {
  return [...a.traders].sort((x, y) => (x.level ?? 9) - (y.level ?? 9) || x.priceRUB - y.priceRUB)[0] ?? null;
}

function tooltip(a) {
  const cal = data.calById.get(a.caliber);
  const t = cheapestTrader(a);
  return String(html`
    <div class="tt-title">${a.name}</div>
    <div class="tt-sub">${cal?.name ?? ""} · tier ${tierOf(a.pen)}</div>
    <table class="tt">
      <tr><td>Damage</td><td>${a.projectiles > 1 ? `${a.projectiles} × ${a.damage} = ${totalDamage(a)}` : a.damage}</td></tr>
      <tr><td>Penetratie</td><td>${a.pen}</td></tr>
      <tr><td>Armor damage</td><td>${a.armorDamage}%</td></tr>
      <tr><td>Fragmentatie</td><td>${Math.round(a.frag * 100)}%</td></tr>
      <tr><td>Snelheid</td><td>${a.speed} m/s${a.subsonic ? " (subsonic)" : ""}</td></tr>
      <tr><td>Recoil / accuracy</td><td>${signedPct(a.recoil)} / ${signedPct(a.accuracy)}</td></tr>
      <tr><td>Te koop</td><td>${t ? `${t.trader} LL${t.level}${t.quest ? " na quest" : ""}` : "niet bij handelaren"}</td></tr>
      <tr><td>Flea</td><td>${a.fleaBanned ? "geen flea" : a.avg24h ? rub(a.avg24h) : "–"}</td></tr>
    </table>
    ${a.tracer ? html`<div class="tt-sub">Tracer</div>` : ""}`);
}

// ---------------------------------------------------------------------------
// Table (the chart's accessible twin, and the search-across-calibers view)
// ---------------------------------------------------------------------------

const COLUMNS = [
  { key: "name", label: "Kogel", get: (a) => a.name },
  { key: "tier", label: "Tier", get: (a) => a.pen },
  { key: "damage", label: "Damage", get: totalDamage },
  { key: "pen", label: "Pen", get: (a) => a.pen },
  { key: "armorDamage", label: "Armor dmg", get: (a) => a.armorDamage },
  { key: "frag", label: "Frag", get: (a) => a.frag },
  { key: "speed", label: "m/s", get: (a) => a.speed },
  { key: "recoil", label: "Recoil", get: (a) => a.recoil },
];

function renderTable() {
  const table = root?.querySelector("#a-table");
  if (!table) return;
  const terms = norm(state.search).split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  let list = searching
    ? data.ammo.filter((a) => terms.every((t) => norm(`${a.name} ${a.shortName} ${data.calById.get(a.caliber)?.name}`).includes(t)))
    : rounds();
  const col = COLUMNS.find((c) => c.key === state.sort) ?? COLUMNS[3];
  list = [...list].sort((a, b) => {
    const va = col.get(a);
    const vb = col.get(b);
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * state.dir;
  });
  const showCal = searching || state.selected.length > 1;
  root.querySelector("#a-table-title").textContent = searching ? `Zoekresultaten (${list.length})` : `Tabel (${list.length})`;
  const arrow = (k) => (state.sort === k ? (state.dir < 0 ? " ▾" : " ▴") : "");
  table.innerHTML = String(html`
    <thead><tr>
      ${COLUMNS.map((c) => html`<th data-sort="${c.key}">${c.label}${arrow(c.key)}</th>`)}
      ${CLASSES.map((c) => html`<th title="Effectiviteit tegen armor-klasse ${c}">K${c}</th>`)}
      <th>Te koop</th><th>Flea</th>
    </tr></thead>
    <tbody>${list.map((a) => row(a, showCal))}</tbody>`);
}

function row(a, showCal) {
  const cal = data.calById.get(a.caliber);
  const t = cheapestTrader(a);
  return html`<tr data-ammo="${a.id}" class="${state.highlight === a.id ? "hl-row" : ""}">
    <td>
      <div class="iname">
        ${a.icon ? html`<img class="icon-img sm" src="${a.icon}" alt="" loading="lazy" referrerpolicy="no-referrer">` : html`<span class="icon-ph sm"></span>`}
        <div class="names">
          ${a.wiki ? html`<a href="${a.wiki}" target="_blank" rel="noopener" style="color:var(--text)">${a.name}</a>` : a.name}
          <span class="alt">
            ${showCal ? html`<button class="linklike" data-pick-cal="${a.caliber}">${state.selected.length > 1 && state.slots[a.caliber] ? html`<span class="dot" style="background:var(--series-${state.slots[a.caliber]})"></span> ` : ""}${cal?.name}</button>` : ""}
            ${a.tracer ? html`<span class="chip">tracer</span>` : ""}${a.subsonic ? html`<span class="chip">subsonic</span>` : ""}
          </span>
        </div>
      </div>
    </td>
    <td><span class="tier tier-${tierOf(a.pen)}">${tierOf(a.pen)}</span></td>
    <td class="num">${a.projectiles > 1 ? html`<span class="faint">${a.projectiles}×${a.damage} =</span> ` : ""}${totalDamage(a)}</td>
    <td class="num"><b>${a.pen}</b></td>
    <td class="num">${a.armorDamage}%</td>
    <td class="num">${Math.round(a.frag * 100)}%</td>
    <td class="num">${a.speed}</td>
    <td class="num">${signedPct(a.recoil)}</td>
    ${CLASSES.map((c) => {
      const e = effect(a.pen, c);
      return html`<td><span class="eff ${e.cls}">${e.label}</span></td>`;
    })}
    <td class="trader-cell">${t ? html`${t.trader} LL${t.level}${t.quest ? html`<div class="faint">na <a href="#/quests/${encodeURIComponent(t.questId ?? "")}">${t.quest}</a></div>` : ""}` : html`<span class="faint">–</span>`}</td>
    <td class="price">${a.fleaBanned ? "geen flea" : a.avg24h ? rub(a.avg24h) : "–"}</td>
  </tr>`;
}
