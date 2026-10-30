import { store, dataPath } from "../app.js";
import { html, norm, rub, debounce, timeAgo } from "../util.js";

const PREF_KEY = "tarkov-helper-trades";
const PAGE = 250;

let root;
let state = {
  mode: "flip", // flip: buy on the flea, sell to a trader · sell: where to sell your own loot
  search: "",
  minProfit: 1000,
  minOffers: 3,
  trader: "",
  onlyProfit: true,
  onlyTrader: true,
  intel3: false,
  sort: "profit",
  dir: -1,
  limit: PAGE,
};

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

/**
 * Flea listing fee as the game computes it (community-documented formula):
 * base × Ti × 4^po + price × Tr × 4^pr, with the exponent on the side that is above the base price raised to 1.08.
 * Intelligence Center level 3 takes 30% off.
 */
function fleaFee(base, price) {
  if (!(base > 0) || !(price > 0)) return null;
  const { offer, requirement } = store.trades.fee ?? { offer: 0.05, requirement: 0.05 };
  let po = Math.log10(base / price);
  let pr = Math.log10(price / base);
  if (price < base) po **= 1.08;
  else pr **= 1.08;
  const fee = base * offer * 4 ** po + price * requirement * 4 ** pr;
  return fee * (state.intel3 ? 0.7 : 1);
}

/** Selling your own item: list 1 ₽ under the cheapest offer, pay the fee; compare with the best trader. */
function sellView(t) {
  const list = Math.max(1, t.low - 1);
  const fee = fleaFee(t.basePrice, list);
  if (fee == null) return null;
  // far above the base price the fee can exceed the price itself: then listing makes no sense, net 0
  const pointless = fee >= list;
  const net = pointless ? 0 : list - fee;
  return { fee, net, pointless, gain: t.sells[0].priceRUB - net };
}

const slots = (t) => Math.max(1, t.w * t.h);
const SORTS = {
  flip: {
    profit: (t) => t.profit,
    perSlot: (t) => t.profit / slots(t),
    margin: (t) => t.profit / t.low,
    low: (t) => t.low,
    name: (t) => t.name,
  },
  sell: {
    gain: (t) => t._sell.gain,
    gainSlot: (t) => t._sell.gain / slots(t),
    fee: (t) => t._sell.fee,
    low: (t) => t.low,
    name: (t) => t.name,
  },
};

