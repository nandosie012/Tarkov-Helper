/**
 * Sync: pull the live EFT wiki + json.tarkov.dev and write the helper's datasets to ./data.
 *
 *   node sync/index.mjs [--mode=regular|pve] [--force-maps]
 *
 * Wiki (escapefromtarkov.fandom.com) is leading for: which quests exist, objectives text,
 * "Related Quest Items" tables, requirements, rewards, guides/images, boss + map descriptions.
 * json.tarkov.dev (game-data dumps) adds: coordinates, item ids/icons/prices, spawn chances,
 * extracts, transits, hazards. Map rendering config comes from the tarkov.dev repo.
 */

import { mkdir, writeFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getText } from "./http.mjs";
import { getWikitext, getPages, getImageUrls, wikiUrl, looseKey, normTitle } from "./wiki.mjs";
import { unknownTemplates } from "./wikitext.mjs";
import { fetchTarkovDev, wikiTitleFromUrl } from "./tarkovdev.mjs";
import { parseQuestList, parseQuestPage, parseBossList, parseBossPage, parseMapPage } from "./parse-wiki.mjs";
import { computeBuilds } from "./builds.mjs";
import { computeTrades } from "./trades.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
const mapsDir = path.join(dataDir, "maps");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);
const MODE = args.mode === "pve" ? "pve" : "regular";
const started = Date.now();
const warnings = [];

function log(...parts) {
  console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s]`, ...parts);
}
function warn(message) {
  warnings.push(message);
}

const slug = (s) => looseKey(s).replace(/ /g, "-");
/** "Immunity (quest)" -> "Immunity": wiki disambiguation suffixes the API names don't have. */
const baseTitle = (s) => String(s ?? "").replace(/\s*\((quest|task)\)\s*$/i, "");
const round = (n) => (typeof n === "number" ? Math.round(n * 100) / 100 : n);
const point = (p) => (p ? { x: round(p.x), y: round(p.y), z: round(p.z) } : null);
const outline = (o) => (Array.isArray(o) && o.length > 2 ? o.map((p) => [round(p.x), round(p.z)]) : null);

async function writeJson(name, value) {
  const file = path.join(dataDir, name);
  await writeFile(`${file}.tmp`, JSON.stringify(value));
  await rename(`${file}.tmp`, file);
}

// ---------------------------------------------------------------------------
// 1. Fetch sources
// ---------------------------------------------------------------------------

log(`json.tarkov.dev (${MODE}) + wiki ophalen...`);
const [api, questListPage, bossListPage] = await Promise.all([
  fetchTarkovDev(MODE),
  getWikitext("Quests"),
  getWikitext("Bosses"),
]);
const tr = api.tr;
log(`API: ${Object.keys(api.tasks.tasks).length} tasks, ${Object.keys(api.items.items).length} items, ${Object.keys(api.maps.maps).length} maps`);

const wikiQuestList = [];
{
  const seen = new Set();
  for (const entry of parseQuestList(questListPage.wikitext)) {
    if (seen.has(entry.title)) continue;
    seen.add(entry.title);
    wikiQuestList.push(entry);
  }
}
log(`Wiki questlijst: ${wikiQuestList.length} quests`);

// API tasks indexed by wiki title and by name
const apiTasks = Object.values(api.tasks.tasks).map((t) => ({ ...t, _name: tr.tasks(t.name, t.normalizedName) }));
const taskByWiki = new Map();
const taskByName = new Map();
for (const t of apiTasks) {
  const wt = wikiTitleFromUrl(t.wikiLink);
  if (wt) {
    const key = looseKey(wt);
    const prev = taskByWiki.get(key);
    // prefer the task whose own name equals the wiki title (e.g. not the "[PVP ZONE]" variant)
    if (!prev || (looseKey(t._name) === key && looseKey(prev._name) !== key)) taskByWiki.set(key, t);
  }
  if (!taskByName.has(looseKey(t._name))) taskByName.set(looseKey(t._name), t);
}

// API tasks that are not on the wiki list but have a wiki page: fetch those pages too
const listKeys = new Set(wikiQuestList.flatMap((q) => [looseKey(q.title), looseKey(baseTitle(q.title))]));
const extraTitles = [];
for (const t of apiTasks) {
  const wt = wikiTitleFromUrl(t.wikiLink);
  if (wt && !listKeys.has(looseKey(wt)) && !listKeys.has(looseKey(t._name))) extraTitles.push(wt);
}

const bossList = parseBossList(bossListPage.wikitext);
const apiMaps = Object.values(api.maps.maps);
const mapPageTitles = [...new Set(apiMaps.map((m) => wikiTitleFromUrl(m.wiki)).filter(Boolean))];

log(`Wiki pagina's ophalen: ${wikiQuestList.length + extraTitles.length} quests, ${bossList.length} bosses, ${mapPageTitles.length} maps...`);
const pages = await getPages(
  [...wikiQuestList.map((q) => q.title), ...extraTitles, ...bossList.map((b) => b.title), ...mapPageTitles],
  { onProgress: (done, total) => (done % 200 === 0 || done === total) && log(`  wiki ${done}/${total}`) }
);

// ---------------------------------------------------------------------------
// 2. Indexes: traders, maps, items
// ---------------------------------------------------------------------------

const traders = Object.values(api.traders).map((t) => ({
  id: t.id,
  name: tr.traders(t.name, t.normalizedName),
  normalizedName: t.normalizedName,
  image: t.imageLink ?? t.image4xLink ?? null,
}));
const traderById = new Map(traders.map((t) => [t.id, t]));
const traderByName = new Map(traders.map((t) => [looseKey(t.name), t]));

