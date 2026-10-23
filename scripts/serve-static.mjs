/**
 * Preview ./dist exactly like a static host would serve it (no API, optional subpath).
 *
 *   node scripts/serve-static.mjs                       -> http://localhost:3312/
 *   node scripts/serve-static.mjs --base=/tarkov-helper/ -> http://localhost:3312/tarkov-helper/  (GitHub Pages project site)
 */

import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const PORT = Number(process.env.PORT ?? 3312);
const baseArg = process.argv.find((a) => a.startsWith("--base="))?.slice("--base=".length);
const BASE = `/${(baseArg ?? process.env.BASE ?? "/").replace(/^\/+|\/+$/g, "")}/`.replace("//", "/");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

http
  .createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://local");
    if (!pathname.startsWith(BASE)) {
      res.writeHead(404).end("not found");
      return;
    }
    let rel = decodeURIComponent(pathname.slice(BASE.length));
    if (!rel || rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(dist, rel);
    if (!file.startsWith(dist + path.sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error("dir");
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Content-Length": info.size });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404).end("not found");
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Statische preview: http://localhost:${PORT}${BASE}`));
