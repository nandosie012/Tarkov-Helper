import { store } from "../app.js";
import { html, norm, rub, debounce, timeAgo } from "../util.js";

const PREF_KEY = "tarkov-helper-trades";
const PAGE = 250;

let root;
let state = { search: "", minProfit: 1000, minOffers: 3, trader: "", onlyProfit: true, sort: "profit", dir: -1, limit: PAGE };

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}");
    state = { ...state, ...saved, limit: PAGE };
  } catch {
    /* ignore */
  }
}
function savePrefs() {
  try {
    const { limit, ...rest } = state;
    localStorage.setItem(PREF_KEY, JSON.stringify(rest));
  } catch {
    /* ignore */
  }
}

const perSlot = (t) => t.profit / Math.max(1, t.w * t.h);
const margin = (t) => t.profit / t.low;
const SORTS = {
  profit: (t) => t.profit,
  perSlot,
  margin,
  low: (t) => t.low,
  name: (t) => t.name,
};

export async function mount(el) {
  root = el;
  loadPrefs();
  el.innerHTML = `<div class="loading">Prijzen laden…</div>`;
  try {
    if (!store.trades) {
      const res = await fetch("data/trades.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status);
      store.trades = await res.json();
    }
  } catch {
    el.innerHTML = `<div class="empty">Nog geen prijsdata. Draai een sync via de pagina Data.</div>`;
    return;
  }
  const traders = [...new Set(store.trades.items.map((t) => t.sells[0].trader))].sort();
  el.innerHTML = String(html`
    <div class="page">
      <div class="page-head">
        <h2>Flea → handelaar</h2>
        <input class="input" id="t-search" type="search" placeholder="Zoek item…" style="max-width:240px" value="${state.search}">
        <label class="check">Min. winst
          <select class="input" id="t-min" style="width:auto;padding:3px 6px">
            ${[0, 1000, 5000, 10000, 25000].map((v) => html`<option value="${v}" ${state.minProfit === v ? "selected" : ""}>${v ? rub(v) : "alles"}</option>`)}
          </select>
        </label>
        <label class="check">Min. aanbod
          <select class="input" id="t-offers" style="width:auto;padding:3px 6px">
            ${[1, 3, 5, 10, 25].map((v) => html`<option value="${v}" ${state.minOffers === v ? "selected" : ""}>${v}+</option>`)}
          </select>
        </label>
        <label class="check"><input type="checkbox" id="t-only" ${state.onlyProfit ? "checked" : ""}>Alleen met winst</label>
        <div class="filter-row" id="t-traders">
          <button class="chip ${state.trader ? "" : "on"}" data-trader="">Alle handelaren</button>
          ${traders.map((t) => html`<button class="chip ${state.trader === t ? "on" : ""}" data-trader="${t}">${t}</button>`)}
        </div>
      </div>
      <div class="page-body scroll" id="t-body"></div>
    </div>`);

  const rerender = () => {
    state.limit = PAGE;
    savePrefs();
    render();
  };
  el.querySelector("#t-search").addEventListener("input", debounce((e) => {
    state.search = e.target.value;
    rerender();
  }, 150));
  el.querySelector("#t-min").addEventListener("change", (e) => {
    state.minProfit = Number(e.target.value);
    rerender();
  });
  el.querySelector("#t-offers").addEventListener("change", (e) => {
    state.minOffers = Number(e.target.value);
    rerender();
  });
  el.querySelector("#t-only").addEventListener("change", (e) => {
    state.onlyProfit = e.target.checked;
    rerender();
  });
  el.querySelector("#t-traders").addEventListener("click", (e) => {
    const b = e.target.closest("[data-trader]");
    if (!b) return;
    state.trader = b.dataset.trader;
    for (const c of el.querySelectorAll("#t-traders .chip")) c.classList.toggle("on", c === b);
    rerender();
  });
  el.querySelector("#t-body").addEventListener("click", (e) => {
    const th = e.target.closest("[data-sort]");
    if (th) {
      if (state.sort === th.dataset.sort) state.dir *= -1;
      else Object.assign(state, { sort: th.dataset.sort, dir: th.dataset.sort === "name" ? 1 : -1 });
      rerender();
      return;
    }
    if (e.target.closest("#t-more")) {
      state.limit += PAGE;
      render();
    }
  });
  render();
}

function filtered() {
  const terms = norm(state.search).split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  return store.trades.items.filter((t) => {
    if (terms.length && !terms.every((q) => norm(`${t.name} ${t.shortName}`).includes(q))) return false;
    if (state.trader && t.sells[0].trader !== state.trader) return false;
    if ((t.offers ?? 0) < state.minOffers) return false;
    // a search shows every match, so you can also look up where to sell something
    if (!searching && state.onlyProfit && (t.profit <= 0 || t.profit < state.minProfit)) return false;
    return true;
  });
}

function render() {
  const body = root.querySelector("#t-body");
  const key = SORTS[state.sort] ?? SORTS.profit;
  const rows = filtered().sort((a, b) => {
    const va = key(a);
    const vb = key(b);
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * state.dir;
  });
  const winners = store.trades.items.filter((t) => t.profit > 0 && (t.offers ?? 0) >= state.minOffers);
  const best = winners[0];
  const fetchedAt = store.status?.meta?.fetchedAt;
  const arrow = (k) => (state.sort === k ? (state.dir < 0 ? " ▾" : " ▴") : "");
  body.innerHTML = String(html`
    <div class="stat-row" style="margin-bottom:12px">
      <div class="stat"><b>${winners.length}</b><span>Items met winst (${state.minOffers}+ aanbod)</span></div>
      ${best ? html`<div class="stat"><b>+${rub(best.profit)}</b><span>Hoogste: ${best.name}</span></div>` : ""}
      <div class="stat"><b>${fetchedAt ? timeAgo(fetchedAt) : "–"}</b><span>Prijzen opgehaald</span></div>
      <div class="stat"><b>Level ${store.trades.fleaMinLevel}</b><span>Flea vanaf</span></div>
    </div>
    <p class="muted" style="margin:0 0 12px;font-size:12.5px">Koop het item op de flea (laagste aanbieding), verkoop het aan de handelaar. Kopen op de flea kost geen fee. Prijzen veranderen snel: de leeftijd staat per item, check de prijs in de game voordat je koopt. Zoek je een item op, dan zie je het ook zonder winst, handig om te zien waar je het best verkoopt.</p>
    ${rows.length ? html`
    <div class="table-scroll"><table class="agg-table trade-table">
      <thead><tr>
        <th data-sort="name">Item${arrow("name")}</th>
        <th data-sort="low">Flea laagste${arrow("low")}</th>
        <th>Flea 24u gem.</th>
        <th>Beste handelaar</th>
        <th data-sort="profit">Winst${arrow("profit")}</th>
        <th data-sort="perSlot">Per slot${arrow("perSlot")}</th>
        <th data-sort="margin">Marge${arrow("margin")}</th>
      </tr></thead>
      <tbody>${rows.slice(0, state.limit).map(row)}</tbody>
    </table></div>
    ${rows.length > state.limit ? html`<p style="text-align:center"><button class="btn" id="t-more">Toon meer (${rows.length - state.limit} over)</button></p>` : ""}`
    : html`<div class="empty">Geen items voor deze filters.</div>`}`);
}

function row(t) {
  const s = t.sells[0];
  const ageH = t.updated ? (Date.now() - Date.parse(t.updated)) / 3600e3 : null;
  const good = t.profit > 0;
  return html`<tr>
    <td>
      <div class="iname">
        ${t.icon ? html`<img class="icon-img sm" src="${t.icon}" alt="" loading="lazy" referrerpolicy="no-referrer">` : html`<span class="icon-ph sm"></span>`}
        <div class="names">
          ${t.wiki ? html`<a href="${t.wiki}" target="_blank" rel="noopener" style="color:var(--text)">${t.name}</a>` : t.name}
          <span class="alt">${t.w}×${t.h}${t.minLevel && t.minLevel > store.trades.fleaMinLevel ? ` · flea vanaf level ${t.minLevel}` : ""}</span>
        </div>
      </div>
    </td>
    <td class="num">${rub(t.low)}<div class="faint" style="font-size:11.5px">${t.offers ?? "?"} aanbod${ageH != null ? html` · <span class="${ageH > 6 ? "c-orange" : ""}">${timeAgo(t.updated)}</span>` : ""}</div></td>
    <td class="num">${t.avg ? rub(t.avg) : "–"}</td>
    <td class="num">${s.trader} · ${rub(s.priceRUB)}${s.currency !== "RUB" ? html`<div class="faint" style="font-size:11.5px">${s.currency === "USD" ? "$" : s.currency === "EUR" ? "€" : ""}${s.price.toLocaleString("nl-NL")}</div>` : ""}</td>
    <td class="num"><b class="${good ? "delta-good" : "delta-bad"}">${good ? "+" : "−"}${rub(Math.abs(t.profit))}</b></td>
    <td class="num">${good ? `+${rub(perSlot(t))}` : html`<span class="faint">–</span>`}</td>
    <td class="num">${good ? `${(margin(t) * 100).toFixed(1)}%` : html`<span class="faint">–</span>`}</td>
  </tr>`;
}
