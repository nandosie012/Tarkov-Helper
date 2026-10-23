import { store, questState, setDone, setDoneWithPrereqs, saveProgress, go, isDone } from "../app.js";
import { html, raw, norm, rub, traderColor, KIND_LABEL, itemIcon, openLightbox, debounce } from "../util.js";

const TRADER_ORDER = ["Prapor", "Therapist", "Fence", "Skier", "Peacekeeper", "Mechanic", "Ragman", "Jaeger", "Ref", "Lightkeeper", "BTR Driver"];
const FILTER_KEY = "tarkov-helper-quest-filters";

let root;
let state = { id: null, search: "", trader: "", map: "", hideDone: false, onlyAvailable: false, kappa: false, lk: false, hasItems: false, wikiOnly: false };

function loadFilters() {
  try {
    Object.assign(state, JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}"), { id: null });
  } catch {
    /* ignore */
  }
}
function saveFilters() {
  try {
    const { id, ...rest } = state;
    localStorage.setItem(FILTER_KEY, JSON.stringify(rest));
  } catch {
    /* ignore */
  }
}

const onProgress = () => {
  renderList();
  renderDetail();
};

export function mount(el, route) {
  root = el;
  loadFilters();
  const traders = TRADER_ORDER.filter((t) => store.quests.some((q) => q.trader === t)).concat(
    [...new Set(store.quests.map((q) => q.trader))].filter((t) => !TRADER_ORDER.includes(t))
  );
  const maps = store.maps.filter((m) => !m.variant);
  el.innerHTML = String(html`
    <div class="split">
      <aside class="sidebar">
        <div class="filters">
          <input class="input" id="q-search" type="search" placeholder="Zoek quest, doel of item…" value="${state.search}">
          <div class="filter-row" id="q-traders">
            <button class="chip ${state.trader ? "" : "on"}" data-trader="">Alle</button>
            ${traders.map((t) => html`<button class="chip ${state.trader === t ? "on" : ""}" data-trader="${t}"><span class="dot" style="background:${traderColor(t)}"></span>${t}</button>`)}
          </div>
          <select class="input" id="q-map">
            <option value="">Alle maps</option>
            ${maps.map((m) => html`<option value="${m.id}" ${state.map === m.id ? "selected" : ""}>${m.name}</option>`)}
          </select>
          <div class="filter-row">
            <label class="check"><input type="checkbox" data-flag="hideDone" ${state.hideDone ? "checked" : ""}>Verberg voltooid</label>
            <label class="check"><input type="checkbox" data-flag="onlyAvailable" ${state.onlyAvailable ? "checked" : ""}>Alleen beschikbaar</label>
          </div>
          <div class="filter-row">
            <label class="check"><input type="checkbox" data-flag="kappa" ${state.kappa ? "checked" : ""}>Kappa</label>
            <label class="check"><input type="checkbox" data-flag="lk" ${state.lk ? "checked" : ""}>Lightkeeper</label>
            <label class="check"><input type="checkbox" data-flag="hasItems" ${state.hasItems ? "checked" : ""}>Met items</label>
          </div>
        </div>
        <div class="list-count" id="q-count"></div>
        <div class="list scroll" id="q-list"></div>
      </aside>
      <section class="detail scroll" id="q-detail"></section>
    </div>`);

  el.querySelector("#q-search").addEventListener("input", debounce((e) => {
    state.search = e.target.value;
    saveFilters();
    renderList();
  }, 120));
  el.querySelector("#q-traders").addEventListener("click", (e) => {
    const b = e.target.closest("[data-trader]");
    if (!b) return;
    state.trader = b.dataset.trader;
    for (const c of el.querySelectorAll("#q-traders .chip")) c.classList.toggle("on", c === b);
    saveFilters();
    renderList();
  });
  el.querySelector("#q-map").addEventListener("change", (e) => {
    state.map = e.target.value;
    saveFilters();
    renderList();
  });
  for (const cb of el.querySelectorAll("[data-flag]")) {
    cb.addEventListener("change", () => {
      state[cb.dataset.flag] = cb.checked;
      saveFilters();
      renderList();
    });
  }
  el.querySelector("#q-list").addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-toggle]");
    if (toggle) {
      e.stopPropagation();
      setDone(toggle.dataset.toggle, !isDone(toggle.dataset.toggle));
      return;
    }
    const row = e.target.closest("[data-id]");
    if (row) go(`#/quests/${encodeURIComponent(row.dataset.id)}`);
  });
  window.addEventListener("progress", onProgress);
  update(route);
}

