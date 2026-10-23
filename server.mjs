/**
 * Local helper server (no dependencies):
 *   /                 -> public/ (frontend)
 *   /data/*           -> data/ (synced datasets + map SVGs)
 *   /vendor/leaflet/* -> node_modules/leaflet/dist
 *   GET  /api/status   meta + sync state
 *   POST /api/sync     start a sync now
 *   GET/PUT /api/progress  quest progress (data/progress.json)
 *
 * Env: PORT (3311), HOST (127.0.0.1), SYNC_INTERVAL_HOURS (6, 0 = off), GAME_MODE (regular|pve)
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, writeFile, rename, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, "data");
const PORT = Number(process.env.PORT ?? 3311);
const HOST = process.env.HOST ?? "127.0.0.1";
const SYNC_INTERVAL_HOURS = Number(process.env.SYNC_INTERVAL_HOURS ?? 6);
const GAME_MODE = process.env.GAME_MODE === "pve" ? "pve" : "regular";

const MOUNTS = [
  { prefix: "/vendor/leaflet/", dir: path.join(root, "node_modules", "leaflet", "dist") },
  { prefix: "/data/", dir: dataDir },
  { prefix: "/", dir: path.join(root, "public") },
];

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg"]);
const gzCache = new Map(); // file -> { mtimeMs, buf }

// ---------------------------------------------------------------------------
// Sync process
// ---------------------------------------------------------------------------

const sync = { running: false, startedAt: null, finishedAt: null, exitCode: null, log: [] };

function startSync(reason) {
  if (sync.running) return false;
  Object.assign(sync, { running: true, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, log: [`Sync gestart (${reason})`] });
  const child = spawn(process.execPath, [path.join(root, "sync", "index.mjs"), `--mode=${GAME_MODE}`], { cwd: root });
  const push = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      sync.log.push(line);
      console.log(`[sync] ${line}`);
    }
    if (sync.log.length > 300) sync.log.splice(0, sync.log.length - 300);
  };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  child.on("close", (code) => {
    Object.assign(sync, { running: false, finishedAt: new Date().toISOString(), exitCode: code });
    gzCache.clear();
    push(code === 0 ? "Sync klaar." : `Sync mislukt (exit ${code}).`);
  });
  return true;
}

async function readMeta() {
  try {
    return JSON.parse(await readFile(path.join(dataDir, "meta.json"), "utf8"));
  } catch {
    return null;
  }
}

async function maybeAutoSync() {
  const meta = await readMeta();
  if (!meta) return startSync("eerste start, nog geen data");
  if (SYNC_INTERVAL_HOURS > 0 && Date.now() - Date.parse(meta.fetchedAt) > SYNC_INTERVAL_HOURS * 3600e3) {
    startSync(`data ouder dan ${SYNC_INTERVAL_HOURS} uur`);
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Cache-Control": "no-store", ...headers });
  res.end(body);
}
const sendJson = (res, status, value) => send(res, status, JSON.stringify(value), { "Content-Type": TYPES[".json"] });

async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/status" && req.method === "GET") {
    return sendJson(res, 200, { meta: await readMeta(), sync: { ...sync, log: sync.log.slice(-60) }, mode: GAME_MODE, syncIntervalHours: SYNC_INTERVAL_HOURS });
  }
  if (pathname === "/api/sync" && req.method === "POST") {
    const started = startSync("handmatig");
    return sendJson(res, started ? 202 : 409, { started, running: sync.running });
  }
  if (pathname === "/api/progress") {
    const file = path.join(dataDir, "progress.json");
    if (req.method === "GET") {
      try {
        return send(res, 200, await readFile(file, "utf8"), { "Content-Type": TYPES[".json"] });
      } catch {
        return sendJson(res, 200, {});
      }
    }
    if (req.method === "PUT") {
      const body = await readBody(req);
      let value;
      try {
        value = JSON.parse(body);
      } catch {
        return sendJson(res, 400, { error: "invalid json" });
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) return sendJson(res, 400, { error: "object expected" });
      await mkdir(dataDir, { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(value));
      await rename(`${file}.tmp`, file);
      return sendJson(res, 200, { ok: true });
    }
  }
  return sendJson(res, 404, { error: "not found" });
}

async function serveStatic(req, res, pathname) {
  const mount = MOUNTS.find((m) => pathname.startsWith(m.prefix));
  let rel = decodeURIComponent(pathname.slice(mount.prefix.length));
  if (!rel || rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(mount.dir, rel);
  if (!file.startsWith(mount.dir + path.sep)) return send(res, 403, "forbidden");
  if (mount.dir === dataDir && path.basename(file) === "progress.json") return send(res, 404, "not found");
  let info;
  try {
    info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    return send(res, 404, "not found");
  }
  const ext = path.extname(file).toLowerCase();
  const headers = {
    "Content-Type": TYPES[ext] ?? "application/octet-stream",
    "Cache-Control": mount.prefix === "/vendor/leaflet/" ? "max-age=86400" : "no-cache",
    "Last-Modified": info.mtime.toUTCString(),
  };
  if (req.headers["if-modified-since"] && Date.parse(req.headers["if-modified-since"]) >= Math.floor(info.mtimeMs / 1000) * 1000) {
    return send(res, 304, null, headers);
  }
  if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers["accept-encoding"] ?? "") && info.size > 1024) {
    let cached = gzCache.get(file);
    if (!cached || cached.mtimeMs !== info.mtimeMs) {
      cached = { mtimeMs: info.mtimeMs, buf: zlib.gzipSync(await readFile(file), { level: 6 }) };
      gzCache.set(file, cached);
    }
    return send(res, 200, cached.buf, { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
  }
  res.writeHead(200, { ...headers, "Content-Length": info.size });
  createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, "http://local");
    if (pathname.startsWith("/api/")) return await handleApi(req, res, pathname);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");
    return await serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, err.status ?? 500, String(err.message ?? err));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Tarkov Helper draait op http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}  (modus: ${GAME_MODE})`);
  maybeAutoSync();
  if (SYNC_INTERVAL_HOURS > 0) setInterval(maybeAutoSync, 15 * 60e3).unref();
});
