// Shares wiki fetches between the sync runs for several game modes: the wiki is the same for all of them.
// A run reuses a cache file that is less than 30 minutes old and only fetches what is missing.

import { readFile, writeFile } from "node:fs/promises";
import { getWikitext, getPages, getImageUrls, normTitle } from "./wiki.mjs";

const MAX_AGE = 30 * 60e3;

export async function openWikiCache(file) {
  let data = { at: Date.now(), wikitext: {}, pages: {}, images: {} };
  if (file) {
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      if (Date.now() - saved.at < MAX_AGE) data = saved;
    } catch {
      /* no cache yet */
    }
  }
  const reused = Object.keys(data.pages).length > 0;

  return {
    reused,
    async wikitext(title) {
      data.wikitext[title] ??= await getWikitext(title);
      return data.wikitext[title];
    },
    /** Same contract as getPages(): Map(title -> page), missing pages left out. */
    async pages(titles, options) {
      const missing = [...new Set(titles.map(normTitle))].filter((t) => !(t in data.pages));
      if (missing.length) {
        const got = await getPages(missing, options);
        for (const t of missing) data.pages[t] = got.get(t) ?? null;
        for (const [k, v] of got) data.pages[k] = v;
      }
      return new Map(Object.entries(data.pages).filter(([, v]) => v));
    },
    /** Same contract as getImageUrls(). */
    async images(files, width) {
      const missing = [...new Set(files.map((f) => normTitle(String(f).replace(/^(File|Image):/i, ""))))].filter((f) => f && !(f in data.images));
      if (missing.length) {
        const got = await getImageUrls(missing, width);
        for (const f of missing) data.images[f] = got.get(f) ?? null;
        for (const [k, v] of got) data.images[k] = v;
      }
      return new Map(Object.entries(data.images).filter(([, v]) => v));
    },
    async save() {
      if (file) await writeFile(file, JSON.stringify(data));
    },
  };
}