export async function mount(el) {
  root = el;
  loadPrefs();
  el.innerHTML = `<div class="loading">Prijzen laden…</div>`;
  try {
    if (!store.trades) {
      const res = await fetch(dataPath("trades.json"), { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status);
      store.trades = await res.json();
    }
  } catch {
    el.innerHTML = `<div class="empty">Nog geen prijsdata. Draai een sync via de pagina Data.</div>`;
    return;
  }
  el.innerHTML = `<div class="page"><div class="page-head" id="t-head"></div><div class="page-body scroll" id="t-body"></div></div>`;

  const rerender = () => {
    state.limit = PAGE;
    savePrefs();
    render();
  };
  el.addEventListener("input", debounce((e) => {
    if (e.target.id !== "t-search") return;
    state.search = e.target.value;
    rerender();
  }, 150));
  el.addEventListener("change", (e) => {
    const id = e.target.id;
    if (id === "t-min") state.minProfit = Number(e.target.value);
    else if (id === "t-offers") state.minOffers = Number(e.target.value);
    else if (id === "t-only") state.onlyProfit = e.target.checked;
    else if (id === "t-only-trader") state.onlyTrader = e.target.checked;
    else if (id === "t-intel") state.intel3 = e.target.checked;
    else return;
    rerender();
  });
  el.addEventListener("click", (e) => {
    const mode = e.target.closest("[data-mode]");
    if (mode && mode.dataset.mode !== state.mode) {
      state.mode = mode.dataset.mode;
      Object.assign(state, state.mode === "sell" ? { sort: "gain", dir: -1 } : { sort: "profit", dir: -1 });
      savePrefs();
      renderHead();
      rerender();
      return;
    }
    const trader = e.target.closest("[data-trader]");
    if (trader) {
      state.trader = trader.dataset.trader;
      for (const c of el.querySelectorAll("[data-trader]")) c.classList.toggle("on", c === trader);
      rerender();
      return;
    }
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
  renderHead();
  render();
}

function renderHead() {
  const traders = [...new Set(store.trades.items.map((t) => t.sells[0].trader))].sort();
  const flip = state.mode === "flip";
  root.querySelector("#t-head").innerHTML = String(html`
    <div class="filter-row" style="width:100%">
      <button class="chip ${flip ? "on" : ""}" data-mode="flip">Flea kopen → handelaar</button>
      <button class="chip ${flip ? "" : "on"}" data-mode="sell">Verkopen: handelaar of flea?</button>
    </div>
    <input class="input" id="t-search" type="search" placeholder="Zoek item…" style="max-width:240px" value="${state.search}">
    ${flip ? html`
      <label class="check">Min. winst
        <select class="input" id="t-min" style="width:auto;padding:3px 6px">
          ${[0, 1000, 5000, 10000, 25000].map((v) => html`<option value="${v}" ${state.minProfit === v ? "selected" : ""}>${v ? rub(v) : "alles"}</option>`)}
        </select>
      </label>` : ""}
    <label class="check">Min. aanbod
      <select class="input" id="t-offers" style="width:auto;padding:3px 6px">
        ${[1, 3, 5, 10, 25].map((v) => html`<option value="${v}" ${state.minOffers === v ? "selected" : ""}>${v}+</option>`)}
      </select>
    </label>
    ${flip
      ? html`<label class="check"><input type="checkbox" id="t-only" ${state.onlyProfit ? "checked" : ""}>Alleen met winst</label>`
      : html`<label class="check"><input type="checkbox" id="t-only-trader" ${state.onlyTrader ? "checked" : ""}>Alleen waar de handelaar beter is</label>
        <label class="check" title="Intelligence Center niveau 3 verlaagt de flea-fee met 30%"><input type="checkbox" id="t-intel" ${state.intel3 ? "checked" : ""}>Intelligence Center 3 (−30% fee)</label>`}
    <div class="filter-row">
      <button class="chip ${state.trader ? "" : "on"}" data-trader="">Alle handelaren</button>
      ${traders.map((t) => html`<button class="chip ${state.trader === t ? "on" : ""}" data-trader="${t}">${t}</button>`)}
    </div>`);
}

function filtered() {
  const terms = norm(state.search).split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  const sell = state.mode === "sell";
  const out = [];
  for (const t of store.trades.items) {
    if (terms.length && !terms.every((q) => norm(`${t.name} ${t.shortName}`).includes(q))) continue;
    if (state.trader && t.sells[0].trader !== state.trader) continue;
    if ((t.offers ?? 0) < state.minOffers) continue;
    if (sell) {
      t._sell = sellView(t);
      if (!t._sell) continue;
      // a search shows every match, so you can look up where any item sells best
      if (!searching && state.onlyTrader && t._sell.gain < 0) continue;
    } else if (!searching && state.onlyProfit && (t.profit <= 0 || t.profit < state.minProfit)) {
      continue;
    }
    out.push(t);
  }
  return out;
}

function render() {
  const body = root.querySelector("#t-body");
  const sell = state.mode === "sell";
  const sorts = SORTS[state.mode];
  const key = sorts[state.sort] ?? sorts[sell ? "gain" : "profit"];
  const rows = filtered().sort((a, b) => {
    const va = key(a);
    const vb = key(b);
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * state.dir;
  });
  const fetchedAt = store.status?.meta?.fetchedAt;
  const arrow = (k) => (state.sort === k ? (state.dir < 0 ? " ▾" : " ▴") : "");
  const priceAge = html`<div class="stat"><b>${fetchedAt ? timeAgo(fetchedAt) : "–"}</b><span>Prijzen opgehaald</span></div>`;

  let stats;
  let intro;
  let head;
  if (sell) {
    const pool = store.trades.items.filter((t) => (t.offers ?? 0) >= state.minOffers).map((t) => ({ t, s: sellView(t) })).filter((x) => x.s);
    const toTrader = pool.filter((x) => x.s.gain >= 0).sort((a, b) => b.s.gain - a.s.gain);
    stats = html`
      <div class="stat"><b>${toTrader.length}</b><span>Altijd bij handelaar verkopen (${state.minOffers}+ aanbod)</span></div>
      ${toTrader[0] ? html`<div class="stat"><b>+${rub(toTrader[0].s.gain)}</b><span>Grootste verschil: ${toTrader[0].t.name}</span></div>` : ""}
      ${priceAge}`;
    intro = html`Waar levert je loot het meest op? Op de flea zet je het item 1 ₽ onder de laagste aanbieding en betaal je een fee; de handelaar betaalt meteen. De fee is geschat met de formule van de game${state.intel3 ? ", met 30% korting van Intelligence Center 3" : ""}. Hier staan de items waarvoor de handelaar netto evenveel of meer geeft. Zoek je een item op, dan zie je het ook als de flea beter is. Flea vanaf level ${store.trades.fleaMinLevel}.`;
    head = html`<tr>
      <th data-sort="name">Item${arrow("name")}</th>
      <th data-sort="low">Flea laagste${arrow("low")}</th>
      <th data-sort="fee">Fee (geschat)${arrow("fee")}</th>
      <th>Flea netto</th>
      <th>Beste handelaar</th>
      <th data-sort="gain">Handelaar t.o.v. flea${arrow("gain")}</th>
      <th data-sort="gainSlot">Per slot${arrow("gainSlot")}</th>
    </tr>`;
  } else {
    const winners = store.trades.items.filter((t) => t.profit > 0 && (t.offers ?? 0) >= state.minOffers);
    stats = html`
      <div class="stat"><b>${winners.length}</b><span>Items met winst (${state.minOffers}+ aanbod)</span></div>
      ${winners[0] ? html`<div class="stat"><b>+${rub(winners[0].profit)}</b><span>Hoogste: ${winners[0].name}</span></div>` : ""}
      ${priceAge}
      <div class="stat"><b>Level ${store.trades.fleaMinLevel}</b><span>Flea vanaf</span></div>`;
    intro = html`Koop het item op de flea (laagste aanbieding), verkoop het aan de handelaar. Kopen op de flea kost geen fee. Prijzen veranderen snel: de leeftijd staat per item, check de prijs in de game voordat je koopt. Zoek je een item op, dan zie je het ook zonder winst.`;
    head = html`<tr>
      <th data-sort="name">Item${arrow("name")}</th>
      <th data-sort="low">Flea laagste${arrow("low")}</th>
      <th>Flea 24u gem.</th>
      <th>Beste handelaar</th>
      <th data-sort="profit">Winst${arrow("profit")}</th>
      <th data-sort="perSlot">Per slot${arrow("perSlot")}</th>
      <th data-sort="margin">Marge${arrow("margin")}</th>
    </tr>`;
  }

  body.innerHTML = String(html`
    <div class="stat-row" style="margin-bottom:12px">${stats}</div>
    <p class="muted" style="margin:0 0 12px;font-size:12.5px">${intro}</p>
    ${rows.length ? html`
    <div class="table-scroll"><table class="agg-table trade-table">
      <thead>${head}</thead>
      <tbody>${rows.slice(0, state.limit).map(sell ? sellRow : flipRow)}</tbody>
    </table></div>
    ${rows.length > state.limit ? html`<p style="text-align:center"><button class="btn" id="t-more">Toon meer (${rows.length - state.limit} over)</button></p>` : ""}`
    : html`<div class="empty">Geen items voor deze filters.</div>`}`);
}

function itemCell(t) {
  return html`<td>
    <div class="iname">
      ${t.icon ? html`<img class="icon-img sm" src="${t.icon}" alt="" loading="lazy" referrerpolicy="no-referrer">` : html`<span class="icon-ph sm"></span>`}
      <div class="names">
        ${t.wiki ? html`<a href="${t.wiki}" target="_blank" rel="noopener" style="color:var(--text)">${t.name}</a>` : t.name}
        <span class="alt">${t.w}×${t.h}${t.minLevel && t.minLevel > store.trades.fleaMinLevel ? ` · flea vanaf level ${t.minLevel}` : ""}</span>
      </div>
    </div>
  </td>`;
}

function fleaCell(t) {
  const ageH = t.updated ? (Date.now() - Date.parse(t.updated)) / 3600e3 : null;
  return html`<td class="num">${rub(t.low)}<div class="faint" style="font-size:11.5px">${t.offers ?? "?"} aanbod${ageH != null ? html` · <span class="${ageH > 6 ? "c-orange" : ""}">${timeAgo(t.updated)}</span>` : ""}</div></td>`;
}

function traderCell(t) {
  const s = t.sells[0];
  return html`<td class="num">${s.trader} · ${rub(s.priceRUB)}${s.currency !== "RUB" ? html`<div class="faint" style="font-size:11.5px">${s.currency === "USD" ? "$" : s.currency === "EUR" ? "€" : ""}${s.price.toLocaleString("nl-NL")}</div>` : ""}</td>`;
}

const signed = (v) => html`<b class="${v >= 0 ? "delta-good" : "delta-bad"}">${v >= 0 ? "+" : "−"}${rub(Math.abs(v))}</b>`;

function flipRow(t) {
  const good = t.profit > 0;
  return html`<tr>
    ${itemCell(t)}
    ${fleaCell(t)}
    <td class="num">${t.avg ? rub(t.avg) : "–"}</td>
    ${traderCell(t)}
    <td class="num">${signed(t.profit)}</td>
    <td class="num">${good ? `+${rub(t.profit / slots(t))}` : html`<span class="faint">–</span>`}</td>
    <td class="num">${good ? `${((t.profit / t.low) * 100).toFixed(1)}%` : html`<span class="faint">–</span>`}</td>
  </tr>`;
}

function sellRow(t) {
  const s = t._sell;
  return html`<tr>
    ${itemCell(t)}
    ${fleaCell(t)}
    <td class="num">${rub(s.fee)}<div class="faint" style="font-size:11.5px">${((s.fee / t.low) * 100).toFixed(0)}% van de prijs</div></td>
    <td class="num">${s.pointless ? html`<span class="faint">0 ₽</span><div class="c-orange" style="font-size:11.5px">fee hoger dan prijs</div>` : rub(s.net)}</td>
    ${traderCell(t)}
    <td class="num">${signed(s.gain)}<div class="faint" style="font-size:11.5px">${s.gain >= 0 ? "verkoop aan handelaar" : "verkoop op de flea"}</div></td>
    <td class="num">${s.gain >= 0 ? `+${rub(s.gain / slots(t))}` : html`<span class="faint">–</span>`}</td>
  </tr>`;
}