export function unmount() {
  window.removeEventListener("progress", onProgress);
}

export function update(route) {
  state.id = route.param;
  if (!state.id) {
    // open the first visible quest so the detail pane is never empty
    const first = filtered()[0];
    if (first) state.id = first.id;
  }
  renderList();
  renderDetail();
}

function mapFamily(id) {
  const m = store.mapById.get(id);
  return m?.family ?? id;
}

function filtered() {
  const terms = norm(state.search).split(/\s+/).filter(Boolean);
  return store.quests.filter((q) => {
    if (state.trader && q.trader !== state.trader) return false;
    if (state.map && !q.maps.some((m) => mapFamily(m) === state.map || m === state.map)) return false;
    if (state.kappa && !q.kappa) return false;
    if (state.lk && !q.lightkeeper) return false;
    if (state.hasItems && !q.items.length) return false;
    const st = questState(q);
    if (state.hideDone && st === "done") return false;
    if (state.onlyAvailable && st !== "available") return false;
    return terms.every((t) => q._search.includes(t));
  });
}

function renderList() {
  const list = root.querySelector("#q-list");
  const quests = filtered();
  const doneCount = store.quests.filter((q) => isDone(q.id)).length;
  root.querySelector("#q-count").innerHTML = String(html`<span>${quests.length} quests</span><span>${doneCount}/${store.quests.length} voltooid</span>`);
  const groups = new Map();
  for (const q of quests) {
    if (!groups.has(q.trader)) groups.set(q.trader, []);
    groups.get(q.trader).push(q);
  }
  const ordered = [...groups.keys()].sort((a, b) => (TRADER_ORDER.indexOf(a) + 1 || 99) - (TRADER_ORDER.indexOf(b) + 1 || 99));
  list.innerHTML = quests.length
    ? ordered.map((t) => String(html`
        <div class="trader-group"><span class="dot" style="background:${traderColor(t)}"></span>${t}<span class="faint">${groups.get(t).length}</span></div>
        ${groups.get(t).map(questRow)}`)).join("")
    : `<div class="empty">Geen quests gevonden.</div>`;
  list.querySelector(".qrow.active")?.scrollIntoView({ block: "nearest" });
}

