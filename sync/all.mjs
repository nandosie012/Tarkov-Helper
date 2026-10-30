/**
 * Sync every mode the site offers:
 *   - the main mode (regular, or pve with GAME_MODE=pve) into data/
 *   - the current PvP season into data/season/
 * The wiki is fetched once and shared between both runs through data/.wiki-cache.json.
 * A failing season sync (e.g. between seasons) keeps the previous season data and does not fail the build.
 *
 *   node sync/all.mjs [--force-maps]
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extra = process.argv.slice(2);
const runs = [
  { mode: process.env.GAME_MODE === "pve" ? "pve" : "regular", out: "data", required: true },
  { mode: "season", out: path.join("data", "season"), required: false },
];

for (const run of runs) {
  console.log(`\n=== Sync ${run.mode} -> ${run.out}`);
  const result = spawnSync(
    process.execPath,
    [path.join(root, "sync", "index.mjs"), `--mode=${run.mode}`, `--out=${run.out}`, "--wiki-cache=data/.wiki-cache.json", ...extra],
    { cwd: root, stdio: "inherit" }
  );
  if (result.status !== 0) {
    if (run.required) process.exit(result.status ?? 1);
    console.warn(`Sync voor ${run.mode} mislukt (exit ${result.status}); de vorige data blijft staan.`);
  }
}