const mapById = new Map(apiMaps.map((m) => [m.id, m]));
const mapByName = new Map();
for (const m of apiMaps) {
  mapByName.set(looseKey(tr.maps(m.name, m.normalizedName)), m);
  mapByName.set(looseKey(m.normalizedName), m);
  const wt = wikiTitleFromUrl(m.wiki);
  if (wt && !mapByName.has(looseKey(wt))) mapByName.set(looseKey(wt), m);
}
const mapName = (m) => tr.maps(m.name, m.normalizedName);
const mapRef = (id) => {
  const m = mapById.get(id);
  return m ? m.normalizedName : null;
};

// Items
const items = new Map(); // id -> record (only items that end up referenced)
const apiItems = api.items.items;
const itemByWiki = new Map();
const itemByName = new Map();
for (const it of Object.values(apiItems)) {
  const wt = wikiTitleFromUrl(it.wikiLink);
  if (wt && !itemByWiki.has(looseKey(wt))) itemByWiki.set(looseKey(wt), it.id);
  const name = tr.items(it.name, "");
  if (name && !itemByName.has(looseKey(name))) itemByName.set(looseKey(name), it.id);
}
const questItems = api.tasks.questItems ?? {};
for (const qi of Object.values(questItems)) {
  const name = tr.tasks(qi.name, "") || tr.items(qi.name, "");
  if (name && !itemByName.has(looseKey(name))) itemByName.set(looseKey(name), qi.id);
}

function useItem(id) {
  if (!id) return null;
  if (items.has(id)) return id;
  const it = apiItems[id];
  if (it) {
    const sells = (it.sellToTrader ?? []).filter((s) => s.priceRUB);
    const best = sells.sort((a, b) => b.priceRUB - a.priceRUB)[0];
    items.set(id, {
      id,
      name: tr.items(it.name, it.normalizedName),
      shortName: tr.items(it.shortName, ""),
      icon: it.iconLink ?? null,
      image: it.gridImageLink ?? null,
      wiki: it.wikiLink ?? null,
      link: it.link ?? null,
      avg24h: it.avg24hPrice ?? null,
      low24h: it.low24hPrice ?? null,
      lastLow: it.lastLowPrice ?? null,
      fleaBanned: Array.isArray(it.types) && it.types.includes("noFlea"),
      bestSell: best ? { trader: traderById.get(best.trader)?.name ?? best.trader, price: best.priceRUB } : null,
      types: it.types ?? [],
      questItem: false,
    });
    return id;
  }
  const qi = questItems[id];
  if (qi) {
    items.set(id, {
      id,
      name: tr.tasks(qi.name, "") || tr.items(qi.name, qi.normalizedName),
      shortName: tr.tasks(qi.shortName, "") || tr.items(qi.shortName, ""),
      icon: qi.iconLink ?? null,
      image: qi.gridImageLink ?? null,
      wiki: wikiUrl(tr.tasks(qi.name, "") || qi.normalizedName),
      questItem: true,
    });
    return id;
  }
  return null;
}

/** Resolve a wiki item title to an API item id, or create a wiki-only item record. */
function resolveWikiItem(title, iconFile) {
  const id = itemByWiki.get(looseKey(title)) ?? itemByName.get(looseKey(title));
  if (id && useItem(id)) {
    const rec = items.get(id);
    rec.wikiTitle ??= title;
    if (!rec.icon && iconFile) rec.iconFile = iconFile;
    return id;
  }
  const key = `wiki:${title}`;
  if (!items.has(key)) {
    items.set(key, { id: key, name: title, shortName: "", icon: null, iconFile: iconFile ?? null, wiki: wikiUrl(title), wikiTitle: title, questItem: false, wikiOnly: true });
  } else if (iconFile && !items.get(key).iconFile) {
    items.get(key).iconFile = iconFile;
  }
  return key;
}

// ---------------------------------------------------------------------------
// 3. Quests
// ---------------------------------------------------------------------------

function extractPin(map, exitName) {
  if (!map || !exitName) return null;
  const ex = (map.extracts ?? []).find((e) => e.name === exitName || e.id === exitName);
  return ex?.position ? { map: map.normalizedName, ...point(ex.position), outline: outline(ex.outline), kind: "extract" } : null;
}

function apiObjective(o) {
  const pins = [];
  for (const z of o.zones ?? []) {
    const m = mapRef(z.map);
    if (m && z.position) pins.push({ map: m, ...point(z.position), outline: outline(z.outline), kind: "zone" });
  }
  for (const loc of o.possibleLocations ?? []) {
    const m = mapRef(loc.map);
    if (!m) continue;
    for (const p of loc.positions ?? []) pins.push({ map: m, ...point(p), kind: "possible" });
  }
  if (o.type === "extract") {
    for (const mid of o.maps ?? []) {
      const pin = extractPin(mapById.get(mid), o.exitName);
      if (pin) pins.push(pin);
    }
  }
  const itemIds = [...(o.items ?? []), ...(o.useAny ?? []), ...(o.item ? [o.item] : [])].map(useItem).filter(Boolean);
  return {
    id: o.id,
    type: o.type,
    text: tr.tasks(o.description, ""),
    optional: !!o.optional,
    count: o.count ?? null,
    fir: o.foundInRaid ?? null,
    items: itemIds,
    questItem: useItem(o.questItem),
    markerItem: useItem(o.markerItem),
    maps: [...new Set((o.maps ?? []).map(mapRef).filter(Boolean))],
    pins,
  };
}

