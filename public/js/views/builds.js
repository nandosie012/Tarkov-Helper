import { store, go, dataPath } from "../app.js";
import { html, norm, rub, debounce } from "../util.js";

const PREF_KEY = "tarkov-helper-builds";
const CLASS_ORDER = ["Assault rifle", "Assault carbine", "SMG", "Marksman rifle", "Sniper rifle", "Machinegun", "Shotgun", "Handgun", "Revolver", "Overig"];

let root;
let data = null;
let state = { id: null, search: "", cls: "", pick: "meta" };

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}");
    state = { ...state, search: saved.search ?? "", cls: saved.cls ?? "", pick: saved.pick ?? "meta" };
  } catch {
    /* ignore */
  }
}
function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ search: state.search, cls: state.cls, pick: state.pick }));
  } catch {
    /* ignore */
  }
}

async function getJson(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

export async function mount(el, route) {
  root = el;
  loadPrefs();
  el.innerHTML = `<div class="loading">Builds laden…</div>`;
  try {
    store.builds ??= await getJson(dataPath("builds.json"));
    store.ammo ??= await getJson(dataPath("ammo.json")).catch(() => null);
  } catch {
    el.innerHTML = `<div class="empty">Nog geen build-data. Draai een sync via de pagina Data.</div>`;
    return;
  }
  data = store.builds;
  data.byId ??= new Map(data.weapons.map((w) => [w.id, w]));
  const classes = CLASS_ORDER.filter((c) => data.weapons.some((w) => w.category === c));

  el.innerHTML = String(html`
    <div class="split">
      <aside class="sidebar">
        <div class="filters">
          <input class="input" id="b-search" type="search" placeholder="Zoek wapen…" value="${state.search}">
          <div class="filter-row" id="b-classes">
            <button class="chip ${state.cls ? "" : "on"}" data-cls="">Alle</button>
            ${classes.map((c) => html`<button class="chip ${state.cls === c ? "on" : ""}" data-cls="${c}">${c}</button>`)}
          </div>
        </div>
        <div class="list-count" id="b-count"></div>
        <div class="list scroll" id="b-list"></div>
      </aside>
      <section class="detail scroll" id="b-detail"></section>
    </div>`);

  el.querySelector("#b-search").addEventListener("input", debounce((e) => {
    state.search = e.target.value;
    savePrefs();
    renderList();
  }, 120));
  el.querySelector("#b-classes").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cls]");
    if (!b) return;
    state.cls = b.dataset.cls;
    for (const c of el.querySelectorAll("#b-classes .chip")) c.classList.toggle("on", c === b);
    savePrefs();
    renderList();
  });
  el.querySelector("#b-list").addEventListener("click", (e) => {
    const row = e.target.closest("[data-id]");
    if (row) go(`#/builds/${encodeURIComponent(row.dataset.id)}`);
  });
  el.querySelector("#b-detail").addEventListener("click", (e) => {
    const pick = e.target.closest("[data-pick]");
    if (pick) {
      state.pick = pick.dataset.pick;
      savePrefs();
      renderDetail(false);
      return;
    }
    // a tile on the parts board: jump to its row in the table
    const hit = e.target.closest("[data-tile]");
    if (hit) {
      const idx = hit.dataset.tile;
      const row = el.querySelector(`.parts-table tr[data-row="${idx}"]`);
      if (!row) return;
      for (const r of el.querySelectorAll(".parts-table tr.flash")) r.classList.remove("flash");
      for (const t of el.querySelectorAll(".tile.on")) t.classList.remove("on");
      el.querySelector(`.tile[data-tile="${idx}"]`)?.classList.add("on");
      row.classList.add("flash");
      row.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  });
  update(route);
}

export function update(route) {
  if (!data) return;
  state.id = route.param && data.byId.has(route.param) ? route.param : state.id ?? filtered()[0]?.id ?? null;
  renderList();
  renderDetail(true);
}

