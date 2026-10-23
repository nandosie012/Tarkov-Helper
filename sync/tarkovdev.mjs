// json.tarkov.dev (game-data dumps, updated continuously) + tarkov.dev map rendering config.
// The GraphQL endpoint (api.tarkov.dev) is unreliable, so only the static JSON endpoints are used.

import { getJson } from "./http.mjs";

const JSON_BASE = "https://json.tarkov.dev";
const MAP_CONFIG = "https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/src/data/maps.json";

export async function fetchTarkovDev(mode = "regular", lang = "en") {
  const get = (name) => getJson(`${JSON_BASE}/${mode}/${name}`).then((b) => b.data);
  const [tasks, tasksT, items, itemsT, maps, mapsT, traders, tradersT, mapConfig] = await Promise.all([
    get("tasks"),
    get(`tasks_${lang}`),
    get("items"),
    get(`items_${lang}`),
    get("maps"),
    get(`maps_${lang}`),
    get("traders"),
    get(`traders_${lang}`),
    getJson(MAP_CONFIG),
  ]);
  const t = (table) => (key, fallback = "") => {
    if (!key) return fallback;
    const value = table?.[key];
    return typeof value === "string" && value.length ? value : fallback;
  };
  return {
    tasks,
    items,
    maps,
    traders,
    mapConfig,
    tr: { tasks: t(tasksT), items: t(itemsT), maps: t(mapsT), traders: t(tradersT) },
  };
}

/** Wiki title from a fandom URL, or null. */
export function wikiTitleFromUrl(url) {
  if (!url) return null;
  const m = /\/wiki\/([^?#]+)/.exec(url);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).replace(/_/g, " ").trim();
  } catch {
    return m[1].replace(/_/g, " ").trim();
  }
}
