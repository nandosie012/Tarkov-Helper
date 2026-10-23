/**
 * Static build for free hosting (GitHub Pages, Vercel, Cloudflare Pages, Netlify):
 * runs the sync, then assembles ./dist with the frontend, the data and Leaflet.
 * The result needs no server: progress is kept in the browser and fresh data comes from a scheduled rebuild.
 *
 *   node scripts/build.mjs [--skip-sync] [--mode=pve]
 *
 * GAME_MODE=pve works as well (handy as an environment variable in CI).
 */

import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const dataDir = path.join(root, "data");
const args = new Set(process.argv.slice(2));
const modeArg = [...args].find((a) => a.startsWith("--mode="));
const mode = modeArg ? modeArg.split("=")[1] : process.env.GAME_MODE === "pve" ? "pve" : "regular";

if (!args.has("--skip-sync")) {
  const result = spawnSync(process.execPath, [path.join(root, "sync", "index.mjs"), `--mode=${mode}`], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    console.error("Sync mislukt, build gestopt.");
    process.exit(result.status ?? 1);
  }
}

const required = ["quests.json", "items.json", "bosses.json", "maps.json", "ammo.json", "builds.json", "trades.json", "meta.json"];
for (const file of required) {
  try {
    await readFile(path.join(dataDir, file));
  } catch {
    console.error(`data/${file} ontbreekt. Draai de build zonder --skip-sync.`);
    process.exit(1);
  }
}

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, "data", "maps"), { recursive: true });

await cp(path.join(root, "public"), dist, { recursive: true });
await cp(path.join(root, "node_modules", "leaflet", "dist"), path.join(dist, "vendor", "leaflet"), { recursive: true });
for (const file of required.filter((f) => f !== "meta.json")) {
  await cp(path.join(dataDir, file), path.join(dist, "data", file));
}
for (const file of await readdir(path.join(dataDir, "maps"))) {
  if (file.endsWith(".svg")) await cp(path.join(dataDir, "maps", file), path.join(dist, "data", "maps", file));
}

// meta.json + where/when this build ran (shown on the Data page)
const meta = JSON.parse(await readFile(path.join(dataDir, "meta.json"), "utf8"));
meta.build = {
  builtAt: new Date().toISOString(),
  source: process.env.GITHUB_ACTIONS ? "GitHub Actions" : process.env.VERCEL ? "Vercel" : process.env.CF_PAGES ? "Cloudflare Pages" : process.env.NETLIFY ? "Netlify" : "lokale build",
};
await writeFile(path.join(dist, "data", "meta.json"), JSON.stringify(meta));

// Cache-busting: static hosts cache JS/CSS for minutes (GitHub Pages: 10), so a returning visitor could mix
// fresh data with old modules. Every build gets its own ?v= on the stylesheet, the entry script and all
// relative module imports, so a new deploy is picked up as one consistent set.
const version = Date.now().toString(36);
const jsDir = path.join(dist, "js");
for (const entry of await readdir(jsDir, { withFileTypes: true, recursive: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
  const file = path.join(entry.parentPath ?? entry.path, entry.name);
  const src = await readFile(file, "utf8");
  await writeFile(file, src.replace(/(from\s+["'])(\.{1,2}\/[^"'?]+\.js)(["'])/g, `$1$2?v=${version}$3`));
}

// mark the page as static so the app skips the local server's API
const indexFile = path.join(dist, "index.html");
const index = await readFile(indexFile, "utf8");
await writeFile(
  indexFile,
  index
    .replace("<head>", `<head>\n  <meta name="th-mode" content="static">`)
    .replace('href="css/app.css"', `href="css/app.css?v=${version}"`)
    .replace('src="js/app.js"', `src="js/app.js?v=${version}"`)
);

// GitHub Pages: serve files as-is (no Jekyll processing)
await writeFile(path.join(dist, ".nojekyll"), "");

const size = async (dir) => {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += (await stat(path.join(entry.parentPath ?? entry.path, entry.name))).size;
  }
  return total;
};
console.log(`dist/ klaar (${(await size(dist) / 1024 / 1024).toFixed(1)} MB, modus ${mode}).`);