function questRow(q) {
  const st = questState(q);
  const maps = q.maps.map((m) => store.mapById.get(m)).filter((m) => m && !m.variant).map((m) => m.name);
  const itemCount = q.items.filter((i) => i.kind === "handover" || i.kind === "questitem").length;
  return html`
    <div class="qrow ${st} ${state.id === q.id ? "active" : ""}" data-id="${q.id}">
      <span class="state-dot ${st}" data-toggle="${q.id}" title="${st === "done" ? "Markeer als niet voltooid" : "Markeer als voltooid"}"></span>
      <div style="min-width:0">
        <div class="qtitle">${q.title}</div>
        <div class="qmeta">${q.minLevel ? html`<span>Lvl ${q.minLevel}</span>` : ""}${maps.length ? html`<span>${maps.slice(0, 3).join(", ")}${maps.length > 3 ? "…" : ""}</span>` : ""}</div>
      </div>
      <div class="qbadges">
        ${itemCount ? html`<span class="chip" title="Items inleveren">${itemCount} item${itemCount > 1 ? "s" : ""}</span>` : ""}
        ${q.kappa ? html`<span class="chip kappa" title="Nodig voor Kappa">K</span>` : ""}
        ${q.lightkeeper ? html`<span class="chip lk" title="Nodig voor Lightkeeper">LK</span>` : ""}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function renderDetail() {
  const pane = root.querySelector("#q-detail");
  const q = store.questById.get(state.id);
  if (!q) {
    pane.innerHTML = `<div class="empty">Kies een quest.</div>`;
    return;
  }
  const st = questState(q);
  const maps = q.maps.map((m) => store.mapById.get(m)).filter(Boolean);
  const pinMaps = new Map();
  for (const o of q.apiObjectives) for (const p of o.pins) pinMaps.set(p.map, (pinMaps.get(p.map) ?? 0) + 1);
  const firstPinMap = [...pinMaps.keys()][0];

  pane.innerHTML = String(html`
    <div class="detail-inner">
      <div class="q-head">
        ${q.image ? html`<img class="banner" src="${q.image}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
        <div style="flex:1;min-width:0">
          <h1>${q.title}</h1>
          <div class="q-sub">
            <span class="dot" style="background:${traderColor(q.trader)}"></span><b style="color:var(--text)">${q.trader}</b>
            ${q.minLevel ? html`<span>· Level ${q.minLevel}+</span>` : ""}
            ${q.ll ? html`<span>· LL${q.ll}</span>` : ""}
            ${q.experience ? html`<span>· ${q.experience.toLocaleString("nl-NL")} XP</span>` : ""}
            ${maps.filter((m) => !m.variant || !maps.some((x) => x.id === m.family)).map((m) => html`<span class="chip map">${m.name}</span>`)}
            ${q.kappa ? html`<span class="chip kappa">Kappa</span>` : ""}
            ${q.lightkeeper ? html`<span class="chip lk">Lightkeeper</span>` : ""}
            ${q.event ? html`<span class="chip event">Event</span>` : ""}
            ${q.faction && q.faction !== "Any" ? html`<span class="chip">${q.faction}</span>` : ""}
            <span class="chip src" title="${sourceTitle(q)}">${q.source}</span>
          </div>
          <div class="q-actions">
            <button class="btn ${st === "done" ? "done" : "primary"}" id="qd-done">${st === "done" ? "✓ Voltooid" : "Markeer voltooid"}</button>
            ${st !== "done" && q.requires.length ? html`<button class="btn" id="qd-done-all" title="Markeert ook alle voorgaande quests als voltooid">Voltooid + voorgaande</button>` : ""}
            ${firstPinMap ? html`<a class="btn" href="#/map/${encodeURIComponent(firstPinMap)}?quest=${encodeURIComponent(q.id)}">Toon op kaart</a>` : ""}
            ${q.wiki ? html`<a class="btn" href="${q.wiki}" target="_blank" rel="noopener">Wiki ↗</a>` : ""}
            ${st === "locked" ? html`<span class="chip warn">Nog niet beschikbaar</span>` : ""}
          </div>
        </div>
      </div>

      ${itemsCard(q)}

      <div class="grid-2">
        <div class="card">
          <h3>Doelen</h3>
          ${objectivesList(q)}
          ${q.apiObjectives.length && q.source !== "api" ? html`
            <details style="margin-top:10px"><summary>In-game tekst (json.tarkov.dev)</summary>
              <ul class="richtext" style="margin-top:6px">${q.apiObjectives.map((o) => html`<li>${o.text || o.type}${o.optional ? html` <span class="faint">(optioneel)</span>` : ""}</li>`)}</ul>
            </details>` : ""}
        </div>
        <div class="card">
          <h3>Vereisten</h3>
          ${requirementsBlock(q)}
        </div>
      </div>

      ${pinMaps.size ? html`
        <div class="card">
          <h3>Locaties op de kaart</h3>
          <div class="filter-row">
            ${[...pinMaps].map(([m, n]) => html`<a class="btn small" href="#/map/${encodeURIComponent(m)}?quest=${encodeURIComponent(q.id)}">${store.mapById.get(m)?.name ?? m} · ${n} punt${n > 1 ? "en" : ""}</a>`)}
          </div>
        </div>` : q.maps.length ? html`
        <div class="card"><h3>Locaties op de kaart</h3><p class="muted" style="margin:0">Geen coördinaten in de game-data voor deze quest. Gebruik de wiki-afbeeldingen in de guide hieronder.</p></div>` : ""}

      ${q.guideHtml || q.guideImages.length ? html`
        <div class="card">
          <h3>Guide <span class="count">(wiki)</span></h3>
          <div class="richtext">${raw(q.guideHtml)}</div>
          ${q.guideImages.length ? html`<div class="gallery">${q.guideImages.filter((g) => g.thumb).map((g) => html`
            <figure data-full="${g.url}" data-cap="${g.caption}"><img src="${g.thumb}" alt="" loading="lazy" referrerpolicy="no-referrer"><figcaption>${g.caption || g.file}</figcaption></figure>`)}</div>` : ""}
        </div>` : ""}

      ${q.rewardsHtml ? html`<div class="card"><h3>Beloningen</h3><div class="richtext">${raw(q.rewardsHtml)}</div></div>` : ""}

      <div class="attrib">
        ${q.wiki ? html`Tekst en afbeeldingen: <a href="${q.wiki}" target="_blank" rel="noopener">Escape from Tarkov Wiki</a> (CC BY-SA)${q.wikiRevision ? html`, revisie ${new Date(q.wikiRevision.timestamp).toLocaleDateString("nl-NL")}` : ""}. ` : ""}
        Coördinaten, iconen en prijzen: json.tarkov.dev.
      </div>
    </div>`);

  pane.querySelector("#qd-done")?.addEventListener("click", () => setDone(q.id, !isDone(q.id)));
  pane.querySelector("#qd-done-all")?.addEventListener("click", () => setDoneWithPrereqs(q.id));
  pane.querySelectorAll(".gallery figure").forEach((f) => f.addEventListener("click", () => openLightbox(f.dataset.full, f.dataset.cap)));
  pane.querySelectorAll("[data-obj]").forEach((cb) =>
    cb.addEventListener("change", () => {
      if (cb.checked) store.progress.objectives[cb.dataset.obj] = true;
      else delete store.progress.objectives[cb.dataset.obj];
      cb.closest("li").classList.toggle("checked", cb.checked);
      saveProgress();
    })
  );
  pane.scrollTop = 0;
}

