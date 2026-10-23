// Where an item sits inside its 512px image: principal axis (PCA over the opaque pixels), its length and
// thickness along that axis, and the centre. The semi-render uses this to straighten parts that the game
// draws diagonally in square icons. Results are cached per image URL, so only new images are downloaded.

import { readFile, writeFile } from "node:fs/promises";

const ALPHA = 24;

function analyze(data, width, height) {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] <= ALPHA) continue;
      n++;
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!n) return null;
  const mx = sx / n, my = sy / n;
  const cxx = sxx / n - mx * mx, cyy = syy / n - my * my, cxy = sxy / n - mx * my;
  const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const ux = Math.cos(angle), uy = Math.sin(angle);
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (data[(y * width + x) * 4 + 3] <= ALPHA) continue;
      const dx = x - mx, dy = y - my;
      const u = dx * ux + dy * uy, v = -dx * uy + dy * ux;
      if (u < umin) umin = u;
      if (u > umax) umax = u;
      if (v < vmin) vmin = v;
      if (v > vmax) vmax = v;
    }
  }
  const cu = (umin + umax) / 2, cv = (vmin + vmax) / 2;
  const r = (v) => Math.round(v * 10) / 10;
  return {
    w: width,
    h: height,
    box: [x0, y0, x1 + 1, y1 + 1],
    cx: r(mx + cu * ux - cv * uy),
    cy: r(my + cu * uy + cv * ux),
    angle: r((angle * 180) / Math.PI),
    len: r(umax - umin),
    thick: r(vmax - vmin),
  };
}

/**
 * @param urls       image URLs to describe
 * @param cacheFile  JSON file with earlier results ({ url: geometry })
 * @returns Map(url -> geometry); empty when sharp is not available (the semi-render is then skipped)
 */
export async function imageGeometries(urls, cacheFile, { concurrency = 8, log = () => {} } = {}) {
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch (err) {
    log(`Afbeeldingsanalyse overgeslagen (sharp niet beschikbaar: ${err.message})`);
    return new Map();
  }
  let cache = {};
  try {
    cache = JSON.parse(await readFile(cacheFile, "utf8"));
  } catch {
    /* first run */
  }
  const todo = [...new Set(urls)].filter((u) => u && !(u in cache));
  let failed = 0;
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const url = todo[next++];
      try {
        const res = await fetch(url, { headers: { "User-Agent": "tarkov-helper/1.0 (local personal helper)" }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { data, info } = await sharp(Buffer.from(await res.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        cache[url] = analyze(data, info.width, info.height);
      } catch {
        failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (todo.length) log(`Afbeeldingen geanalyseerd: ${todo.length - failed} nieuw${failed ? `, ${failed} mislukt` : ""} (${Object.keys(cache).length} in cache)`);
  await writeFile(cacheFile, JSON.stringify(cache));
  return new Map([...new Set(urls)].filter((u) => cache[u]).map((u) => [u, cache[u]]));
}
