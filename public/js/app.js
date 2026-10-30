import { esc, timeAgo, norm } from "./util.js";
import * as questsView from "./views/quests.js";
import * as itemsView from "./views/items.js";
import * as mapView from "./views/map.js";
import * as bossesView from "./views/bosses.js";
import * as statusView from "./views/status.js";
import * as ammoView from "./views/ammo.js";
import * as buildsView from "./views/builds.js";
import * as tradesView from "./views/trades.js";

// ---------------------------------------------------------------------------
// Data store
// ---------------------------------------------------------------------------

export const store = {
  quests: [],
  questById: new Map(),
  questByTitle: new Map(),
  traders: [],
  items: {},
  bosses: [],
  bossById: new Map(),
  bossByTitle: new Map(),
  maps: [],
  mapById: new Map(),
  ammo: null, // loaded on first visit of the ammo page
  builds: null, // loaded on first visit of the builds page
  trades: null, // loaded on first visit of the trade page
  status: null,
  progress: { done: {}, objectives: {}, owned: {}, level: null },
  mode: "regular", // regular | season (the PvP season, data/season/)
  season: null, // data/season/season.json, null when the build has no season
  modeMeta: null, // meta.json of the current mode
};

const MODE_KEY = "tarkov-helper-mode";
try {
  store.mode = localStorage.getItem(MODE_KEY) === "season" ? "season" : "regular";
} catch {
  /* storage unavailable */
}

/** Path of a dataset for the current game mode. Map images (data/maps/) are shared and not mode-specific. */
export function dataPath(file) {
  return store.mode === "season" ? `data/season/${file}` : `data/${file}`;
}

/**
 * Set by the static build (scripts/build.mjs): no server behind the site, data comes from data/*.json
 * and progress lives only in the browser. All URLs are relative so the site also works under a subpath.
 */
export const STATIC = document.querySelector('meta[name="th-mode"]')?.content === "static";

async function getJson(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function loadData() {
  const [q, items, bosses, maps, meta] = await Promise.all([
    getJson(dataPath("quests.json")),
    getJson(dataPath("items.json")),
    getJson(dataPath("bosses.json")),
    getJson(dataPath("maps.json")),
    getJson(dataPath("meta.json")).catch(() => null),
  ]);
  store.modeMeta = meta;
  store.quests = q.quests;
  store.traders = q.traders;
  store.items = items;
  store.bosses = bosses;
  store.maps = maps;
  store.questById = new Map(q.quests.map((x) => [x.id, x]));
  store.questByTitle = new Map(q.quests.map((x) => [norm(x.title), x]));
  store.bossById = new Map(bosses.map((b) => [b.id, b]));
  store.bossByTitle = new Map(bosses.flatMap((b) => [[norm(b.name), b], ...(b.wikiTitle ? [[norm(b.wikiTitle), b]] : [])]));
  store.mapById = new Map(maps.map((m) => [m.id, m]));
  for (const quest of store.quests) quest._search = norm([quest.title, quest.trader, quest.locationText, ...quest.objectives.map((o) => o.text), ...quest.items.flatMap((i) => i.itemIds.slice(0, 8).map((id) => items[id]?.name))].join(" "));
}

export async function refreshStatus() {
  try {
    store.status = STATIC ? { meta: await getJson("data/meta.json"), static: true, sync: null } : await getJson("api/status");
  } catch {
    store.status = null;
  }
  renderFreshness();
  return store.status;
}

// ---------------------------------------------------------------------------
// Progress, kept per game mode (a season wipe must not touch regular progress).
// Server: data/progress.json / progress-season.json, mirrored in localStorage; static site: localStorage only.
// ---------------------------------------------------------------------------

const progressKey = (mode) => (mode === "season" ? "tarkov-helper-progress-season" : "tarkov-helper-progress");
const progressApi = (mode) => (mode === "season" ? "api/progress?mode=season" : "api/progress");

async function loadProgress() {
  let server = null;
  if (!STATIC) {
    try {
      server = await getJson(progressApi(store.mode));
    } catch {
      /* offline */
    }
  }
  let local = null;
  try {
    local = JSON.parse(localStorage.getItem(progressKey(store.mode)) ?? "null");
  } catch {
    /* storage unavailable */
  }
  const chosen = server && Object.keys(server).length ? server : local ?? {};
  store.progress = { done: {}, objectives: {}, owned: {}, level: null, ...chosen };
}

// the pending save remembers its own mode, so switching modes mid-debounce cannot write into the wrong one
let pending = null;
let saveTimer = null;

async function flushProgress() {
  clearTimeout(saveTimer);
  if (!pending) return;
  const { mode, progress } = pending;
  pending = null;
  try {
    localStorage.setItem(progressKey(mode), JSON.stringify(progress));
  } catch {
    /* ignore */
  }
  if (STATIC) return;
  try {
    await fetch(progressApi(mode), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(progress) });
  } catch {
    /* server offline: localStorage still has it */
  }
}