function sourceTitle(q) {
  if (q.source === "wiki+api") return "Gevonden op de wiki én in de game-data";
  if (q.source === "wiki") return "Alleen op de wiki (bijv. event, Arena of nieuwer dan de game-data)";
  return "Alleen in de game-data, geen wiki-pagina gevonden";
}

function objectivesList(q) {
  if (!q.objectives.length) return html`<p class="muted">Geen doelen bekend.</p>`;
  return html`<ul class="objectives">${q.objectives.map((o, i) => {
    const key = `${q.id}:${i}`;
    const checked = !!store.progress.objectives[key];
    return html`<li class="${o.depth > 1 ? "sub" : ""} ${checked ? "checked" : ""}">
      <input type="checkbox" data-obj="${key}" ${checked ? "checked" : ""}>
      <span class="otext">${raw(o.html)}${o.optional && !/optional/i.test(o.text) ? html` <span class="faint">(optioneel)</span>` : ""}</span>
    </li>`;
  })}</ul>`;
}

function requirementsBlock(q) {
  const prereqs = q.requires.map((r) => store.questById.get(r.id)).filter(Boolean);
  const next = q.leadsTo.map((id) => store.questById.get(id)).filter(Boolean);
  const link = (x) => html`<a href="#/quests/${encodeURIComponent(x.id)}" class="${isDone(x.id) ? "done" : ""}">${x.title}</a>`;
  return html`
    ${q.minLevel ? html`<p style="margin:0 0 8px">Level <b>${q.minLevel}</b>${store.progress.level ? html` <span class="muted">(jij: ${store.progress.level})</span>` : ""}</p>` : ""}
    ${q.traderRequirements.length ? html`<p style="margin:0 0 8px">${q.traderRequirements.map((r) => html`<span class="chip">${r.trader} ${r.type === "level" ? "LL" : r.type} ${r.value}</span> `)}</p>` : ""}
    ${prereqs.length ? html`<div class="section-title">Eerst voltooien</div><div class="chain" style="margin-bottom:10px">${prereqs.map(link)}</div>` : ""}
    ${next.length ? html`<div class="section-title">Ontgrendelt</div><div class="chain" style="margin-bottom:10px">${next.map(link)}</div>` : ""}
    ${q.requirementsHtml ? html`<div class="richtext">${raw(q.requirementsHtml)}</div>` : ""}
    ${!prereqs.length && !next.length && !q.requirementsHtml && !q.minLevel ? html`<p class="muted">Geen bijzondere vereisten.</p>` : ""}`;
}

