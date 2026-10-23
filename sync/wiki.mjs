// MediaWiki client for the Escape from Tarkov wiki (Fandom).
// Batches page and image lookups (50 titles per request) to keep the request count low.

import { getJson, sleep } from "./http.mjs";

export const WIKI_BASE = "https://escapefromtarkov.fandom.com";
const API = `${WIKI_BASE}/api.php`;
const BATCH = 50;

export function wikiUrl(title) {
  return `${WIKI_BASE}/wiki/${encodeURIComponent(String(title).replace(/ /g, "_")).replace(/%2F/g, "/")}`;
}

export function normTitle(value) {
  return String(value ?? "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

/** Loose key for fuzzy matching between wiki titles and API names. */
export function looseKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function api(params) {
  const url = new URL(API);
  for (const [key, value] of Object.entries({ format: "json", formatversion: "2", ...params })) {
    url.searchParams.set(key, value);
  }
  const body = await getJson(url);
  if (body.error) throw new Error(`wiki api: ${body.error.code} ${body.error.info}`);
  return body;
}

export async function getWikitext(title) {
  const body = await api({ action: "parse", page: title, prop: "wikitext|revid", redirects: "1" });
  return { title: body.parse.title, revid: body.parse.revid, wikitext: body.parse.wikitext };
}

/**
 * Fetch wikitext for many pages. Returns Map(requestedTitle -> { title, revid, timestamp, wikitext })
 * Missing pages are left out. Redirects are followed.
 */
export async function getPages(titles, { onProgress } = {}) {
  const unique = [...new Set(titles.map(normTitle))];
  const result = new Map();
  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    const body = await api({
      action: "query",
      prop: "revisions",
      rvprop: "content|ids|timestamp",
      rvslots: "main",
      redirects: "1",
      titles: chunk.join("|"),
    });
    const alias = new Map();
    for (const n of body.query?.normalized ?? []) alias.set(n.to, n.from);
    for (const r of body.query?.redirects ?? []) alias.set(r.to, alias.get(r.from) ?? r.from);
    for (const page of body.query?.pages ?? []) {
      if (page.missing || !page.revisions?.length) continue;
      const rev = page.revisions[0];
      const entry = {
        title: page.title,
        revid: rev.revid,
        timestamp: rev.timestamp,
        wikitext: rev.slots?.main?.content ?? rev.content ?? "",
      };
      result.set(page.title, entry);
      const from = alias.get(page.title);
      if (from) result.set(normTitle(from), entry);
    }
    onProgress?.(Math.min(i + BATCH, unique.length), unique.length);
    await sleep(150);
  }
  return result;
}

/** Resolve File: names to image URLs. Returns Map(fileName -> { url, thumb, width, height }). */
export async function getImageUrls(fileNames, width = 800) {
  const unique = [...new Set(fileNames.map((f) => normTitle(String(f).replace(/^(File|Image):/i, ""))))].filter(Boolean);
  const result = new Map();
  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    const body = await api({
      action: "query",
      prop: "imageinfo",
      iiprop: "url|size",
      iiurlwidth: String(width),
      titles: chunk.map((f) => `File:${f}`).join("|"),
    });
    const alias = new Map();
    for (const n of body.query?.normalized ?? []) alias.set(n.to, n.from);
    for (const page of body.query?.pages ?? []) {
      const info = page.imageinfo?.[0];
      if (!info) continue;
      const entry = { url: info.url, thumb: info.thumburl ?? info.url, width: info.width, height: info.height };
      const name = page.title.replace(/^File:/, "");
      result.set(name, entry);
      const from = alias.get(page.title);
      if (from) result.set(from.replace(/^File:/, ""), entry);
    }
    await sleep(150);
  }
  return result;
}

export async function getCategoryMembers(category) {
  const members = [];
  let cont;
  do {
    const body = await api({
      action: "query",
      list: "categorymembers",
      cmtitle: category,
      cmlimit: "500",
      cmtype: "page",
      ...(cont ? { cmcontinue: cont } : {}),
    });
    members.push(...(body.query?.categorymembers ?? []).map((m) => m.title));
    cont = body.continue?.cmcontinue;
  } while (cont);
  return members;
}
