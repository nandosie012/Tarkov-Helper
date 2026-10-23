import { store, go } from "../app.js";
import { html, raw, pct, itemIcon, openLightbox } from "../util.js";

let root;

export function mount(el, route) {
  root = el;
  el.innerHTML = `<div class="page"><div class="page-body scroll" id="b-body"></div></div>`;
  el.addEventListener("click", (e) => {
    const card = e.target.closest("[data-boss]");
    if (card) {
      go(`#/bosses/${encodeURIComponent(card.dataset.boss)}`);
      return;
    }
    const img = e.target.closest("[data-full]");
    if (img) openLightbox(img.dataset.full, img.dataset.cap);
  });
  update(route);
}

export function update(route) {
  const body = root.querySelector("#b-body");
  const boss = route.param ? store.bossById.get(route.param) : null;
  body.innerHTML = String(boss ? detail(boss) : overview());
  body.scrollTop = 0;
}

function overview() {
  const bosses = store.bosses.filter((b) => b.isBoss);
  const specials = store.bosses.filter((b) => !b.isBoss);
  const card = (b) => html`<div class="boss-card ${b.isBoss ? "" : "special"}" data-boss="${b.id}">
    <img src="${b.portrait ?? ""}" alt="" referrerpolicy="no-referrer">
    <div style="min-width:0">
      <div style="font-weight:600;font-size:15px">${b.name}</div>
      <div class="muted" style="font-size:12px">${b.faction ?? ""}${b.event ? ` · event: ${b.event}` : ""}</div>
      <div class="maps">${b.spawns.length
        ? b.spawns.map((s) => html`<span class="chip map">${s.mapName} <b style="color:var(--red)">${pct(s.spawnChance)}</b></span>`)
        : html`<span class="chip">geen actieve spawns</span>`}</div>
    </div>
  </div>`;
  return html`
    <h2 style="font-size:17px;margin-bottom:4px">Bosses</h2>
    <p class="muted" style="margin:0 0 14px">Spawnkansen uit de game-data (json.tarkov.dev), beschrijvingen en locatie-afbeeldingen van de wiki. Klik voor details of open de kaart.</p>
    <div class="boss-grid">${bosses.map(card)}</div>
    ${specials.length ? html`<h2 style="font-size:15px;margin:22px 0 10px">Raiders, Rogues, Cultists en andere speciale vijanden</h2><div class="boss-grid">${specials.map(card)}</div>` : ""}`;
}