export function itemsCard(q) {
  if (!q.items.length) return "";
  return html`
    <div class="card highlight">
      <h3>Benodigde items <span class="count">${q.items.length}</span></h3>
      <table class="itable">
        <thead><tr><th>Item</th><th>Aantal</th><th>Type</th><th>Prijs</th></tr></thead>
        <tbody>${q.items.map(itemRow)}</tbody>
      </table>
    </div>`;
}

function itemRow(entry) {
  const list = entry.itemIds.map((id) => store.items[id]).filter(Boolean);
  const first = list[0];
  const many = list.length > 4;
  const countLabel = entry.count ?? entry.countText ?? "–";
  const names = many
    ? html`<span>Een van ${list.length} items</span>${entry.text ? html`<span class="alt">${entry.text}</span>` : ""}
        <details><summary>Toon alle</summary><div class="alt-list">${list.map((it) => html`<img src="${it.icon ?? ""}" title="${it.name}" alt="" loading="lazy" referrerpolicy="no-referrer">`)}</div></details>`
    : html`${list.map((it, i) => html`${i ? html`<span class="alt">of</span>` : ""}<a href="${it.wiki ?? "#"}" target="_blank" rel="noopener" style="color:var(--text)">${it.name}</a>`)}
        ${entry.map ? html`<span class="alt">${store.mapById.get(entry.map)?.name ?? entry.map}</span>` : ""}`;
  const price = first && !many ? first.avg24h ?? first.lastLow : null;
  return html`<tr>
    <td>
      <div class="iname">${many ? html`<span class="icon-ph"></span>` : itemIcon(first)}
        <div class="names">${names}${entry.notesHtml ? html`<span class="alt">${raw(entry.notesHtml)}</span>` : ""}</div>
      </div>
    </td>
    <td><span class="qty ${typeof entry.count === "number" ? "" : "txt"}">${countLabel}${typeof entry.count === "number" ? "×" : ""}</span>
      ${entry.apiCount != null && entry.count != null && entry.apiCount !== entry.count ? html`<div class="faint" style="font-size:11px">game-data: ${entry.apiCount}</div>` : ""}
      ${entry.fir ? html`<div><span class="chip fir">FIR</span></div>` : ""}
    </td>
    <td><span class="kind ${entry.kind}" title="${entry.requirement ?? ""}">${KIND_LABEL[entry.kind] ?? entry.kind}</span>${entry.optional ? html`<div class="faint" style="font-size:11px">optioneel</div>` : ""}</td>
    <td class="price">${first?.questItem ? "quest-item" : first?.fleaBanned ? "geen flea" : price ? rub(price) : "–"}
      ${first?.bestSell && !many ? html`<div class="faint" title="Beste handelaar-verkoopprijs">${first.bestSell.trader}: ${rub(first.bestSell.price)}</div>` : ""}
    </td>
  </tr>`;
}