function classifyWikiRequirement(text) {
  const t = text.toLowerCase();
  if (/hand ?over|handed over|turn ?in|hand in/.test(t)) return "handover";
  if (/plant|place|stash|hide/.test(t)) return "plant";
  if (/mark/.test(t)) return "mark";
  if (/key/.test(t)) return "key";
  if (/required|equip|wear|worn|use|bring|carry|install/.test(t)) return "required";
  if (/find|obtain|pick|locate/.test(t)) return "find";
  return "other";
}

/** Rows without a usable "Requirement" column: infer the kind from the objectives. */
function inferKind(row, itemIds, parsed, apiObjs) {
  if (apiObjs.some((o) => o.type === "giveItem" && o.items.some((id) => itemIds.includes(id)))) return "handover";
  if (apiObjs.some((o) => o.type === "plantItem" && o.items.some((id) => itemIds.includes(id)))) return "plant";
  const titles = new Set(row.items.map((i) => looseKey(i.title)));
  for (const o of parsed?.objectives ?? []) {
    if (!o.links.some((l) => titles.has(looseKey(l)))) continue;
    if (/hand over|turn in|hand in/i.test(o.text)) return "handover";
    if (/stash|plant|place/i.test(o.text)) return "plant";
    if (/mark/i.test(o.text)) return "mark";
  }
  return "required";
}

function apiItemEntries(task, apiObjs) {
  const out = [];
  const give = apiObjs.filter((o) => o.type === "giveItem");
  const giveQ = apiObjs.filter((o) => o.type === "giveQuestItem");
  const sameItems = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  for (const o of apiObjs) {
    const base = { source: "api", text: o.text, optional: o.optional, objectiveId: o.id };
    switch (o.type) {
      case "giveItem":
        out.push({ ...base, kind: "handover", itemIds: o.items, count: o.count, fir: o.fir });
        break;
      case "findItem":
        if (!give.some((g) => sameItems(g.items, o.items))) out.push({ ...base, kind: "find", itemIds: o.items, count: o.count, fir: o.fir });
        break;
      case "giveQuestItem":
        if (o.questItem) out.push({ ...base, kind: "questitem", itemIds: [o.questItem], count: o.count ?? 1, fir: true });
        break;
      case "findQuestItem":
        if (o.questItem && !giveQ.some((g) => g.questItem === o.questItem)) out.push({ ...base, kind: "questitem", itemIds: [o.questItem], count: o.count ?? 1, fir: true });
        break;
      case "plantItem":
        out.push({ ...base, kind: "plant", itemIds: o.items, count: o.count, fir: o.fir });
        break;
      case "plantQuestItem":
        if (o.questItem) out.push({ ...base, kind: "plant", itemIds: [o.questItem], count: o.count ?? 1, fir: null });
        break;
      case "mark":
        if (o.markerItem) out.push({ ...base, kind: "mark", itemIds: [o.markerItem], count: 1, fir: false });
        break;
      case "useItem":
        if (o.items.length) out.push({ ...base, kind: "use", itemIds: o.items, count: o.count, fir: null });
        break;
      case "buildWeapon":
        if (o.items.length) out.push({ ...base, kind: "build", itemIds: o.items, count: 1, fir: null });
        break;
      case "sellItem":
        out.push({ ...base, kind: "sell", itemIds: o.items, count: o.count, fir: null });
        break;
    }
  }
  for (const nk of task?.neededKeys ?? []) {
    const ids = (nk.keys ?? []).map(useItem).filter(Boolean);
    if (ids.length) out.push({ source: "api", kind: "key", itemIds: ids, count: 1, fir: false, map: mapRef(nk.map), text: "" });
  }
  return out.filter((e) => e.itemIds.length);
}

const quests = [];
const questBySlug = new Map();
const usedTasks = new Set();
const questByTdevId = new Map();

