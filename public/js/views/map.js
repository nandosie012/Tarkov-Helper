/* global L */
import { store, questState, isDone, setDone, go } from "../app.js";
import { html, raw, pct, traderColor, openLightbox, norm } from "../util.js";

const PREF_KEY = "tarkov-helper-map-prefs";
const svgCache = new Map();

let root;
let map = null;
let mapData = null;
let groups = {};
let markerIndex = { bosses: new Map(), quests: new Map() };
let state = {
  mapId: "customs",
  floor: null,
  show: { bosses: true, specials: true, quests: true, transits: true, hazards: false, locks: false },
  extractMode: "all", // all | pmc | scav | off
  questScope: "open",
  hiddenBosses: [],
  focusQuest: null,
  focusBoss: null,
};

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}");
    // older prefs had a single on/off "extracts" toggle
    if (saved.extractMode == null && saved.show?.extracts === false) saved.extractMode = "off";
    if (saved.show) delete saved.show.extracts;
    state = { ...state, ...saved, show: { ...state.show, ...(saved.show ?? {}) }, floor: null, focusQuest: null, focusBoss: null };
  } catch {
    /* ignore */
  }
}
function savePrefs() {
  try {
    const { floor, focusQuest, focusBoss, ...rest } = state;
    localStorage.setItem(PREF_KEY, JSON.stringify(rest));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Coordinates: same projection as tarkov.dev (game x/z -> Leaflet lng/lat)
// ---------------------------------------------------------------------------

function applyRotation(latLng, rotation) {
  if (!latLng.lng && !latLng.lat) return L.latLng(0, 0);
  if (!rotation) return latLng;
  const a = (rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const { lng: x, lat: y } = latLng;
  return L.latLng(x * sin + y * cos, x * cos - y * sin);
}

function getCRS(cfg) {
  let [scaleX, marginX, scaleY, marginY] = [1, 0, 1, 0];
  if (cfg.transform) {
    scaleX = cfg.transform[0];
    marginX = cfg.transform[1];
    scaleY = cfg.transform[2] * -1;
    marginY = cfg.transform[3];
  }
  return L.extend({}, L.CRS.Simple, {
    transformation: new L.Transformation(scaleX, marginX, scaleY, marginY),
    projection: L.extend({}, L.Projection.LonLat, {
      project: (latLng) => L.Projection.LonLat.project(applyRotation(latLng, cfg.coordinateRotation)),
      unproject: (point) => applyRotation(L.Projection.LonLat.unproject(point), cfg.coordinateRotation * -1),
    }),
  });
}

const pos = (p) => [p.z, p.x];
const getBounds = (b) => (b ? L.latLngBounds([b[0][1], b[0][0]], [b[1][1], b[1][0]]) : null);

function inLayer(p, layer) {
  if (!p || !layer) return false;
  for (const ext of layer.extents ?? []) {
    const [lo, hi] = ext.height ?? [-Infinity, Infinity];
    if (p.y < lo || p.y >= hi) continue;
    if (!ext.bounds?.length) return true;
    for (const [[x1, z1], [x2, z2]] of ext.bounds) {
      if (p.x >= Math.min(x1, x2) && p.x <= Math.max(x1, x2) && p.z >= Math.min(z1, z2) && p.z <= Math.max(z1, z2)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Mount / update
// ---------------------------------------------------------------------------

const onProgress = () => {
  if (map) {
    drawQuests();
    renderQuestList();
  }
};

export function mount(el, route) {
  root = el;
  loadPrefs();
  const usable = store.maps.filter((m) => m.config && (m.config.svg || m.config.tilePath));
  const main = usable.filter((m) => !m.variant);
  const variants = usable.filter((m) => m.variant);
  el.innerHTML = String(html`
    <div class="map-layout">
      <aside class="map-side">
        <div class="block">
          <select class="input" id="m-select">
            ${main.map((m) => html`<option value="${m.id}">${m.name}</option>`)}
            ${variants.length ? html`<optgroup label="Varianten">${variants.map((m) => html`<option value="${m.id}">${m.name}</option>`)}</optgroup>` : ""}
          </select>
          <div class="muted" id="m-info" style="font-size:12px;margin-top:6px"></div>
        </div>
        <div class="block">
          <div class="section-title">Lagen</div>
          <div class="layer-toggles">
            ${[["bosses", "Bosses"], ["specials", "Raiders / Rogues / Cultists"], ["quests", "Quest-locaties"], ["transits", "Transits"], ["hazards", "Mijnen / snipers"], ["locks", "Sloten (keys)"]].map(([k, label]) => html`<label class="check"><input type="checkbox" data-show="${k}" ${state.show[k] ? "checked" : ""}>${label}</label>`)}
          </div>
          <div class="section-title" style="margin-top:10px">Extracts</div>
          <div class="floors" id="m-extract-mode">
            ${[["all", "Alle"], ["pmc", "Als PMC"], ["scav", "Als Scav"], ["off", "Uit"]].map(([k, label]) => html`<button class="chip ${state.extractMode === k ? "on" : ""}" data-extract-mode="${k}">${label}</button>`)}
          </div>
          <div class="extract-legend">
            <span><i class="mk-extract-pmc"></i>PMC</span>
            <span><i class="mk-extract-scav"></i>Scav</span>
            <span><i class="mk-extract-shared"></i>PMC + Scav</span>
            <span><i class="mk-extract-coop"></i>Co-op (samen)</span>
          </div>
          <div id="m-floors" style="margin-top:10px"></div>
        </div>
        <div class="scroll" style="flex:1">
          <div class="block" style="padding-bottom:4px"><div class="section-title">Bosses op deze map</div></div>
          <div id="m-bosses"></div>
          <div class="block" style="padding-bottom:6px;border-top:1px solid var(--border)">
            <div class="section-title" style="display:flex;justify-content:space-between;align-items:center">Quests op deze map
              <select class="input" id="m-qscope" style="width:auto;padding:2px 6px;font-size:12px">
                <option value="open" ${state.questScope === "open" ? "selected" : ""}>Open</option>
                <option value="available" ${state.questScope === "available" ? "selected" : ""}>Beschikbaar</option>
                <option value="all" ${state.questScope === "all" ? "selected" : ""}>Alle</option>
              </select>
            </div>
            <input class="input" id="m-qsearch" type="search" placeholder="Filter quests…" style="margin-top:4px">
          </div>
          <div id="m-quests"></div>
        </div>
      </aside>
      <div class="map-wrap">
        <div id="leaflet"></div>
        <div id="m-focus"></div>
        <div class="coords" id="m-coords"></div>
      </div>
    </div>`);

  el.querySelector("#m-select").addEventListener("change", (e) => go(`#/map/${encodeURIComponent(e.target.value)}`));
  el.querySelector("#m-extract-mode").addEventListener("click", (e) => {
    const b = e.target.closest("[data-extract-mode]");
    if (!b) return;
    state.extractMode = b.dataset.extractMode;
    for (const c of el.querySelectorAll("[data-extract-mode]")) c.classList.toggle("on", c === b);
    savePrefs();
    drawExtracts();
  });
  for (const cb of el.querySelectorAll("[data-show]")) cb.addEventListener("change", () => {
    state.show[cb.dataset.show] = cb.checked;
    savePrefs();
    drawAll();
  });
  el.querySelector("#m-qscope").addEventListener("change", (e) => {
    state.questScope = e.target.value;
    savePrefs();
    drawQuests();
    renderQuestList();
  });
  el.querySelector("#m-qsearch").addEventListener("input", () => renderQuestList());
  el.querySelector("#m-bosses").addEventListener("click", onBossListClick);
  el.querySelector("#m-quests").addEventListener("click", (e) => {
    const li = e.target.closest("[data-quest]");
    if (li) go(`#/map/${encodeURIComponent(state.mapId)}?quest=${encodeURIComponent(li.dataset.quest)}`);
  });
  el.querySelector("#m-focus").addEventListener("click", (e) => {
    if (e.target.closest("[data-clear-focus]")) go(`#/map/${encodeURIComponent(state.mapId)}`);
    const img = e.target.closest("img[data-full]");
    if (img) openLightbox(img.dataset.full, img.dataset.cap);
  });
  window.addEventListener("progress", onProgress);
  update(route);
}

export function unmount() {
  window.removeEventListener("progress", onProgress);
  map?.remove();
  map = null;
}

export async function update(route) {
  const usable = store.maps.filter((m) => m.config && (m.config.svg || m.config.tilePath));
  let id = route.param ?? state.mapId;
  let m = store.mapById.get(id);
  if (!m?.config || !(m.config.svg || m.config.tilePath)) m = usable.find((x) => x.id === m?.family) ?? usable.find((x) => x.id === "customs") ?? usable[0];
  state.focusQuest = route.query.get("quest");
  state.focusBoss = route.query.get("boss");
  const changed = !map || m.id !== mapData?.id;
  state.mapId = m.id;
  savePrefs();
  root.querySelector("#m-select").value = m.id;
  if (changed) {
    state.floor = null;
    await buildMap(m);
  } else {
    drawAll();
  }
  renderSide();
  fitFocus();
}

// ---------------------------------------------------------------------------
// Map construction
// ---------------------------------------------------------------------------

async function loadSvg(file) {
  if (!svgCache.has(file)) {
    svgCache.set(file, fetch(`data/${file}`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status)))));
  }
  return svgCache.get(file);
}

function svgElement(text, cfg, onlyLayer) {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = doc.documentElement;
  const floorIds = cfg.layers.map((l) => l.svgLayer).filter(Boolean);
  if (onlyLayer) {
    const keep = svg.querySelector(`#${CSS.escape(onlyLayer)}`);
    for (const child of [...svg.children]) {
      if (child.tagName.toLowerCase() === "g" && !(keep && (child === keep || child.contains(keep)))) child.style.display = "none";
    }
  } else {
    for (const id of floorIds) {
      const g = svg.querySelector(`#${CSS.escape(id)}`);
      if (g) g.style.display = "none";
    }
  }
  return document.importNode(svg, true);
}

async function buildMap(m) {
  map?.remove();
  mapData = m;
  const cfg = m.config;
  const container = root.querySelector("#leaflet");
  map = L.map(container, {
    crs: getCRS(cfg),
    minZoom: cfg.minZoom,
    maxZoom: cfg.maxZoom + 1,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 90,
    attributionControl: true,
  });
  const bounds = getBounds(cfg.bounds);
  map.fitBounds(bounds);
  map.setMaxBounds(bounds.pad(0.6));
  map.attributionControl.setPrefix(false);
  map.attributionControl.addAttribution(
    `Kaart: <a href="${cfg.authorLink ?? "https://tarkov.dev"}" target="_blank" rel="noopener">${cfg.author ?? "tarkov.dev"}</a> (<a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener">CC BY-NC-SA 4.0</a>) · data: EFT Wiki, json.tarkov.dev`
  );

  groups = {};
  for (const k of ["base", "floor", "hazards", "extracts", "transits", "locks", "quests", "bosses"]) groups[k] = L.layerGroup().addTo(map);

  if (cfg.svg) {
    try {
      const text = await loadSvg(cfg.svg);
      if (mapData !== m) return;
      groups.base.addLayer(L.svgOverlay(svgElement(text, cfg, null), getBounds(cfg.svgBounds ?? cfg.bounds), { interactive: false }));
    } catch {
      addTiles(cfg, cfg.tilePath, groups.base);
    }
  } else {
    addTiles(cfg, cfg.tilePath, groups.base);
  }

  map.on("mousemove", (e) => {
    root.querySelector("#m-coords").textContent = `x ${e.latlng.lng.toFixed(1)}  z ${e.latlng.lat.toFixed(1)}`;
  });
  map.getContainer().addEventListener("click", onMapClick);
  drawAll();
}

function addTiles(cfg, path, group) {
  if (!path) return;
  group.addLayer(
    L.tileLayer(path, {
      tileSize: cfg.tileSize,
      bounds: getBounds(cfg.bounds),
      minZoom: cfg.minZoom,
      maxZoom: cfg.maxZoom + 1,
      maxNativeZoom: cfg.maxZoom,
      noWrap: true,
    })
  );
}

async function setFloor(name) {
  state.floor = name;
  const cfg = mapData.config;
  groups.floor.clearLayers();
  const layer = cfg.layers.find((l) => l.name === name);
  for (const l of groups.base.getLayers()) l.setOpacity?.(layer ? 0.45 : 1);
  if (layer) {
    if (cfg.svg && layer.svgLayer) {
      const text = await loadSvg(cfg.svg);
      groups.floor.addLayer(L.svgOverlay(svgElement(text, cfg, layer.svgLayer), getBounds(cfg.svgBounds ?? cfg.bounds), { interactive: false }));
    } else if (layer.tilePath) {
      addTiles(cfg, layer.tilePath, groups.floor);
    }
  }
  renderFloors();
  drawAll();
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

function dimFor(p) {
  const layer = mapData.config.layers.find((l) => l.name === state.floor);
  if (!layer || !p) return "";
  return inLayer(p, layer) ? "" : "dim";
}

function drawAll() {
  if (!map) return;
  drawBosses();
  drawQuests();
  drawExtracts();
  drawTransits();
  drawHazards();
  drawLocks();
}

function bossesHere() {
  return store.bosses
    .map((b) => ({ boss: b, spawn: b.spawns.find((s) => s.map === mapData.id) }))
    .filter((x) => x.spawn);
}

function drawBosses() {
  groups.bosses.clearLayers();
  markerIndex.bosses = new Map();
  for (const { boss, spawn } of bossesHere()) {
    if (state.focusQuest) continue;
    if (state.focusBoss && state.focusBoss !== boss.id) continue;
    if (!state.focusBoss && (boss.isBoss ? !state.show.bosses : !state.show.specials)) continue;
    if (!state.focusBoss && state.hiddenBosses.includes(boss.id)) continue;
    const list = [];
    for (const loc of spawn.locations) {
      for (const p of loc.positions) {
        const size = boss.isBoss ? 38 : 26;
        const icon = L.divIcon({
          className: "",
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
          popupAnchor: [0, -size / 2],
          html: `<div class="mk mk-boss ${boss.isBoss ? "" : "special"} ${dimFor(p)}" style="background-image:url('${boss.portrait ?? ""}')"><span class="pc">${pct(spawn.spawnChance)}</span></div>`,
        });
        const marker = L.marker(pos(p), { icon, riseOnHover: true, zIndexOffset: 1000 }).bindPopup(() => bossPopup(boss, spawn, loc), { maxWidth: 380 });
        marker.bindTooltip(`${boss.name} · ${loc.name}`, { direction: "top", offset: [0, -20] });
        groups.bosses.addLayer(marker);
        list.push(marker);
      }
    }
    markerIndex.bosses.set(boss.id, list);
  }
}

function bossPopup(boss, spawn, loc) {
  const others = spawn.locations.filter((l) => l !== loc);
  return String(html`<div class="pop">
    <div class="row">
      ${boss.portrait ? html`<img class="portrait" src="${boss.portrait}" alt="" referrerpolicy="no-referrer">` : ""}
      <div>
        <h4><a href="#/bosses/${encodeURIComponent(boss.id)}">${boss.name}</a></h4>
        <div class="small">${boss.faction ?? ""}${boss.event ? ` · event: ${boss.event}` : ""}</div>
      </div>
    </div>
    <div><b style="color:var(--red);font-size:16px">${pct(spawn.spawnChance)}</b> <span class="small">spawnkans op ${spawn.mapName} (game-data)</span></div>
    ${spawn.escortOf ? html`<div class="small">Spawnt als escort van ${spawn.escortOf}</div>` : ""}
    ${spawn.waves?.length > 1 ? html`<div class="small">${spawn.waves.length} spawngroepen; kans dat er minstens één spawnt</div>` : ""}
    <div style="margin-top:4px">Zone: <b>${loc.name}</b>${loc.chance != null && spawn.locations.length > 1 ? html` <span class="small">(${pct(loc.chance)} van de spawns)</span>` : ""}</div>
    ${others.length ? html`<div class="small">Andere zones: ${others.map((o) => `${o.name} (${pct(o.chance)})${o.positions.length ? "" : " – geen coördinaten"}`).join(", ")}</div>` : ""}
    ${spawn.escorts.length ? html`<div class="small" style="margin-top:4px">Escort: ${spawn.escorts.map((e) => `${e.name} ×${escortRange(e)}`).join(", ")}</div>` : ""}
    ${spawn.spawnTrigger ? html`<div class="small">Trigger: ${spawn.spawnTrigger}</div>` : ""}
    ${spawn.wikiLocationHtml || spawn.wikiHtml ? html`<div class="richtext small" style="margin-top:6px;color:var(--text)">${raw(spawn.wikiHtml || spawn.wikiLocationHtml)}</div>` : ""}
    ${spawn.wikiImages?.filter((i) => i.thumb).slice(0, 2).map((i) => html`<img class="wikiimg" src="${i.thumb}" data-full="${i.url}" data-cap="${i.caption}" alt="" referrerpolicy="no-referrer">`)}
    <div class="actions">
      <a class="btn small" href="#/bosses/${encodeURIComponent(boss.id)}">Boss-details</a>
      ${boss.wiki ? html`<a class="btn small" href="${boss.wiki}" target="_blank" rel="noopener">Wiki ↗</a>` : ""}
    </div>
  </div>`);
}

function escortRange(e) {
  const counts = e.amounts.map((a) => a.count).filter((c) => c != null);
  if (!counts.length) return "?";
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  return min === max ? `${min}` : `${min}-${max}`;
}

function familyIds() {
  const fam = mapData.family ?? mapData.id;
  return new Set(store.maps.filter((m) => (m.family ?? m.id) === fam).map((m) => m.id));
}

function questsHere() {
  const fam = familyIds();
  const out = [];
  for (const q of store.quests) {
    const objs = q.apiObjectives.filter((o) => o.pins.some((p) => fam.has(p.map)));
    if (objs.length) out.push({ quest: q, objs });
  }
  return out;
}

function questVisible(q) {
  if (state.focusQuest) return q.id === state.focusQuest;
  if (state.focusBoss) return false;
  if (!state.show.quests) return false;
  const st = questState(q);
  if (state.questScope === "open") return st !== "done";
  if (state.questScope === "available") return st === "available";
  return true;
}

function drawQuests() {
  groups.quests.clearLayers();
  markerIndex.quests = new Map();
  const fam = familyIds();
  for (const { quest, objs } of questsHere()) {
    if (!questVisible(quest)) continue;
    const color = traderColor(quest.trader);
    const done = isDone(quest.id);
    const list = [];
    const seen = new Set();
    for (const o of objs) {
      for (const p of o.pins) {
        if (!fam.has(p.map)) continue;
        const key = `${o.id}:${Math.round(p.x)}:${Math.round(p.z)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const dim = dimFor(p);
        if (p.outline) {
          groups.quests.addLayer(L.polygon(p.outline.map(([x, z]) => [z, x]), { color, weight: 1.5, dashArray: "4 3", fillOpacity: 0.12, opacity: dim ? 0.3 : 0.9, interactive: false }));
        }
        const icon = p.kind === "possible"
          ? L.divIcon({ className: "", iconSize: [12, 12], iconAnchor: [6, 6], html: `<div class="mk mk-possible ${dim}" style="background:${color};color:${color}"></div>` })
          : L.divIcon({ className: "", iconSize: [24, 24], iconAnchor: [12, 24], popupAnchor: [0, -22], html: `<div class="mk mk-quest ${done ? "done" : ""} ${dim}" style="background:${color}"><span>${typeGlyph(o.type)}</span></div>` });
        const marker = L.marker(pos(p), { icon, riseOnHover: true }).bindPopup(() => questPopup(quest, o), { maxWidth: 360 });
        marker.bindTooltip(`${quest.title}`, { direction: "top", offset: [0, -20] });
        groups.quests.addLayer(marker);
        list.push(marker);
      }
    }
    markerIndex.quests.set(quest.id, list);
  }
}

function typeGlyph(type) {
  return { visit: "!", mark: "M", plantItem: "P", plantQuestItem: "P", findQuestItem: "?", giveQuestItem: "?", extract: "E", shoot: "×", useItem: "U" }[type] ?? "!";
}

function questPopup(q, o) {
  const items = [...o.items, o.questItem, o.markerItem].filter(Boolean).map((id) => store.items[id]).filter(Boolean);
  return String(html`<div class="pop">
    <h4><a href="#/quests/${encodeURIComponent(q.id)}">${q.title}</a></h4>
    <div class="small"><span class="dot" style="background:${traderColor(q.trader)}"></span> ${q.trader}${q.minLevel ? ` · level ${q.minLevel}` : ""}${q.kappa ? " · Kappa" : ""}</div>
    <p style="margin:8px 0 4px">${o.text || o.type}${o.optional ? html` <span class="small">(optioneel)</span>` : ""}</p>
    ${items.length ? html`<div class="items">${items.slice(0, 10).map((it) => html`<img src="${it.icon ?? ""}" title="${it.name}" alt="" referrerpolicy="no-referrer">`)}</div>` : ""}
    <div class="actions">
      <a class="btn small" href="#/quests/${encodeURIComponent(q.id)}">Quest openen</a>
      <button class="btn small ${isDone(q.id) ? "done" : ""}" data-done="${q.id}">${isDone(q.id) ? "✓ Voltooid" : "Markeer voltooid"}</button>
      <a class="btn small" href="#/map/${encodeURIComponent(state.mapId)}?quest=${encodeURIComponent(q.id)}">Alleen deze</a>
    </div>
  </div>`);
}

const EXTRACT_KIND = {
  pmc: { cls: "mk-extract-pmc", label: "PMC-extract" },
  scav: { cls: "mk-extract-scav", label: "Scav-extract" },
  both: { cls: "mk-extract-shared", label: "Extract voor PMC én Scav" },
  coop: { cls: "mk-extract-coop", label: "Co-op-extract: een PMC en een Scav samen" },
};

/**
 * Extracts as the player sees them: the PMC and Scav variant of one exit (same name, same spot)
 * become a single marker, and each gets a kind: pmc, scav, both, or co-op.
 */
function groupedExtracts() {
  const groups = [];
  for (const e of mapData.extracts) {
    if (!e.position) continue;
    const g = groups.find((x) => norm(x.name) === norm(e.name) && Math.hypot(x.position.x - e.position.x, x.position.z - e.position.z) < 25);
    if (g) {
      g.factions.add(e.faction);
      g.wiki ??= e.wiki;
    } else {
      groups.push({ name: e.name, position: e.position, factions: new Set([e.faction]), wiki: e.wiki });
    }
  }
  for (const g of groups) {
    const coop = /co-?op/i.test(g.name) || /scav \+ pmc/i.test(g.wiki?.requirementsHtml ?? "");
    g.kind = coop ? "coop" : g.factions.has("shared") || (g.factions.has("pmc") && g.factions.has("scav")) ? "both" : g.factions.has("pmc") ? "pmc" : "scav";
  }
  return groups;
}

function extractVisible(kind) {
  if (state.extractMode === "off") return false;
  if (state.extractMode === "pmc") return kind !== "scav";
  if (state.extractMode === "scav") return kind !== "pmc";
  return true;
}

function labelMarker(p, cls, text, popupHtml) {
  const icon = L.divIcon({ className: "", iconSize: [0, 0], html: `<div class="mk-label ${cls} ${dimFor(p)}">${text}</div>` });
  const m = L.marker(pos(p), { icon });
  if (popupHtml) m.bindPopup(popupHtml, { maxWidth: 340 });
  return m;
}

function drawExtracts() {
  if (!map) return;
  groups.extracts.clearLayers();
  if (state.focusQuest || state.focusBoss) return;
  for (const e of groupedExtracts()) {
    if (!extractVisible(e.kind)) continue;
    const kind = EXTRACT_KIND[e.kind];
    const popup = String(html`<div class="pop"><h4>${e.name}</h4><div class="small">${kind.label}${e.wiki?.singleUse ? " · eenmalig" : ""}${e.wiki?.alwaysAvailable === false ? " · niet altijd beschikbaar" : ""}</div>
      ${e.wiki?.requirementsHtml ? html`<p style="margin:6px 0 2px"><b>Vereist:</b> ${raw(e.wiki.requirementsHtml)}</p>` : ""}
      ${e.wiki?.notesHtml ? html`<div class="small" style="color:var(--text)">${raw(e.wiki.notesHtml)}</div>` : ""}</div>`);
    groups.extracts.addLayer(labelMarker(e.position, kind.cls, escapeLabel(e.name), popup));
  }
}

function drawTransits() {
  groups.transits.clearLayers();
  if (!state.show.transits || state.focusQuest || state.focusBoss) return;
  for (const t of mapData.transits) {
    if (!t.position) continue;
    const to = store.mapById.get(t.to)?.name ?? t.to ?? "?";
    groups.transits.addLayer(labelMarker(t.position, "mk-transit", `→ ${escapeLabel(to)}`, String(html`<div class="pop"><h4>Transit naar ${to}</h4><div class="small">${t.name}</div></div>`)));
  }
}

function drawHazards() {
  groups.hazards.clearLayers();
  if (!state.show.hazards) return;
  for (const h of mapData.hazards) {
    if (!h.outline) continue;
    const color = h.type === "minefield" ? "#e0605a" : "#e39a4c";
    groups.hazards.addLayer(
      L.polygon(h.outline.map(([x, z]) => [z, x]), { color, weight: 1, fillOpacity: 0.18, dashArray: "2 4" }).bindTooltip(`${h.name || h.type}`, { sticky: true })
    );
  }
}

function drawLocks() {
  groups.locks.clearLayers();
  if (!state.show.locks || state.focusQuest || state.focusBoss) return;
  for (const l of mapData.locks) {
    const key = store.items[l.key];
    const icon = L.divIcon({ className: "", iconSize: [18, 18], iconAnchor: [9, 9], html: `<div class="mk-lock ${dimFor(l.position)}">⚿</div>` });
    groups.locks.addLayer(
      L.marker(pos(l.position), { icon }).bindPopup(String(html`<div class="pop"><div class="row">${key?.icon ? html`<img src="${key.icon}" style="width:42px;height:42px" alt="" referrerpolicy="no-referrer">` : ""}<div><h4>${key?.name ?? "Onbekende sleutel"}</h4><div class="small">${l.type}${l.needsPower ? " · stroom nodig" : ""}</div></div></div>${key?.wiki ? html`<a href="${key.wiki}" target="_blank" rel="noopener">Wiki ↗</a>` : ""}</div>`))
    );
  }
}

function escapeLabel(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function onMapClick(e) {
  const done = e.target.closest("[data-done]");
  if (done) {
    const id = done.dataset.done;
    setDone(id, !isDone(id));
    map.closePopup();
    return;
  }
  const img = e.target.closest("img[data-full]");
  if (img) openLightbox(img.dataset.full, img.dataset.cap);
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function renderSide() {
  const m = mapData;
  const info = [m.raidDuration ? `${m.raidDuration} min` : null, m.players ? `${m.players} spelers` : null].filter(Boolean).join(" · ");
  root.querySelector("#m-info").innerHTML = String(html`${info}${m.wiki ? html` · <a href="${m.wiki}" target="_blank" rel="noopener">wiki ↗</a>` : ""}`);
  renderFloors();
  renderBossList();
  renderQuestList();
  renderFocus();
}

function renderFloors() {
  const layers = mapData.config.layers.filter((l) => (mapData.config.svg ? l.svgLayer : l.tilePath));
  const el = root.querySelector("#m-floors");
  if (!layers.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = String(html`<div class="section-title">Verdieping</div><div class="floors">
    <button class="chip ${state.floor ? "" : "on"}" data-floor="">Basis</button>
    ${layers.map((l) => html`<button class="chip ${state.floor === l.name ? "on" : ""}" data-floor="${l.name}">${l.name}</button>`)}
  </div>`);
  el.onclick = (e) => {
    const b = e.target.closest("[data-floor]");
    if (b) setFloor(b.dataset.floor || null);
  };
}

function renderBossList() {
  const rows = bossesHere().sort((a, b) => Number(b.boss.isBoss) - Number(a.boss.isBoss) || (b.spawn.spawnChance ?? 0) - (a.spawn.spawnChance ?? 0));
  const el = root.querySelector("#m-bosses");
  if (!rows.length) {
    el.innerHTML = `<div class="block muted" style="border:0;padding-top:0">Geen bosses bekend voor deze map.</div>`;
    return;
  }
  el.innerHTML = rows.map(({ boss, spawn }) => {
    const nPos = spawn.locations.reduce((s, l) => s + l.positions.length, 0);
    const hidden = state.hiddenBosses.includes(boss.id) || (boss.isBoss ? !state.show.bosses : !state.show.specials);
    return String(html`<div class="boss-li ${hidden ? "off" : ""}" data-boss="${boss.id}">
      <input type="checkbox" data-toggle-boss="${boss.id}" ${state.hiddenBosses.includes(boss.id) ? "" : "checked"} title="Tonen op kaart">
      <img src="${boss.portrait ?? ""}" alt="" referrerpolicy="no-referrer">
      <div style="min-width:0">
        <div style="font-weight:600">${boss.name}</div>
        <div class="muted" style="font-size:11.5px">${spawn.locations.map((l) => l.name).join(", ")}${nPos ? "" : " · geen coördinaten"}</div>
      </div>
      <span class="pct ${(spawn.spawnChance ?? 0) < 0.3 ? "low" : ""}">${pct(spawn.spawnChance)}</span>
    </div>`);
  }).join("");
}

function onBossListClick(e) {
  const toggle = e.target.closest("[data-toggle-boss]");
  if (toggle) {
    const id = toggle.dataset.toggleBoss;
    state.hiddenBosses = toggle.checked ? state.hiddenBosses.filter((x) => x !== id) : [...state.hiddenBosses, id];
    savePrefs();
    drawBosses();
    renderBossList();
    return;
  }
  const row = e.target.closest("[data-boss]");
  if (!row) return;
  const id = row.dataset.boss;
  if (state.focusBoss === id) {
    // second click: open the popup of the first spawn point
    const first = markerIndex.bosses.get(id)?.[0];
    first?.openPopup();
    return;
  }
  go(`#/map/${encodeURIComponent(state.mapId)}?boss=${encodeURIComponent(id)}`);
}

function renderQuestList() {
  const el = root.querySelector("#m-quests");
  const term = norm(root.querySelector("#m-qsearch")?.value ?? "");
  const rows = questsHere()
    .filter(({ quest }) => {
      const st = questState(quest);
      if (state.questScope === "open" && st === "done") return false;
      if (state.questScope === "available" && st !== "available") return false;
      return !term || norm(quest.title).includes(term);
    })
    .sort((a, b) => a.quest.trader.localeCompare(b.quest.trader) || a.quest.title.localeCompare(b.quest.title));
  el.innerHTML = rows.length
    ? rows.map(({ quest, objs }) => String(html`<div class="mq-li ${state.focusQuest && state.focusQuest !== quest.id ? "off" : ""}" data-quest="${quest.id}">
        <span class="dot" style="background:${traderColor(quest.trader)}"></span>
        <span class="t">${quest.title}</span>
        <span class="faint" style="font-size:11px">${objs.length}</span>
      </div>`)).join("")
    : `<div class="block muted" style="border:0">Geen quests met coördinaten.</div>`;
}

function renderFocus() {
  const el = root.querySelector("#m-focus");
  const q = state.focusQuest ? store.questById.get(state.focusQuest) : null;
  const b = state.focusBoss ? store.bossById.get(state.focusBoss) : null;
  if (!q && !b) {
    el.innerHTML = "";
    return;
  }
  const spawn = b?.spawns.find((s) => s.map === mapData.id);
  el.innerHTML = String(html`<div class="focus-banner">
    ${q ? html`<span class="dot" style="background:${traderColor(q.trader)}"></span><b>${q.title}</b><a class="btn small" href="#/quests/${encodeURIComponent(q.id)}">Quest</a>` : ""}
    ${b ? html`<b>${b.name}</b><a class="btn small" href="#/bosses/${encodeURIComponent(b.id)}">Details</a>` : ""}
    <button class="btn small" data-clear-focus>✕ Alles tonen</button>
  </div>
  ${b && spawn ? bossCard(b, spawn) : ""}`);
}

/** Info card for a focused boss: every zone (also those without coordinates) plus the wiki location images. */
function bossCard(boss, spawn) {
  return html`<div class="info-card pop">
    <div class="row">
      ${boss.portrait ? html`<img class="portrait" src="${boss.portrait}" alt="" referrerpolicy="no-referrer">` : ""}
      <div><h4>${boss.name}</h4><div class="small">${boss.faction ?? ""}</div></div>
      <span class="big-pct" style="margin-left:auto">${pct(spawn.spawnChance)}</span>
    </div>
    ${spawn.escortOf ? html`<div class="small">Spawnt als escort van ${spawn.escortOf}</div>` : ""}
    <div class="section-title" style="margin-top:8px">Spawnzones</div>
    <ul>${spawn.locations.map((l) => html`<li>${l.name}${spawn.locations.length > 1 && l.chance != null ? html` <span class="small">${pct(l.chance)}</span>` : ""}${l.positions.length ? html` <span class="small">· ${l.positions.length} punt${l.positions.length > 1 ? "en" : ""} op de kaart</span>` : html` <span class="small c-orange">· geen coördinaten, zie wiki-kaart</span>`}</li>`)}</ul>
    ${spawn.escorts.length ? html`<div class="small">Escort: ${spawn.escorts.map((e) => `${e.name} ×${escortRange(e)}`).join(", ")}</div>` : ""}
    ${spawn.wikiHtml || spawn.wikiLocationHtml ? html`<div class="richtext small" style="margin-top:6px;color:var(--text)">${raw(spawn.wikiHtml || spawn.wikiLocationHtml)}</div>` : ""}
    ${spawn.wikiImages?.filter((i) => i.thumb).map((i) => html`<img class="wikiimg" src="${i.thumb}" data-full="${i.url}" data-cap="${i.caption}" alt="" referrerpolicy="no-referrer"><div class="small">${i.caption}</div>`)}
  </div>`;
}

function fitFocus() {
  if (!map) return;
  const markers = state.focusQuest ? markerIndex.quests.get(state.focusQuest) : state.focusBoss ? markerIndex.bosses.get(state.focusBoss) : null;
  if (!markers?.length) return;
  const b = L.latLngBounds(markers.map((m) => m.getLatLng()));
  map.fitBounds(b.pad(0.4), { maxZoom: Math.max(mapData.config.minZoom + 1, mapData.config.maxZoom - 2) });
  if (markers.length === 1) setTimeout(() => markers[0].openPopup(), 250);
}
