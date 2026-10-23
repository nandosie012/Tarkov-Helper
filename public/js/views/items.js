import { store, questState, isDone, saveProgress } from "../app.js";
import { html, norm, rub, traderColor, itemIcon, debounce } from "../util.js";

const FILTER_KEY = "tarkov-helper-item-filters";
const KIND_GROUPS = [
  { id: "handover", label: "Inleveren", kinds: ["handover", "find"] },
  { id: "questitem", label: "Quest-items", kinds: ["questitem"] },
  { id: "required", label: "Meenemen / gebruiken", kinds: ["required", "use", "other"] },
  { id: "key", label: "Sleutels", kinds: ["key"] },
  { id: "plant", label: "Plaatsen / markeren", kinds: ["plant", "mark"] },
  { id: "build", label: "Wapens bouwen", kinds: ["build"] },
  { id: "sell", label: "Verkopen", kinds: ["sell"] },
  { id: "money", label: "Geld", kinds: [] },
];
// Roubles, Dollars, Euros: hand-ins of cash would swamp the totals, so they get their own toggle
const CURRENCY = new Set(["5449016a4bdc2d6f028b456f", "5696686a4bdc2da3298b456a", "569668774bdc2da2298b4568"]);

let root;
let state = {
  search: "",
  groups: { handover: true, questitem: false, required: false, key: false, plant: true, build: false, sell: false, money: false },
  scope: "open",
  kappa: false,
  firOnly: false,
  hideComplete: false,
  sort: "count",
};

function loadFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}");
    state = { ...state, ...saved, groups: { ...state.groups, ...(saved.groups ?? {}) } };
  } catch {
    /* ignore */
  }
}
function saveFilters() {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

const onProgress = () => render();

export function mount(el) {
  root = el;
  loadFilters();
  el.innerHTML = String(html`
    <div class="page">
      <div class="page-head">
        <h2>Benodigde quest-items</h2>
        <input class="input" id="i-search" type="search" placeholder="Zoek item of quest…" style="max-width:260px" value="${state.search}">
        <select class="input" id="i-scope" style="max-width:220px">
          <option value="open" ${state.scope === "open" ? "selected" : ""}>Alle niet-voltooide quests</option>
          <option value="available" ${state.scope === "available" ? "selected" : ""}>Alleen nu beschikbare quests</option>
          <option value="all" ${state.scope === "all" ? "selected" : ""}>Alle quests</option>
        </select>
        <div class="filter-row">${KIND_GROUPS.map((g) => html`<label class="check"><input type="checkbox" data-group="${g.id}" ${state.groups[g.id] ? "checked" : ""}>${g.label}</label>`)}</div>
        <div class="filter-row">
          <label class="check"><input type="checkbox" data-flag="kappa" ${state.kappa ? "checked" : ""}>Alleen Kappa-quests</label>
          <label class="check"><input type="checkbox" data-flag="firOnly" ${state.firOnly ? "checked" : ""}>Alleen FIR</label>
          <label class="check"><input type="checkbox" data-flag="hideComplete" ${state.hideComplete ? "checked" : ""}>Verberg wat ik al heb</label>
        </div>
      </div>
      <div class="page-body scroll" id="i-body"></div>
    </div>`);
  el.querySelector("#i-search").addEventListener("input", debounce((e) => {
    state.search = e.target.value;
    saveFilters();
    render();
  }, 120));
  el.querySelector("#i-scope").addEventListener("change", (e) => {
    state.scope = e.target.value;
    saveFilters();
    render();
  });
  for (const cb of el.querySelectorAll("[data-group]")) cb.addEventListener("change", () => {
    state.groups[cb.dataset.group] = cb.checked;
    saveFilters();
    render();
  });
  for (const cb of el.querySelectorAll("[data-flag]")) cb.addEventListener("change", () => {
    state[cb.dataset.flag] = cb.checked;
    saveFilters();
    render();
  });
  el.querySelector("#i-body").addEventListener("click", (e) => {
    const sort = e.target.closest("[data-sort]");
    if (sort) {
      state.sort = sort.dataset.sort;
      saveFilters();
      render();
      return;
    }
    const btn = e.target.closest("[data-owned]");
    if (!btn) return;
    const key = btn.dataset.owned;
    const next = Math.max(0, (store.progress.owned[key] ?? 0) + Number(btn.dataset.delta));
    if (next) store.progress.owned[key] = next;
    else delete store.progress.owned[key];
    saveProgress();
    render();
  });
  window.addEventListener("progress", onProgress);
  render();
}

export function unmount() {
  window.removeEventListener("progress", onProgress);
}

function enabledKinds() {
  return new Set(KIND_GROUPS.filter((g) => state.groups[g.id]).flatMap((g) => g.kinds));
}

function aggregate() {
  const kinds = enabledKinds();
  const groups = new Map();
  for (const q of store.quests) {
    if (state.scope === "open" && isDone(q.id)) continue;
    if (state.scope === "available" && questState(q) !== "available") continue;
    if (state.kappa && !q.kappa) continue;
    for (const e of q.items) {
      const money = e.itemIds.every((id) => CURRENCY.has(id));
      if (money ? !state.groups.money : !kinds.has(e.kind)) continue;
      if (state.firOnly && !e.fir) continue;
      const ids = e.itemIds;
      const key = ids.length === 1 ? ids[0] : `alt:${[...ids].sort().join(",")}`;
      let g = groups.get(key);
      if (!g) {
        g = { key, ids, fir: 0, nonFir: 0, unknown: false, entries: [], text: e.text ?? "" };
        groups.set(key, g);
      }
      const n = typeof e.count === "number" ? e.count : 1;
      if (typeof e.count !== "number") g.unknown = true;
      if (e.fir) g.fir += n;
      else g.nonFir += n;
      g.entries.push({ quest: q, entry: e, n });
    }
  }
  return [...groups.values()];
}

function groupName(g) {
  if (g.ids.length === 1) return store.items[g.ids[0]]?.name ?? g.ids[0];
  if (g.ids.length <= 4) return g.ids.map((id) => store.items[id]?.name ?? id).join(" / ");
  return g.text || `Een van ${g.ids.length} items`;
}

function render() {
  const body = root.querySelector("#i-body");
  const terms = norm(state.search).split(/\s+/).filter(Boolean);
  let rows = aggregate().map((g) => {
    const total = g.fir + g.nonFir;
    const owned = store.progress.owned[g.key] ?? 0;
    const item = g.ids.length === 1 ? store.items[g.ids[0]] : null;
    const price = item ? item.avg24h ?? item.lastLow ?? null : null;
    return { ...g, total, owned, item, price, name: groupName(g) };
  });
  if (terms.length) {
    rows = rows.filter((r) => {
      const hay = norm(`${r.name} ${r.item?.shortName ?? ""} ${r.entries.map((e) => e.quest.title).join(" ")}`);
      return terms.every((t) => hay.includes(t));
    });
  }
  if (state.hideComplete) rows = rows.filter((r) => r.owned < r.total);
  const sorters = {
    count: (a, b) => b.total - a.total || a.name.localeCompare(b.name),
    fir: (a, b) => b.fir - a.fir || b.total - a.total,
    name: (a, b) => a.name.localeCompare(b.name),
    price: (a, b) => (b.price ?? -1) * b.total - (a.price ?? -1) * a.total,
    quests: (a, b) => b.entries.length - a.entries.length,
  };
  rows.sort(sorters[state.sort] ?? sorters.count);

  const totalFir = rows.reduce((s, r) => s + r.fir, 0);
  const remaining = rows.reduce((s, r) => s + Math.max(0, r.total - r.owned), 0);
  const cost = rows.reduce((s, r) => s + (r.price && !r.item?.fleaBanned ? r.price * Math.max(0, r.total - r.owned) : 0), 0);
  const arrow = (key) => (state.sort === key ? " ▾" : "");

  body.innerHTML = String(html`
    <div class="stat-row" style="margin-bottom:14px">
      <div class="stat"><b>${rows.length}</b><span>Verschillende items</span></div>
      <div class="stat"><b>${totalFir}</b><span>Stuks found-in-raid</span></div>
      <div class="stat"><b>${remaining}</b><span>Nog te verzamelen</span></div>
      <div class="stat"><b>${rub(cost)}</b><span>Geschat via flea (avg 24u)</span></div>
    </div>
    ${rows.length ? html`
    <table class="agg-table">
      <thead><tr>
        <th data-sort="name">Item${arrow("name")}</th>
        <th data-sort="fir">FIR${arrow("fir")}</th>
        <th data-sort="count">Totaal${arrow("count")}</th>
        <th>Heb ik</th>
        <th data-sort="quests">Voor quests${arrow("quests")}</th>
        <th data-sort="price">Flea${arrow("price")}</th>
      </tr></thead>
      <tbody>${rows.map(row)}</tbody>
    </table>` : html`<div class="empty">Geen items voor deze filters.</div>`}`);
}

function row(r) {
  const complete = r.owned >= r.total;
  const multi = r.ids.length > 1;
  return html`<tr class="${complete ? "complete" : ""}">
    <td>
      <div class="iname">${multi ? html`<span class="icon-ph"></span>` : itemIcon(r.item)}
        <div class="names">
          ${r.item?.wiki ? html`<a href="${r.item.wiki}" target="_blank" rel="noopener" style="color:var(--text)">${r.name}</a>` : html`<span>${r.name}</span>`}
          ${r.item?.questItem ? html`<span class="alt">Quest-item: alleen in de raid te vinden</span>` : ""}
          ${multi && r.ids.length > 4 ? html`<details><summary>${r.ids.length} mogelijke items</summary><div class="alt-list">${r.ids.map((id) => html`<img src="${store.items[id]?.icon ?? ""}" title="${store.items[id]?.name ?? id}" alt="" loading="lazy" referrerpolicy="no-referrer">`)}</div></details>` : ""}
        </div>
      </div>
    </td>
    <td>${r.fir ? html`<span class="qty">${r.fir}</span> <span class="chip fir">FIR</span>` : html`<span class="faint">–</span>`}</td>
    <td><span class="qty">${r.total}${r.unknown ? "+" : ""}</span></td>
    <td><span class="owned"><button data-owned="${r.key}" data-delta="-1" title="Eén minder">−</button><span>${r.owned}</span><button data-owned="${r.key}" data-delta="1" title="Eén meer">+</button></span></td>
    <td class="quests">${r.entries.map((e, i) => html`${i ? ", " : ""}<a href="#/quests/${encodeURIComponent(e.quest.id)}"><span class="dot" style="background:${traderColor(e.quest.trader)};width:7px;height:7px"></span> ${e.quest.title}</a>${e.n > 1 ? html` <span class="faint">×${e.n}</span>` : ""}`)}</td>
    <td class="price">${r.item?.questItem ? "–" : r.item?.fleaBanned ? "geen flea" : r.price ? rub(r.price) : "–"}</td>
  </tr>`;
}
