import { esc, timeAgo, debounce, norm } from "./util.js";
import * as questsView from "./views/quests.js";
import * as itemsView from "./views/items.js";
import * as mapView from "./views/map.js";
import * as bossesView from "./views/bosses.js";
import * as statusView from "./views/status.js";
import * as ammoView from "./views/ammo.js";
import * as buildsView from "./views/builds.js";

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
  status: null,
  progress: { done: {}, objectives: {}, owned: {}, level: null },
};

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
  const [q, items, bosses, maps] = await Promise.all([
    getJson("data/quests.json"),
    getJson("data/items.json"),
    getJson("data/bosses.json"),
    getJson("data/maps.json"),
  ]);
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
// Progress (server: data/progress.json, mirrored in localStorage; static site: localStorage only)
// ---------------------------------------------------------------------------

const LS_KEY = "tarkov-helper-progress";

async function loadProgress() {
  let server = null;
  if (!STATIC) {
    try {
      server = await getJson("api/progress");
    } catch {
      /* offline */
    }
  }
  let local = null;
  try {
    local = JSON.parse(localStorage.getItem(LS_KEY) ?? "null");
  } catch {
    /* storage unavailable */
  }
  const chosen = server && Object.keys(server).length ? server : local ?? {};
  store.progress = { done: {}, objectives: {}, owned: {}, level: null, ...chosen };
}

const pushProgress = debounce(async () => {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(store.progress));
  } catch {
    /* ignore */
  }
  if (STATIC) return;
  try {
    await fetch("api/progress", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(store.progress) });
  } catch {
    /* server offline: localStorage still has it */
  }
}, 400);

export function saveProgress() {
  pushProgress();
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

const views = { quests: questsView, items: itemsView, map: mapView, bosses: bossesView, ammo: ammoView, builds: buildsView, status: statusView };
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
  current?.view.unmount?.();
  current = null;
  route();
}

boot();