export function saveProgress() {
  pending = { mode: store.mode, progress: store.progress };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushProgress, 400);
}

export function isDone(questId) {
  return !!store.progress.done[questId];
}

export function setDone(questId, done) {
  if (done) store.progress.done[questId] = Date.now();
  else delete store.progress.done[questId];
  saveProgress();
  window.dispatchEvent(new CustomEvent("progress"));
}

/** Mark a quest and (recursively) everything it requires as done. */
export function setDoneWithPrereqs(questId) {
  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    store.progress.done[id] ??= Date.now();
    for (const r of store.questById.get(id)?.requires ?? []) walk(r.id);
  };
  walk(questId);
  saveProgress();
  window.dispatchEvent(new CustomEvent("progress"));
  return seen.size;
}

export function questState(quest) {
  if (isDone(quest.id)) return "done";
  const reqOk = quest.requires.every((r) => isDone(r.id) || !store.questById.has(r.id));
  const level = store.progress.level;
  const levelOk = !level || !quest.minLevel || level >= quest.minLevel;
  return reqOk && levelOk ? "available" : "locked";
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const views = { quests: questsView, items: itemsView, map: mapView, bosses: bossesView, ammo: ammoView, builds: buildsView, trades: tradesView, status: statusView };
let current = null;

export function parseHash() {
  const [pathPart, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const [name = "quests", ...rest] = pathPart.split("/").filter(Boolean);
  return { name, param: rest.map(decodeURIComponent).join("/") || null, query: new URLSearchParams(query) };
}

export function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function route() {
  const r = parseHash();
  const view = views[r.name] ?? questsView;
  const name = views[r.name] ? r.name : "quests";
  for (const a of document.querySelectorAll("#tabs a")) a.classList.toggle("active", a.dataset.tab === name);
  const app = document.getElementById("app");
  if (current?.name !== name) {
    current?.view.unmount?.();
    // fresh host per mount: listeners a view attaches to its root disappear with it
    app.innerHTML = "";
    const host = document.createElement("div");
    host.className = "view";
    app.appendChild(host);
    current = { name, view };
    view.mount(host, r);
  } else {
    view.update?.(r);
  }
}

// ---------------------------------------------------------------------------
// Header + global link handling
// ---------------------------------------------------------------------------

function renderFreshness() {
  const el = document.getElementById("freshness");
  const s = store.status;
  if (!s) {
    el.textContent = STATIC ? "data niet bereikbaar" : "server offline";
    el.className = "freshness stale";
    return;
  }
  if (s.sync?.running) {
    el.textContent = "Bezig met synchroniseren…";
    el.className = "freshness syncing";
    return;
  }
  const at = s.meta?.fetchedAt;
  const stale = !at || Date.now() - Date.parse(at) > 24 * 3600e3;
  el.textContent = at ? `Data: ${timeAgo(at)}` : "Nog geen data";
  el.className = `freshness${stale ? " stale" : ""}`;
  el.title = at ? `Wiki + json.tarkov.dev opgehaald op ${new Date(at).toLocaleString("nl-NL")}` : "";
}

// In-app navigation for wiki links that point at quests, bosses or maps we know.
document.addEventListener("click", (e) => {
  const a = e.target.closest("a.wl[data-wiki]");
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const key = norm(a.dataset.wiki);
  const quest = store.questByTitle.get(key) ?? store.questByTitle.get(norm(`${a.dataset.wiki} (quest)`));
  if (quest) {
    e.preventDefault();
    go(`#/quests/${encodeURIComponent(quest.id)}`);
    return;
  }
  const boss = store.bossByTitle.get(key);
  if (boss) {
    e.preventDefault();
    go(`#/bosses/${encodeURIComponent(boss.id)}`);
  }
});

const levelInput = document.getElementById("player-level");
levelInput.addEventListener("change", () => {
  const v = Number(levelInput.value);
  store.progress.level = v > 0 ? Math.min(79, v) : null;
  saveProgress();
  window.dispatchEvent(new CustomEvent("progress"));
});

// ---------------------------------------------------------------------------
// Game mode switch (Regular / Season)
// ---------------------------------------------------------------------------

export function seasonDaysLeft() {
  if (!store.season) return null;
  return Math.max(0, Math.ceil((Date.parse(store.season.end) - Date.now()) / 864e5));
}

function renderModeUi() {
  const sw = document.getElementById("mode-switch");
  const pill = document.getElementById("season-pill");
  sw.hidden = !store.season;
  for (const b of sw.querySelectorAll("[data-gm]")) b.classList.toggle("on", b.dataset.gm === store.mode);
  document.body.dataset.mode = store.mode;
  if (store.mode === "season" && store.season) {
    const days = seasonDaysLeft();
    pill.hidden = false;
    pill.textContent = days > 0 ? `${store.season.name} · nog ${days} ${days === 1 ? "dag" : "dagen"}` : `${store.season.name} · afgelopen`;
    pill.title = `Seizoen ${new Date(store.season.start).toLocaleDateString("nl-NL")} – ${new Date(store.season.end).toLocaleDateString("nl-NL")}`;
  } else {
    pill.hidden = true;
  }
}

async function switchMode(mode) {
  if (mode === store.mode || (mode === "season" && !store.season)) return;
  await flushProgress();
  store.mode = mode;
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* ignore */
  }
  renderModeUi();
  document.getElementById("app").innerHTML = `<div class="loading">${mode === "season" ? "Seizoensdata" : "Reguliere data"} laden…</div>`;
  current?.view.unmount?.();
  current = null;
  store.ammo = null;
  store.builds = null;
  store.trades = null;
  await Promise.all([loadData(), loadProgress()]);
  levelInput.value = store.progress.level ?? "";
  route();
}

document.getElementById("mode-switch").addEventListener("click", (e) => {
  const b = e.target.closest("[data-gm]");
  if (b) switchMode(b.dataset.gm);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function waitForData() {
  const app = document.getElementById("app");
  for (;;) {
    const status = await refreshStatus();
    if (status?.meta) return;
    if (STATIC) throw new Error("data/meta.json ontbreekt in deze build");
    const last = status?.sync?.log?.slice(-1)[0] ?? "";
    app.innerHTML = `<div class="loading"><p>Eerste synchronisatie met de wiki en json.tarkov.dev loopt (± 2 minuten)…</p><p class="mono faint">${esc(last)}</p></div>`;
    await new Promise((r) => setTimeout(r, 2500));
  }
}

async function boot() {
  try {
    await waitForData();
    // season data is optional: without it (between seasons, or an older build) the switch stays hidden
    store.season = await getJson("data/season/season.json").catch(() => null);
    if (!store.season) store.mode = "regular";
    renderModeUi();
    await Promise.all([loadData(), loadProgress()]);
  } catch (err) {
    const hint = STATIC ? "De build bevat geen data. Draai de build opnieuw (npm run build)." : `Draait de server? Start met <span class="mono">npm start</span>.`;
    document.getElementById("app").innerHTML = `<div class="empty">Kon data niet laden: ${esc(err.message)}<br><br>${hint}</div>`;
    return;
  }
  levelInput.value = store.progress.level ?? "";
  window.addEventListener("hashchange", route);
  route();
  setInterval(refreshStatus, 60_000);
}

export async function reloadData() {
  await loadData();
  store.ammo = null;
  store.builds = null;
  store.trades = null;
  current?.view.unmount?.();
  current = null;
  route();
}

boot();