function buildQuest({ title, trader: wikiTrader, inList }) {
  let page = pages.get(normTitle(title));
  // a wiki link can point at a non-quest page (skill, disambiguation): ignore those
  if (page && !inList && !/\{\{\s*Infobox[ _]quest/i.test(page.wikitext)) page = null;
  const parsed = page ? parseQuestPage(page.title, page.wikitext) : null;
  const pageTitle = page?.title ?? title;
  let task =
    taskByWiki.get(looseKey(pageTitle)) ??
    taskByWiki.get(looseKey(title)) ??
    taskByName.get(looseKey(pageTitle)) ??
    taskByName.get(looseKey(baseTitle(pageTitle)));
  if (task && usedTasks.has(task.id)) task = null;
  if (task) usedTasks.add(task.id);
  if (!page) warn(`Wiki-pagina ontbreekt: ${title}`);

  const apiObjs = (task?.objectives ?? []).map(apiObjective);
  const traderRec =
    (task && traderById.get(task.trader)) ??
    traderByName.get(looseKey(wikiTrader ?? parsed?.infobox.givenBy ?? "")) ??
    null;

  // maps: wiki infobox + API
  const mapSet = new Set();
  for (const loc of parsed?.infobox.locations ?? []) {
    const m = mapByName.get(looseKey(loc));
    if (m) mapSet.add(m.normalizedName);
  }
  if (task?.map) mapSet.add(mapRef(task.map));
  for (const o of apiObjs) for (const m of o.maps) mapSet.add(m);
  mapSet.delete(null);

  // items: wiki table rows first, then API entries not covered by the wiki
  const questItemsList = [];
  for (const table of parsed?.itemTables ?? []) {
    for (const row of table.rows) {
      const itemIds = row.items.map((it, i) => resolveWikiItem(it.title, row.icons[i] ?? row.icons[0]));
      if (!itemIds.length) continue;
      let kind = classifyWikiRequirement(row.requirement);
      if (kind === "other") kind = inferKind(row, itemIds, parsed, apiObjs);
      questItemsList.push({
        source: "wiki",
        kind,
        requirement: row.requirement,
        itemIds,
        nameHtml: row.nameHtml,
        count: row.amount,
        countText: row.amountText,
        fir: row.fir,
        notesHtml: row.notesHtml,
      });
    }
  }
  const covered = new Set(questItemsList.flatMap((e) => e.itemIds));
  for (const entry of apiItemEntries(task, apiObjs)) {
    if (entry.itemIds.some((id) => covered.has(id))) {
      // enrich matching wiki row with API count/FIR where the wiki is vague
      const row = questItemsList.find((r) => r.source === "wiki" && r.itemIds.some((id) => entry.itemIds.includes(id)));
      if (row) {
        row.apiCount ??= entry.count;
        if (row.fir === null) row.fir = entry.fir;
      }
      continue;
    }
    questItemsList.push(entry);
  }

  const id = slug(pageTitle);
  if (questBySlug.has(id)) return;
  const quest = {
    id,
    title: pageTitle,
    wiki: page ? wikiUrl(page.title) : task?.wikiLink ?? null,
    source: page && task ? "wiki+api" : page ? "wiki" : "api",
    inWikiList: !!inList,
    event: parsed?.event ?? false,
    trader: traderRec?.name ?? wikiTrader ?? parsed?.infobox.givenBy ?? "Onbekend",
    traderId: traderRec?.id ?? null,
    tdevId: task?.id ?? null,
    image: task?.taskImageLink ?? null,
    maps: [...mapSet],
    locationText: parsed?.infobox.locationText ?? "",
    minLevel: task?.minPlayerLevel ?? null,
    ll: parsed?.infobox.llRequirement ?? null,
    traderRequirements: (task?.traderRequirements ?? []).map((r) => ({
      trader: traderById.get(r.trader)?.name ?? r.trader,
      type: r.requirementType,
      value: r.value,
    })),
    kappa: task ? !!task.kappaRequired : parsed?.infobox.kappa ?? null,
    lightkeeper: task ? !!task.lightkeeperRequired : null,
    faction: task?.factionName ?? null,
    experience: task?.experience ?? null,
    previousTitles: parsed?.infobox.previous ?? [],
    leadsToTitles: parsed?.infobox.leadsTo ?? [],
    requiresTdev: (task?.taskRequirements ?? []).map((r) => ({ tdevId: r.task, status: r.status })),
    requirementsHtml: parsed?.requirementsHtml ?? "",
    objectives: parsed?.objectives.map(({ links, ...o }) => o) ?? [],
    apiObjectives: apiObjs,
    items: questItemsList,
    rewardsHtml: parsed?.rewardsHtml ?? "",
    guideHtml: parsed?.guideHtml ?? "",
    guideImages: parsed?.guideImages ?? [],
    wikiRevision: page ? { revid: page.revid, timestamp: page.timestamp } : null,
  };
  if (!quest.objectives.length && apiObjs.length) {
    quest.objectives = apiObjs.map((o) => ({ depth: 1, html: escapeText(o.text), text: o.text, fir: !!o.fir, optional: o.optional }));
  }
  quests.push(quest);
  questBySlug.set(id, quest);
  if (task) questByTdevId.set(task.id, quest);
}

function escapeText(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

for (const entry of wikiQuestList) buildQuest({ ...entry, inList: true });
for (const t of apiTasks) {
  if (usedTasks.has(t.id)) continue;
  const wt = wikiTitleFromUrl(t.wikiLink);
  const page = wt ? pages.get(normTitle(wt)) : null;
  // [PVP ZONE] variants share the wiki page of the normal quest: keep their own name
  const title = page && looseKey(page.title) === looseKey(t._name) ? page.title : t._name;
  if (!page || looseKey(page.title) !== looseKey(t._name)) {
    taskByWiki.set(looseKey(title), t);
  }
  buildQuest({ title, trader: traderById.get(t.trader)?.name, inList: false });
}

// resolve prerequisite links to quest ids
const questByTitle = new Map(quests.map((q) => [looseKey(q.title), q]));
for (const q of quests) {
  const req = new Map();
  for (const r of q.requiresTdev) {
    const other = questByTdevId.get(r.tdevId);
    if (other) req.set(other.id, { id: other.id, status: r.status });
  }
  for (const t of q.previousTitles) {
    const other = questByTitle.get(looseKey(t));
    if (other && !req.has(other.id)) req.set(other.id, { id: other.id, status: ["complete"], fromWiki: true });
  }
  q.requires = [...req.values()];
  q.leadsTo = q.leadsToTitles.map((t) => questByTitle.get(looseKey(t))?.id).filter(Boolean);
  delete q.requiresTdev;
  delete q.previousTitles;
  delete q.leadsToTitles;
}
for (const q of quests) {
  for (const r of q.requires) {
    const other = questBySlug.get(r.id);
    if (other && !other.leadsTo.includes(q.id)) other.leadsTo.push(q.id);
  }
}
log(`Quests: ${quests.length} (${quests.filter((q) => q.source === "wiki+api").length} wiki+api, ${quests.filter((q) => q.source === "wiki").length} alleen wiki, ${quests.filter((q) => q.source === "api").length} alleen API)`);

// ---------------------------------------------------------------------------
// 3b. Ammo (ballistics straight from the game data)
// ---------------------------------------------------------------------------

// weapon class per caliber code; display names are derived from the ammo names themselves
const CALIBER_GROUP = {
  Caliber9x18PM: "Pistool", Caliber9x19PARA: "Pistool", Caliber9x21: "Pistool", Caliber762x25TT: "Pistool",
  Caliber1143x23ACP: "Pistool", Caliber9x33R: "Pistool", Caliber127x33: "Pistool",
  Caliber57x28: "PDW", Caliber46x30: "PDW",
  Caliber545x39: "Geweer", Caliber556x45NATO: "Geweer", Caliber762x35: "Geweer", Caliber762x39: "Geweer",
  Caliber366TKM: "Geweer", Caliber9x39: "Geweer", Caliber58x42: "Geweer", Caliber68x51: "Geweer",
  Caliber762x51: "Marksman", Caliber762x54R: "Marksman", Caliber784x49: "Marksman", Caliber86x70: "Marksman",
  Caliber93x64: "Marksman", Caliber127x55: "Marksman", Caliber127x99: "Marksman",
  Caliber12g: "Shotgun", Caliber20g: "Shotgun", Caliber23x75: "Shotgun",
};
// launcher grenades, flares and toy rounds are not player-vs-player ammo
const CALIBER_SKIP = new Set(["Caliber40x46", "Caliber40mmRU", "Caliber26x75", "Caliber20x1mm", "Caliber30x29"]);

/**
 * Caliber label from the ammo names: the longest word prefix (max 3 words) shared by most rounds,
 * so one odd name (".300 Whisper" among ".300 Blackout ...") doesn't cut it short.
 */
function caliberName(names) {
  if (names.length === 1) return names[0].split(" ")[0];
  for (let k = 3; k >= 1; k--) {
    const counts = new Map();
    for (const n of names) {
      const words = n.split(" ");
      if (words.length >= k) counts.set(words.slice(0, k).join(" "), (counts.get(words.slice(0, k).join(" ")) ?? 0) + 1);
    }
    const [best, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (best && count >= Math.max(2, Math.ceil(names.length * 0.6))) return best;
  }
  return null;
}

const ammo = [];
for (const it of Object.values(apiItems)) {
  const p = it.properties;
  if (!it.types?.includes("ammo") || p?.propertiesType !== "ItemPropertiesAmmo") continue;
  if (!p.caliber || CALIBER_SKIP.has(p.caliber) || !["bullet", "buckshot"].includes(p.ammoType) || !p.damage) continue;
  const name = tr.items(it.name, it.normalizedName);
  ammo.push({
    id: it.id,
    name,
    shortName: tr.items(it.shortName, name),
    caliber: p.caliber,
    icon: it.iconLink ?? null,
    wiki: it.wikiLink ?? null,
    damage: p.damage,
    projectiles: p.projectileCount ?? 1,
    pen: p.penetrationPower,
    armorDamage: p.armorDamage,
    frag: p.fragmentationChance,
    ricochet: p.ricochetChance,
    speed: p.initialSpeed,
    accuracy: p.accuracyModifier,
    recoil: p.recoilModifier,
    lightBleed: p.lightBleedModifier,
    heavyBleed: p.heavyBleedModifier,
    tracer: !!p.tracer,
    subsonic: p.initialSpeed != null && p.initialSpeed < 343,
    fleaBanned: !!it.types?.includes("noFlea"),
    avg24h: it.avg24hPrice ?? null,
    lastLow: it.lastLowPrice ?? null,
    traders: (it.buyFromTrader ?? []).map((b) => ({
      trader: traderById.get(b.trader)?.name ?? b.trader,
      level: b.minTraderLevel ?? null,
      price: b.price,
      currency: b.currency,
      priceRUB: b.priceRUB,
      quest: b.taskUnlock ? questByTdevId.get(b.taskUnlock)?.title ?? "quest" : null,
      questId: b.taskUnlock ? questByTdevId.get(b.taskUnlock)?.id ?? null : null,
    })),
  });
}
const calibers = [...new Set(ammo.map((a) => a.caliber))].map((code) => {
  const rounds = ammo.filter((a) => a.caliber === code);
  return {
    id: code,
    name: caliberName(rounds.map((a) => a.name)) || code.replace(/^Caliber/, ""),
    group: CALIBER_GROUP[code] ?? "Overig",
    count: rounds.length,
  };
});
log(`Ammo: ${ammo.length} soorten in ${calibers.length} kalibers`);

const buildsStarted = Date.now();
const builds = computeBuilds({ items: apiItems, tr, traderById, categories: api.items.itemCategories });
log(`Builds: ${builds.weapons.length} wapens, meta + ${builds.caps.length} budgetniveaus (${((Date.now() - buildsStarted) / 1000).toFixed(1)}s)`);

const trades = computeTrades({ items: apiItems, tr, traderById });
log(`Handel: ${trades.length} items met flea- en handelaarsprijs, ${trades.filter((t) => t.profit > 0).length} met winst`);
// ---------------------------------------------------------------------------
// 4. Bosses
// ---------------------------------------------------------------------------

const mobs = api.maps.mobs ?? {};
const mapPages = new Map();
for (const t of mapPageTitles) {
  const p = pages.get(normTitle(t));
  if (p) mapPages.set(looseKey(t), parseMapPage(p.title, p.wikitext));
}
const wikiBossByKey = new Map(bossList.map((b) => [looseKey(b.title), b]));
const bosses = new Map(); // slug -> record

function bossRecord(name, mob) {
  const key = looseKey(name);
  const id = slug(name);
  if (bosses.has(id)) return bosses.get(id);
  const wiki = wikiBossByKey.get(key) ?? (mob ? wikiBossByKey.get(looseKey(mob.normalizedName?.replace(/-/g, " "))) : null);
  const page = wiki ? pages.get(normTitle(wiki.title)) : null;
  const parsed = page ? parseBossPage(page.title, page.wikitext) : null;
  const rec = {
    id,
    name: wiki?.name ?? name,
    wikiTitle: wiki?.title ?? null,
    wiki: wiki ? wikiUrl(wiki.title) : null,
    isBoss: !!wiki,
    event: wiki?.event || null,
    faction: wiki?.faction || parsed?.faction || null,
    portrait: mob?.imagePortraitLink ?? null,
    portraitFile: wiki?.portrait ?? parsed?.image ?? null,
    // the wiki lists followers once per map; keep each distinct line once
    followersHtml: [...new Set((wiki?.followersHtml ?? "").split("<br>").map((s) => s.trim()).filter(Boolean))].join("<br>"),
    equipment: (wiki?.equipment ?? []).map((t) => resolveWikiItem(t)),
    health: parsed?.health ?? (mob?.health ? Object.fromEntries(mob.health.map((h) => [h.id.toLowerCase(), h.max])) : null),
    locationIntroHtml: parsed?.locationIntroHtml ?? "",
    questsHtml: parsed?.questsHtml ?? "",
    behaviorHtml: parsed?.behaviorHtml ?? "",
    wikiMaps: parsed?.perMap ?? [],
    mobIds: [],
    spawns: [],
  };
  bosses.set(id, rec);
  return rec;
}

for (const m of apiMaps) {
  for (const b of m.bosses ?? []) {
    const mob = mobs[b.mob];
    const name = tr.maps(b.mob, mob?.normalizedName ?? b.mob);
    const rec = bossRecord(name, mob);
    if (!rec.mobIds.includes(b.mob)) rec.mobIds.push(b.mob);
    rec.portrait ??= mob?.imagePortraitLink ?? null;
    const entry = {
      map: m.normalizedName,
      mapName: mapName(m),
      spawnChance: b.spawnChance ?? null,
      locations: (b.spawnLocations ?? []).map((loc) => ({
        name: tr.maps(loc.spawnKey, loc.name),
        chance: loc.chance ?? null,
        positions: (loc.positions ?? []).map(point),
      })),
      escorts: (b.escorts ?? []).map((e) => ({
        name: tr.maps(e.mob, mobs[e.mob]?.normalizedName ?? e.mob),
        amounts: (e.amount ?? []).map((a) => ({ count: a.count, chance: a.chance })),
      })),
      spawnTime: b.spawnTime ?? null,
      spawnTrigger: b.spawnTrigger ? tr.maps(b.spawnTrigger, b.spawnTrigger) : null,
      ...wikiForMap(rec, m),
    };
    const existing = rec.spawns.find((s) => s.map === m.normalizedName);
    if (existing) mergeSpawn(existing, entry);
    else rec.spawns.push({ ...entry, waves: [wave(entry)] });
  }
}

function wikiForMap(rec, m) {
  const mapPage = mapPages.get(looseKey(wikiTitleFromUrl(m.wiki)));
  const row = mapPage?.bosses.find((x) => looseKey(x.title) === looseKey(rec.wikiTitle ?? rec.name));
  const perMap = rec.wikiMaps.find((x) => looseKey(x.map) === looseKey(wikiTitleFromUrl(m.wiki)) || mapByName.get(looseKey(x.map))?.id === m.id);
  return { wikiLocationHtml: row?.locationHtml ?? "", wikiHtml: perMap?.html ?? "", wikiImages: perMap?.images ?? [] };
}

function wave(s) {
  return { chance: s.spawnChance, spawnTime: s.spawnTime, trigger: s.spawnTrigger, zones: s.locations.map((l) => l.name) };
}

/** The game data can list several spawn groups (waves) for one mob on one map: fold them together. */
function mergeSpawn(into, add) {
  into.waves.push(wave(add));
  into.spawnChance = Math.round((1 - into.waves.reduce((p, w) => p * (1 - (w.chance ?? 0)), 1)) * 1000) / 1000;
  for (const loc of add.locations) {
    const same = into.locations.find((l) => l.name === loc.name);
    if (!same) {
      into.locations.push(loc);
      continue;
    }
    same.chance = Math.max(same.chance ?? 0, loc.chance ?? 0);
    for (const p of loc.positions) {
      if (!same.positions.some((q) => q.x === p.x && q.z === p.z)) same.positions.push(p);
    }
  }
  for (const e of add.escorts) if (!into.escorts.some((x) => x.name === e.name)) into.escorts.push(e);
  into.spawnTrigger ??= add.spawnTrigger;
}

// wiki bosses without own API spawns: event bosses, or followers that only spawn as escort (Big Pipe, Birdeye)
for (const b of bossList) {
  const rec = bossRecord(b.title, null);
  if (rec.spawns.length) continue;
  for (const leader of [...bosses.values()]) {
    if (leader === rec) continue;
    for (const s of leader.spawns) {
      if (s.escortOf || !s.escorts.some((e) => looseKey(e.name) === looseKey(rec.name))) continue;
      const m = apiMaps.find((x) => x.normalizedName === s.map);
      rec.spawns.push({ ...s, escortOf: leader.name, escorts: s.escorts.filter((e) => looseKey(e.name) !== looseKey(rec.name)), ...wikiForMap(rec, m) });
    }
  }
}

const bossesOut = [...bosses.values()].map(({ wikiMaps, ...b }) => ({
  ...b,
  wikiOnlyMaps: wikiMaps.filter((w) => !b.spawns.some((s) => looseKey(s.mapName) === looseKey(w.map))),
}));
bossesOut.sort((a, b) => Number(b.isBoss) - Number(a.isBoss) || a.name.localeCompare(b.name));
log(`Bosses/specials: ${bossesOut.length} (${bossesOut.filter((b) => b.isBoss).length} wiki-bosses)`);

// ---------------------------------------------------------------------------
// 5. Maps (+ SVG download)
// ---------------------------------------------------------------------------

const configs = [];
for (const group of api.mapConfig) {
  const interactive = (group.maps ?? []).find((m) => m.projection === "interactive");
  if (interactive) configs.push({ key: group.normalizedName, ...interactive });
}
function configFor(normalizedName) {
  const exact = configs.find((c) => c.key === normalizedName);
  if (exact) return exact;
  return configs
    .filter((c) => normalizedName.startsWith(c.key) || normalizedName.endsWith(c.key))
    .sort((a, b) => b.key.length - a.key.length)[0];
}

await mkdir(mapsDir, { recursive: true });
async function ensureSvg(config) {
  if (!config.svgPath) return null;
  const file = `${config.key}.svg`;
  const full = path.join(mapsDir, file);
  const fresh = await stat(full).then((s) => Date.now() - s.mtimeMs < 7 * 864e5).catch(() => false);
  if (!fresh || args["force-maps"]) {
    try {
      const svg = await getText(config.svgPath);
      await writeFile(full, svg);
    } catch (err) {
      warn(`SVG niet gedownload voor ${config.key}: ${err.message}`);
      const exists = await stat(full).then(() => true).catch(() => false);
      if (!exists) return null;
    }
  }
  return `maps/${file}`;
}

const mapsOut = [];
for (const m of apiMaps) {
  const config = configFor(m.normalizedName);
  const svg = config ? await ensureSvg(config) : null;
  const wikiTitle = wikiTitleFromUrl(m.wiki);
  const page = mapPages.get(looseKey(wikiTitle));
  const wikiExtracts = page?.extracts ?? [];
  mapsOut.push({
    id: m.normalizedName,
    tdevId: m.id,
    name: mapName(m),
    wiki: m.wiki ?? null,
    family: config?.key ?? null,
    variant: !!config && config.key !== m.normalizedName,
    raidDuration: m.raidDuration ?? null,
    players: m.players ?? page?.players ?? null,
    minPlayerLevel: m.minPlayerLevel ?? null,
    descriptionHtml: page?.descriptionHtml ?? "",
    config: config
      ? {
          transform: config.transform ?? null,
          coordinateRotation: config.coordinateRotation ?? 0,
          bounds: config.bounds ?? null,
          svgBounds: config.svgBounds ?? null,
          svg,
          svgLayer: config.svgLayer ?? null,
          tilePath: config.tilePath ?? null,
          tileSize: config.tileSize ?? 256,
          minZoom: config.minZoom ?? 1,
          maxZoom: config.maxZoom ?? 6,
          heightRange: config.heightRange ?? null,
          author: config.author ?? null,
          authorLink: config.authorLink ?? null,
          layers: (config.layers ?? []).map((l) => ({
            name: l.name,
            svgLayer: l.svgLayer ?? null,
            tilePath: l.tilePath ?? null,
            extents: l.extents ?? [],
          })),
        }
      : null,
    extracts: (m.extracts ?? []).map((e) => {
      const name = tr.maps(e.name, e.name);
      const w = wikiExtracts.find((x) => looseKey(x.name) === looseKey(name) || looseKey(x.name).startsWith(looseKey(name)));
      return {
        id: e.id,
        name,
        // game data leaves the faction empty on some map variants; the wiki table says Scav / PMC / All
        faction: e.faction ?? { scav: "scav", pmc: "pmc", all: "shared" }[looseKey(w?.faction ?? "")] ?? null,
        position: point(e.position),
        outline: outline(e.outline),
        wiki: w ? { faction: w.faction || null, requirementsHtml: w.requirementsHtml, notesHtml: w.notesHtml, alwaysAvailable: w.alwaysAvailable, singleUse: w.singleUse } : null,
      };
    }),
    transits: (m.transits ?? []).map((t) => ({
      id: t.id,
      name: tr.maps(t.description, t.description),
      to: mapRef(t.map),
      position: point(t.position),
      outline: outline(t.outline),
    })),
    hazards: (m.hazards ?? []).map((h) => ({
      type: h.hazardType,
      name: tr.maps(h.name, h.hazardType),
      position: point(h.position),
      outline: outline(h.outline),
    })),
    locks: (m.locks ?? [])
      .filter((l) => l.key && l.position)
      .map((l) => ({ type: l.lockType, key: useItem(l.key), position: point(l.position), needsPower: !!l.needsPower })),
    bosses: bossesOut.filter((b) => b.spawns.some((s) => s.map === m.normalizedName)).map((b) => b.id),
    wikiExtracts,
  });
}
// variants (Night Factory, Ground Zero 21+) share extracts with their base map: copy the faction from the
// extract with the same name at (nearly) the same spot
for (const m of mapsOut.filter((x) => x.variant)) {
  const base = mapsOut.find((x) => x.id === m.family);
  for (const e of m.extracts) {
    if (e.faction || !e.position || !base) continue;
    const match = base.extracts
      .filter((x) => x.faction && x.position && looseKey(x.name) === looseKey(e.name))
      .map((x) => ({ x, d: Math.hypot(x.position.x - e.position.x, x.position.z - e.position.z) }))
      .sort((a, b) => a.d - b.d)[0];
    if (match && match.d < 25) e.faction = match.x.faction;
  }
}
const unknownFaction = mapsOut.flatMap((m) => m.extracts.filter((e) => !e.faction).map((e) => `${m.name}: ${e.name}`));
if (unknownFaction.length) warn(`Extracts zonder PMC/Scav-indeling: ${unknownFaction.join(", ")}`);
mapsOut.sort((a, b) => Number(a.variant) - Number(b.variant) || a.name.localeCompare(b.name));
log(`Maps: ${mapsOut.length} (${mapsOut.filter((m) => m.config?.svg).length} met SVG)`);

// ---------------------------------------------------------------------------
// 6. Wiki images (guides, boss locations, portraits, item icons for wiki-only items)
// ---------------------------------------------------------------------------

const wantedFiles = new Set();
for (const q of quests) for (const g of q.guideImages) wantedFiles.add(g.file);
for (const b of bossesOut) {
  if (b.portraitFile) wantedFiles.add(b.portraitFile);
  for (const s of b.spawns) for (const i of s.wikiImages) wantedFiles.add(i.file);
  for (const w of b.wikiOnlyMaps) for (const i of w.images) wantedFiles.add(i.file);
}
for (const it of items.values()) if (!it.icon && it.iconFile) wantedFiles.add(it.iconFile);
log(`Wiki-afbeeldingen opzoeken: ${wantedFiles.size}...`);
const imageUrls = await getImageUrls([...wantedFiles], 900);
const img = (f) => {
  const hit = imageUrls.get(f);
  return hit ? { file: f.file ?? f, url: hit.url, thumb: hit.thumb } : null;
};
const withUrl = (list) => list.map((g) => ({ ...g, ...(imageUrls.get(g.file) ? { url: imageUrls.get(g.file).url, thumb: imageUrls.get(g.file).thumb } : {}) }));
for (const q of quests) q.guideImages = withUrl(q.guideImages);
for (const b of bossesOut) {
  if (!b.portrait && b.portraitFile) b.portrait = img(b.portraitFile)?.thumb ?? null;
  for (const s of b.spawns) s.wikiImages = withUrl(s.wikiImages);
  for (const w of b.wikiOnlyMaps) w.images = withUrl(w.images);
  delete b.portraitFile;
}
for (const it of items.values()) {
  if (!it.icon && it.iconFile) it.icon = img(it.iconFile)?.thumb ?? null;
  delete it.iconFile;
}

// ---------------------------------------------------------------------------
// 7. Checks + write
// ---------------------------------------------------------------------------

const unmatchedWiki = quests.filter((q) => q.source === "wiki").map((q) => q.title);
const apiOnly = quests.filter((q) => q.source === "api").map((q) => q.title);
const withoutPins = quests.filter((q) => q.maps.length && !q.apiObjectives.some((o) => o.pins.length)).map((q) => q.title);
if (unknownTemplates.size) warn(`Onbekende wiki-templates: ${[...unknownTemplates.keys()].slice(0, 20).join(", ")}`);

const meta = {
  fetchedAt: new Date().toISOString(),
  durationSec: Math.round((Date.now() - started) / 1000),
  mode: MODE,
  sources: {
    wiki: "https://escapefromtarkov.fandom.com/wiki/Quests",
    api: `https://json.tarkov.dev/${MODE}`,
    mapConfig: "https://github.com/the-hideout/tarkov-dev/blob/main/src/data/maps.json",
    mapSvg: "https://github.com/the-hideout/tarkov-dev-svg-maps",
  },
  counts: {
    quests: quests.length,
    questsWikiAndApi: quests.length - unmatchedWiki.length - apiOnly.length,
    questsWikiOnly: unmatchedWiki.length,
    questsApiOnly: apiOnly.length,
    questsWithItems: quests.filter((q) => q.items.length).length,
    questsWithMapPins: quests.filter((q) => q.apiObjectives.some((o) => o.pins.length)).length,
    items: items.size,
    bosses: bossesOut.filter((b) => b.isBoss).length,
    mobs: bossesOut.length,
    maps: mapsOut.length,
    ammo: ammo.length,
    builds: builds.weapons.length,
    tradeProfits: trades.filter((t) => t.profit > 0).length,
    wikiImages: imageUrls.size,
  },
  questsWikiOnly: unmatchedWiki,
  questsApiOnly: apiOnly,
  questsWithoutPins: withoutPins,
  warnings,
};

await mkdir(dataDir, { recursive: true });
await writeJson("quests.json", { traders, quests });
await writeJson("items.json", Object.fromEntries(items));
await writeJson("bosses.json", bossesOut);
await writeJson("maps.json", mapsOut);
await writeJson("ammo.json", { calibers, ammo });
await writeJson("builds.json", builds);
await writeJson("trades.json", {
  fleaMinLevel: api.items.fleaMarket?.minPlayerLevel ?? 15,
  fee: { offer: api.items.fleaMarket?.sellOfferFeeRate ?? 0.05, requirement: api.items.fleaMarket?.sellRequirementFeeRate ?? 0.05 },
  items: trades,
});
await writeJson("meta.json", meta);
log("Klaar.", JSON.stringify(meta.counts));
if (warnings.length) log(`${warnings.length} waarschuwingen (zie data/meta.json)`);