function detail(b) {
  const healthOrder = ["head", "thorax", "chest", "stomach", "arms", "legs", "total"];
  const health = b.health ? healthOrder.filter((k) => b.health[k] != null).map((k) => [k, b.health[k]]) : [];
  const equipment = b.equipment.map((id) => store.items[id]).filter(Boolean);
  return html`
    <div class="detail-inner" style="padding:0">
      <p style="margin:0 0 12px"><a href="#/bosses">← Alle bosses</a></p>
      <div class="boss-hero">
        <img src="${b.portrait ?? ""}" alt="" referrerpolicy="no-referrer">
        <div>
          <h1 style="font-size:26px">${b.name}</h1>
          <div class="q-sub">${b.faction ? html`<span class="chip">${b.faction}</span>` : ""}${b.event ? html`<span class="chip event">Event: ${b.event}</span>` : ""}
            ${b.wiki ? html`<a class="btn small" href="${b.wiki}" target="_blank" rel="noopener">Wiki ↗</a>` : ""}</div>
          ${b.followersHtml ? html`<p style="margin:8px 0 0"><span class="muted">Volgers:</span> ${raw(b.followersHtml)}</p>` : ""}
        </div>
      </div>

      ${health.length ? html`<div class="card"><h3>Health</h3><div class="health">${health.map(([k, v]) => html`<div><b>${v}</b><span>${{ head: "Hoofd", thorax: "Borst", chest: "Borst", stomach: "Buik", arms: "Armen", legs: "Benen", total: "Totaal" }[k]}</span></div>`)}</div></div>` : ""}

      ${b.spawns.map((s) => html`
        <div class="card spawn-card">
          <div style="display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap">
            <h3 style="margin:0">${s.mapName}</h3>
            <div style="display:flex;gap:10px;align-items:center"><span class="big-pct">${pct(s.spawnChance)}</span>
              <a class="btn primary small" href="#/map/${encodeURIComponent(s.map)}?boss=${encodeURIComponent(b.id)}">Toon op kaart</a></div>
          </div>
          ${s.escortOf ? html`<p class="muted" style="margin:6px 0 0">Spawnt als escort van <b>${s.escortOf}</b>; de kans is die van ${s.escortOf}.</p>` : ""}
          ${s.waves?.length > 1 ? html`<p class="muted" style="margin:6px 0 0">${s.waves.length} spawngroepen in de game-data (${s.waves.map((w) => `${pct(w.chance)}${w.trigger ? ` na ${w.trigger}` : w.spawnTime > 0 ? ` na ${Math.round(w.spawnTime / 60)} min` : ""}`).join(", ")}). Bovenaan staat de kans op minstens één.</p>` : ""}
          <div class="grid-2" style="margin-top:10px">
            <div>
              <div class="section-title">Spawnzones (game-data)</div>
              <ul class="richtext" style="margin:0">${s.locations.map((l) => html`<li>${l.name}${s.locations.length > 1 && l.chance != null ? html` <span class="muted">${pct(l.chance)}</span>` : ""}${l.positions.length ? "" : html` <span class="faint">(geen coördinaten)</span>`}</li>`)}</ul>
              ${s.escorts.length ? html`<div class="section-title" style="margin-top:10px">Escort</div><ul class="richtext" style="margin:0">${s.escorts.map((e) => html`<li>${e.name}: ${e.amounts.map((a) => `${a.count}× (${pct(a.chance)})`).join(", ")}</li>`)}</ul>` : ""}
              ${s.spawnTrigger ? html`<p class="muted">Trigger: ${s.spawnTrigger}</p>` : ""}
            </div>
            <div>
              <div class="section-title">Wiki</div>
              <div class="richtext">${raw(s.wikiHtml || s.wikiLocationHtml || "<p class='muted'>Geen wiki-beschrijving voor deze map.</p>")}</div>
            </div>
          </div>
          ${s.wikiImages.some((i) => i.thumb) ? html`<div class="gallery">${s.wikiImages.filter((i) => i.thumb).map((i) => html`<figure data-full="${i.url}" data-cap="${i.caption}"><img src="${i.thumb}" alt="" loading="lazy" referrerpolicy="no-referrer"><figcaption>${i.caption || i.file}</figcaption></figure>`)}</div>` : ""}
        </div>`)}

      ${b.wikiOnlyMaps?.length ? html`<div class="card"><h3>Andere locaties (wiki)</h3>${b.wikiOnlyMaps.map((w) => html`<h4 style="margin:8px 0 4px">${w.map}</h4><div class="richtext">${raw(w.html)}</div>
        ${w.images.some((i) => i.thumb) ? html`<div class="gallery">${w.images.filter((i) => i.thumb).map((i) => html`<figure data-full="${i.url}" data-cap="${i.caption}"><img src="${i.thumb}" alt="" loading="lazy" referrerpolicy="no-referrer"><figcaption>${i.caption || i.file}</figcaption></figure>`)}</div>` : ""}`)}</div>` : ""}

      ${equipment.length ? html`<div class="card"><h3>Opvallende uitrusting</h3><div class="equip">${equipment.map((it) => html`<a href="${it.wiki ?? "#"}" target="_blank" rel="noopener">${itemIcon(it, "sm")}${it.name}</a>`)}</div></div>` : ""}
      ${b.questsHtml ? html`<div class="card"><h3>Quests</h3><div class="richtext">${raw(b.questsHtml)}</div></div>` : ""}
      ${b.behaviorHtml ? html`<div class="card"><h3>Gedrag (wiki)</h3><div class="richtext">${raw(b.behaviorHtml)}</div></div>` : ""}
      <div class="attrib">Beschrijvingen en afbeeldingen: Escape from Tarkov Wiki (CC BY-SA). Spawnkansen en posities: json.tarkov.dev.</div>
    </div>`;
}