function filtered() {
  const terms = norm(state.search).split(/\s+/).filter(Boolean);
  return data.weapons.filter((w) => {
    if (state.cls && w.category !== state.cls) return false;
    const hay = norm(`${w.name} ${w.shortName} ${w.category} ${caliberName(w.caliber)}`);
    return terms.every((t) => hay.includes(t));
  });
}

function caliberName(code) {
  return store.ammo?.calibers.find((c) => c.id === code)?.name ?? (code ?? "").replace(/^Caliber/, "");
}

function renderList() {
  const list = filtered();
  root.querySelector("#b-count").innerHTML = String(html`<span>${list.length} wapens</span><span class="faint">meta: verticale recoil · ergo</span>`);
  const groups = CLASS_ORDER.map((c) => [c, list.filter((w) => w.category === c)]).filter(([, l]) => l.length);
  root.querySelector("#b-list").innerHTML = list.length
    ? groups.map(([c, ws]) => String(html`
        <div class="trader-group">${c}<span class="faint">${ws.length}</span></div>
        ${ws.map((w) => html`<div class="qrow wrow ${state.id === w.id ? "active" : ""}" data-id="${w.id}">
          ${w.icon ? html`<img class="icon-img sm" src="${w.icon}" alt="" loading="lazy" referrerpolicy="no-referrer">` : html`<span class="icon-ph sm"></span>`}
          <div style="min-width:0"><div class="qtitle">${w.name}</div><div class="qmeta">${caliberName(w.caliber)}</div></div>
          <span class="wstat">${w.meta ? html`${w.meta.recoilV} · ${w.meta.ergo}` : "–"}</span>
        </div>`)}`)).join("")
    : `<div class="empty">Geen wapens gevonden.</div>`;
  root.querySelector("#b-list .qrow.active")?.scrollIntoView({ block: "nearest" });
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function buildFor(w, pick) {
  return pick === "meta" ? w.meta : w.budget[pick] ?? null;
}

function renderDetail(resetScroll) {
  const pane = root.querySelector("#b-detail");
  const w = data.byId.get(state.id);
  if (!w) {
    pane.innerHTML = `<div class="empty">Kies een wapen.</div>`;
    return;
  }
  const pick = state.pick === "meta" || data.caps.includes(Number(state.pick)) ? state.pick : "meta";
  const build = buildFor(w, pick === "meta" ? "meta" : Number(pick));
  const ref = w.default ?? { recoilV: w.base.recoilV, ergo: w.base.ergo };

  pane.innerHTML = String(html`
    <div class="detail-inner">
      <div class="q-head">
        ${w.preview || w.image ? html`<figure class="weapon-preview">
          <img src="${w.preview || w.image}" alt="${w.name}" referrerpolicy="no-referrer" onerror="this.parentElement.remove()">
          <figcaption>${w.default ? "Standaardwapen" : "Kaal wapen"}</figcaption>
        </figure>` : ""}
        <div style="flex:1;min-width:0">
          <h1>${w.name}</h1>
          <div class="q-sub">
            <span class="chip">${w.category}</span>
            ${w.caliber ? html`<a class="chip map" href="#/ammo/${encodeURIComponent(w.caliber)}">${caliberName(w.caliber)}</a>` : ""}
            ${w.fireRate ? html`<span>${w.fireRate} rpm</span>` : ""}
            <span>· kaal: verticaal ${w.base.recoilV}, ergo ${w.base.ergo}</span>
          </div>
          <div class="q-actions">
            ${w.wiki ? html`<a class="btn" href="${w.wiki}" target="_blank" rel="noopener">Wiki ↗</a>` : ""}
            ${w.caliber ? html`<a class="btn" href="#/ammo/${encodeURIComponent(w.caliber)}">Ammo voor ${caliberName(w.caliber)}</a>` : ""}
          </div>
        </div>
      </div>

      <div class="card">
        <h3>Recoil per build <span class="count">klik een balk om die build te tonen</span></h3>
        ${recoilLadder(w, pick)}
      </div>

      <div class="card highlight">
        <div class="chart-head">
          <h3 style="margin:0">${pick === "meta" ? "Meta-build" : `Budget-build (≤ ${rub(Number(pick))} aan onderdelen)`}</h3>
          <div class="filter-row">
            ${data.caps.map((c) => html`<button class="chip ${String(c) === String(pick) ? "on" : ""}" data-pick="${c}">≤ ${Math.round(c / 1000)}k</button>`)}
            <button class="chip ${pick === "meta" ? "on" : ""}" data-pick="meta">Meta</button>
          </div>
        </div>
        ${build ? html`
          <div class="stat-row" style="margin:10px 0 14px">
            ${statTile("Verticale recoil", build.recoilV, ref.recoilV, true)}
            ${statTile("Horizontale recoil", build.recoilH, ref.recoilH, true)}
            ${statTile("Ergonomie", build.ergo, ref.ergo, false)}
            <div class="stat"><b>${rub(build.cost)}</b><span>Onderdelen</span></div>
            <div class="stat"><b>${w.offer ? rub(w.offer.price) : "–"}</b><span>Wapen (kaal)${w.offer ? ` · ${w.offer.source}` : ""}</span></div>
          </div>
          ${partsBoard(w, build)}
          ${partsTable(build)}
          <p class="faint" style="font-size:12px;margin:10px 0 0">Vergeleken met ${w.default ? "het standaardwapen" : "het kale wapen"}. Optiek, tactische apparaten en magazijn zijn naar keuze en niet meegerekend.</p>`
        : html`<p class="muted">Geen werkende build binnen dit budget: de verplichte onderdelen kosten samen meer. Kies een hoger budget.</p>`}
      </div>

      ${w.traderPresets.length ? html`
        <div class="card">
          <h3>Kant-en-klaar te koop <span class="count">presets bij handelaren</span></h3>
          <div class="table-scroll"><table class="itable">
            <thead><tr><th>Preset</th><th>Verticaal</th><th>Horizontaal</th><th>Ergo</th><th>Te koop</th></tr></thead>
            <tbody>${w.traderPresets.map((p) => html`<tr>
              <td>${p.name}</td>
              <td class="num">${p.recoilV ?? "–"}</td><td class="num">${p.recoilH ?? "–"}</td><td class="num">${p.ergo ?? "–"}</td>
              <td class="price">${p.offer ? html`${p.offer.source}${p.offer.level ? ` LL${p.offer.level}` : ""}${p.offer.quest ? " (na quest)" : ""} · ${rub(p.offer.price)}` : "–"}</td>
            </tr>`)}</tbody>
          </table></div>
        </div>` : ""}

      ${ammoCard(w)}

      <div class="attrib">
        Berekend uit de game-data (json.tarkov.dev): per onderdeel recoil-modifier en ergonomie, met de goedkoopste aankoopoptie (flea gemiddeld 24 uur of handelaar).
        Meta = laagste recoil met goede ergonomie; budget = het beste binnen het gekozen bedrag. Conflicterende onderdelen worden vermeden. Geen community-builds: check de build even in de game.
      </div>
    </div>`);
  wireLadder(pane);
  if (resetScroll) pane.scrollTop = 0;
}

function statTile(label, value, ref, lowerIsBetter) {
  const diff = ref ? Math.round(((value - ref) / ref) * 100) : 0;
  const better = lowerIsBetter ? diff < 0 : diff > 0;
  return html`<div class="stat"><b>${value}</b><span>${label}${ref != null && diff !== 0 ? html` · <em class="${better ? "delta-good" : "delta-bad"}">${diff > 0 ? "+" : ""}${diff}%</em>` : ""}</span></div>`;
}

const fmtRecoil = (r) => `${r > 0 ? "+" : ""}${Math.round(r * 1000) / 10}%`;
const fmtErgo = (e) => `${e > 0 ? "+" : ""}${Math.round(e * 10) / 10}`;

/** One image tile per mounted part, in the same order as the parts table. */
function partsBoard(w, build) {
  if (!build.parts.length) return "";
  const parents = [];
  const tiles = build.parts.map((p, i) => {
    parents[p.depth] = p;
    const parent = p.depth ? parents[p.depth - 1] : null;
    return { p, i, parent, it: data.parts[p.id] ?? {} };
  });
  return html`<div class="board">
    <div class="board-tiles">${tiles.map(({ p, i, parent, it }) => html`
      <button class="tile" data-tile="${i}" title="${it.name}">
        <span class="tile-img">${it.image || it.icon ? html`<img src="${it.image || it.icon}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}</span>
        <span class="tile-slot">${p.slot}${parent ? html` <span class="faint">· op ${data.parts[parent.id]?.shortName || parent.slot}</span>` : ""}</span>
        <span class="tile-name">${it.shortName || it.name}</span>
        <span class="tile-stats">${p.recoil ? fmtRecoil(p.recoil) : "0%"} recoil · ${p.ergo ? fmtErgo(p.ergo) : "0"} ergo</span>
      </button>`)}
    </div>
    <p class="faint board-note">Onderdelen van deze build. Klik een onderdeel voor de details in de tabel.</p>
  </div>`;
}

function partsTable(build) {
  return html`<div class="table-scroll"><table class="itable parts-table">
    <thead><tr><th>Slot</th><th>Onderdeel</th><th>Recoil</th><th>Ergo</th><th>Kopen</th></tr></thead>
    <tbody>${build.parts.map((p, i) => {
      const it = data.parts[p.id] ?? {};
      return html`<tr data-row="${i}">
        <td class="slot-cell" style="padding-left:${8 + p.depth * 16}px">${p.depth ? html`<span class="faint">└ </span>` : ""}${p.slot}</td>
        <td><div class="iname">${it.icon ? html`<img class="icon-img sm" src="${it.icon}" alt="" loading="lazy" referrerpolicy="no-referrer">` : html`<span class="icon-ph sm"></span>`}
          ${it.wiki ? html`<a href="${it.wiki}" target="_blank" rel="noopener" style="color:var(--text)">${it.name}</a>` : it.name}</div></td>
        <td class="num">${p.recoil ? fmtRecoil(p.recoil) : html`<span class="faint">0</span>`}</td>
        <td class="num">${p.ergo ? fmtErgo(p.ergo) : html`<span class="faint">0</span>`}</td>
        <td class="price">${p.stock ? html`<span title="Niet los te koop: zit op het standaardwapen">standaard</span>` : html`${p.source}${p.level ? ` LL${p.level}` : ""}${p.quest ? " (na quest)" : ""}`} · ${rub(p.price)}</td>
      </tr>`;
    })}</tbody>
  </table></div>`;
}

/** Horizontal bars: vertical recoil for the bare gun, stock preset, each budget and meta. Shorter is better. */
function recoilLadder(w, pick) {
  const rows = [
    { key: "base", label: "Kaal wapen", b: { recoilV: w.base.recoilV, ergo: w.base.ergo, cost: 0 }, select: null },
    ...(w.default ? [{ key: "default", label: "Standaard", b: { recoilV: w.default.recoilV, ergo: w.default.ergo, cost: w.default.offer?.price ?? null }, select: null }] : []),
    ...data.caps.map((c) => ({ key: String(c), label: `Budget ≤ ${Math.round(c / 1000)}k`, b: w.budget[c], select: String(c) })),
    { key: "meta", label: "Meta", b: w.meta, select: "meta" },
  ];
  const max = Math.max(...rows.map((r) => r.b?.recoilV ?? 0));
  return html`<div class="ladder">${rows.map((r) => {
    const on = r.select && r.select === String(pick);
    const tip = r.b ? `Verticaal ${r.b.recoilV} · ergo ${r.b.ergo}${r.b.cost != null && r.key !== "base" ? ` · ${rub(r.b.cost)}${r.key === "default" ? " (preset)" : " onderdelen"}` : ""}` : "Niet mogelijk binnen dit budget";
    return html`<${r.select ? "button" : "div"} class="ladder-row ${on ? "on" : ""} ${r.select ? "pickable" : ""}" ${r.select ? html`data-pick="${r.select}"` : ""} data-tip="${tip}">
      <span class="ladder-label">${r.label}</span>
      <span class="ladder-track">${r.b ? html`<span class="ladder-bar" style="width:${((r.b.recoilV / max) * 100).toFixed(1)}%"></span><span class="ladder-val">${r.b.recoilV}</span><span class="ladder-ergo">ergo ${r.b.ergo}</span>` : html`<span class="faint" style="font-size:12px">niet mogelijk</span>`}</span>
      <span class="ladder-cost">${r.b && r.key !== "base" && r.b.cost != null ? rub(r.b.cost) : ""}</span>
    </${r.select ? "button" : "div"}>`;
  })}</div><div class="chart-tip" id="ladder-tip" hidden></div>`;
}

function wireLadder(pane) {
  const tip = pane.querySelector("#ladder-tip");
  const ladder = pane.querySelector(".ladder");
  if (!tip || !ladder) return;
  const card = ladder.parentElement;
  card.style.position = "relative";
  const show = (row) => {
    tip.textContent = row.dataset.tip;
    tip.hidden = false;
    const r = row.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    tip.style.left = `${Math.min(r.left - c.left + 140, c.width - tip.offsetWidth - 8)}px`;
    tip.style.top = `${r.bottom - c.top + 4}px`;
  };
  for (const row of ladder.querySelectorAll(".ladder-row")) {
    row.addEventListener("mouseenter", () => show(row));
    row.addEventListener("focus", () => show(row));
    row.addEventListener("mouseleave", () => (tip.hidden = true));
    row.addEventListener("blur", () => (tip.hidden = true));
  }
}

function ammoCard(w) {
  const rounds = store.ammo?.ammo.filter((a) => a.caliber === w.caliber) ?? [];
  if (!rounds.length) return "";
  const byPen = [...rounds].sort((a, b) => b.pen - a.pen);
  const traderOk = (a) => a.traders.some((t) => !t.quest);
  const best = byPen[0];
  const bestTrader = byPen.find(traderOk);
  const cheap = byPen.find((a) => traderOk(a) && Math.min(...a.traders.filter((t) => !t.quest).map((t) => t.priceRUB)) <= 400);
  const picks = [
    ["Hoogste penetratie", best],
    ["Beste bij handelaren", bestTrader],
    ["Budget (≤ 400 ₽ per kogel)", cheap],
  ].filter(([, a], i, all) => a && all.findIndex(([, b]) => b === a) === i);
  return html`<div class="card">
    <h3>Ammo-suggestie <span class="count">${caliberName(w.caliber)}</span></h3>
    <div class="ammo-picks">${picks.map(([label, a]) => {
      const t = a.traders.filter((x) => !x.quest).sort((x, y) => x.priceRUB - y.priceRUB)[0];
      return html`<a class="ammo-pick" href="#/ammo/${encodeURIComponent(w.caliber)}">
        ${a.icon ? html`<img class="icon-img sm" src="${a.icon}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}
        <span><span class="faint" style="font-size:11.5px">${label}</span><br><b>${a.shortName}</b> <span class="muted">pen ${a.pen} · dmg ${a.damage * (a.projectiles || 1)}</span>
        <br><span class="faint" style="font-size:12px">${t ? `${t.trader} LL${t.level} · ${rub(t.priceRUB)}` : a.fleaBanned ? "geen flea, niet bij handelaren" : a.avg24h ? `flea ${rub(a.avg24h)}` : "–"}</span></span>
      </a>`;
    })}</div>
  </div>`;
}
