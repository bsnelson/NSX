/**
 * Mock Streamline-Bridge gateway — local development & tests, no DE1 needed.
 *
 * Serves `packages/nsx/src` as the web root (exactly like the Decent app does)
 * and mocks the REST + WebSocket API on the same port, so the skin runs
 * unmodified against http://localhost:8080.
 *
 * ETag behaviour deliberately mirrors the real gateway, verified against it:
 *   - list endpoints (profiles / beans / grinders / shots) send ETags and
 *     answer If-None-Match with 304
 *   - GET /store/<ns>?full=1 sends an ETag
 *   - GET /store/<ns>/<key> does NOT  ← the quirk behind issue #3
 *
 * Run: npm run dev:mock   (runs sync-core first, then this)
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, extname, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import * as fx from "./fixtures.mjs";

const PORT = Number(process.env.PORT || 8080);
const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "nsx", "src");

/* ── helpers ─────────────────────────────────────────────── */

/** Cheap stable hash (djb2) → quoted ETag per RFC 7232. */
function computeEtag(data) {
  const s = JSON.stringify(data);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `"${(h >>> 0).toString(16)}"`;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/* ── mutable state ───────────────────────────────────────── */

const state = {
  machine: { ...fx.machineState },
  profiles: structuredClone(fx.profiles),
  deletedProfiles: structuredClone(fx.deletedProfiles),
  beans: structuredClone(fx.beans),
  beanBatches: structuredClone(fx.beanBatches),
  grinders: structuredClone(fx.grinders),
  shots: structuredClone(fx.shots),
  store: structuredClone(fx.store),
  workflow: structuredClone(fx.currentWorkflow),
  // Simulated shot progression
  shotStartedAt: 0,
  frameOffset: 0,
};

const FLOWING = new Set(["espresso", "steam", "hotWater", "flush"]);
const FRAME_SECONDS = 6;

function setMachineState(next) {
  if (next === "skipStep") {
    state.frameOffset += 1; // advance one profile frame
    return;
  }
  state.machine.state = next;
  if (FLOWING.has(next)) {
    state.machine.substate = "preinfusion";
    state.shotStartedAt = Date.now();
    state.frameOffset = 0;
  } else {
    state.machine.substate = "ready";
    state.shotStartedAt = 0;
    state.frameOffset = 0;
  }
}

/** Current simulated snapshot, driving the live graph + step progress. */
function snapshot() {
  const flowing = FLOWING.has(state.machine.state) && state.shotStartedAt > 0;
  const elapsed = flowing ? (Date.now() - state.shotStartedAt) / 1000 : 0;

  if (flowing && elapsed > 2) state.machine.substate = "pouring";
  if (flowing && elapsed > 45) setMachineState("idle");

  const frameCount = state.workflow?.profile?.steps?.length || 4;
  const profileFrame = flowing
    ? Math.min(Math.floor(elapsed / FRAME_SECONDS) + state.frameOffset, frameCount - 1)
    : 0;

  return {
    timestamp: new Date().toISOString(),
    state: { state: state.machine.state, substate: state.machine.substate },
    profileFrame,
    pressure: flowing ? Math.min(9, elapsed * 1.6) : 0,
    flow: flowing ? Math.min(2.4, 0.3 + elapsed * 0.08) : 0,
    targetPressure: flowing ? 9 : 0,
    targetFlow: flowing ? 2 : 0,
    groupTemperature: 92 + Math.sin(Date.now() / 4000),
    targetGroupTemperature: 93,
  };
}

/* ── REST routing ────────────────────────────────────────── */

function routeApi(req, res, url, body) {
  const path = url.pathname;
  const method = req.method;
  const q = url.searchParams;

  const json = (data, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(data === null ? "" : JSON.stringify(data));
  };
  const noContent = () => { res.writeHead(204); res.end(); };

  /** Send with ETag + conditional-GET support. */
  const jsonEtag = (data) => {
    const etag = computeEtag(data);
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", ETag: etag });
    res.end(JSON.stringify(data));
  };

  // ── machine ──
  if (path === "/api/v1/machine/state" && method === "GET") return json(state.machine);
  if (path.startsWith("/api/v1/machine/state/") && method === "PUT") {
    setMachineState(decodeURIComponent(path.split("/").pop()));
    return json(state.machine);
  }
  if (path === "/api/v1/machine/info") return json(fx.machineInfo);
  if (path === "/api/v1/machine/waterLevels") return json(fx.waterLevels);
  if (path === "/api/v1/machine/settings") return method === "GET" ? json({}) : noContent();

  // ── workflow ──
  if (path === "/api/v1/workflow/current" && method === "GET") return json(state.workflow);
  if (path === "/api/v1/workflow" && (method === "PUT" || method === "POST")) {
    state.workflow = body ?? state.workflow;
    return json(state.workflow);
  }

  // ── profiles ──
  if (path === "/api/v1/profiles" && method === "GET") {
    if (q.get("visibility") === "deleted") return jsonEtag(state.deletedProfiles);
    const all = q.get("includeHidden") === "true";
    return jsonEtag(all ? state.profiles : state.profiles.filter((p) => p.visibility !== "hidden"));
  }
  if (path === "/api/v1/profiles" && method === "POST") {
    const rec = { id: `profile:${Date.now()}`, metadata: { source: "user" }, ...body };
    state.profiles.push(rec);
    return json(rec, 201);
  }
  if (path.startsWith("/api/v1/profiles/") && method === "GET") {
    const id = decodeURIComponent(path.split("/")[4]);
    const rec = state.profiles.find((p) => p.id === id);
    return rec ? json(rec) : json({ message: "not found" }, 404);
  }
  if (path.startsWith("/api/v1/profiles/") && path.endsWith("/visibility") && method === "PUT") {
    const id = decodeURIComponent(path.split("/")[4]);
    const rec = state.profiles.find((p) => p.id === id);
    if (rec) rec.visibility = body?.visibility ?? null;
    return rec ? json(rec) : json({ message: "not found" }, 404);
  }
  if (path.startsWith("/api/v1/profiles/") && method === "PUT") {
    const id = decodeURIComponent(path.split("/")[4]);
    const i = state.profiles.findIndex((p) => p.id === id);
    if (i < 0) return json({ message: "not found" }, 404);
    state.profiles[i] = { ...state.profiles[i], ...body };
    return json(state.profiles[i]);
  }
  if (path.startsWith("/api/v1/profiles/") && method === "DELETE") {
    const id = decodeURIComponent(path.split("/")[4]);
    const i = state.profiles.findIndex((p) => p.id === id);
    if (i >= 0) state.deletedProfiles.push(...state.profiles.splice(i, 1));
    return noContent();
  }

  // ── beans / batches / grinders ──
  if (path === "/api/v1/beans" && method === "GET") {
    const incl = q.get("includeArchived") === "true";
    return jsonEtag(incl ? state.beans : state.beans.filter((b) => !b.archived));
  }
  const batchMatch = path.match(/^\/api\/v1\/beans\/([^/]+)\/batches$/);
  if (batchMatch && method === "GET") {
    return jsonEtag(state.beanBatches[decodeURIComponent(batchMatch[1])] ?? []);
  }
  if (path === "/api/v1/grinders" && method === "GET") return jsonEtag(state.grinders);

  // ── shots ──
  if (path === "/api/v1/shots" && method === "GET") {
    const limit = Number(q.get("limit") ?? 20);
    const offset = Number(q.get("offset") ?? 0);
    return jsonEtag({ items: state.shots.slice(offset, offset + limit), total: state.shots.length });
  }
  if (path.startsWith("/api/v1/shots/") && method === "GET") {
    const id = decodeURIComponent(path.split("/")[4]);
    const s = state.shots.find((x) => x.id === id);
    return s ? json(s) : json({ message: "not found" }, 404);
  }
  if (path.startsWith("/api/v1/shots/") && method === "PUT") {
    const id = decodeURIComponent(path.split("/")[4]);
    const s = state.shots.find((x) => x.id === id);
    if (!s) return json({ message: "not found" }, 404);
    // The real API merges `extras` at field level.
    if (body?.annotations) {
      s.annotations = {
        ...s.annotations,
        ...body.annotations,
        extras: { ...s.annotations?.extras, ...body.annotations?.extras },
      };
    }
    return json(s);
  }
  if (path.startsWith("/api/v1/shots/") && method === "DELETE") {
    const id = decodeURIComponent(path.split("/")[4]);
    const i = state.shots.findIndex((x) => x.id === id);
    if (i >= 0) state.shots.splice(i, 1);
    return noContent();
  }

  // ── key-value store ──
  const nsMatch = path.match(/^\/api\/v1\/store\/([^/]+)$/);
  if (nsMatch && method === "GET") {
    const ns = decodeURIComponent(nsMatch[1]);
    // Only the namespace-wide (?full=1) read is ETag-backed — same as the real
    // gateway. This is exactly why issue #3 switched recipes/favorites to it.
    const data = state.store[ns] ?? {};
    return q.get("full") === "1" ? jsonEtag(data) : json(Object.keys(data));
  }
  const kvMatch = path.match(/^\/api\/v1\/store\/([^/]+)\/([^/]+)$/);
  if (kvMatch) {
    const ns = decodeURIComponent(kvMatch[1]);
    const key = decodeURIComponent(kvMatch[2]);
    if (method === "GET") {
      const val = state.store[ns]?.[key];
      // NOTE: no ETag here, on purpose — mirrors the real gateway.
      return val === undefined ? json({ message: "not found" }, 404) : json(val);
    }
    if (method === "POST" || method === "PUT") {
      state.store[ns] = state.store[ns] ?? {};
      state.store[ns][key] = body;
      return noContent();
    }
    if (method === "DELETE") {
      delete state.store[ns]?.[key];
      return noContent();
    }
  }

  // ── misc ──
  if (path === "/api/v1/scale/tare") return noContent();
  if (path === "/api/v1/devices/scan") return noContent();
  if (path === "/api/v1/presence/schedules") return method === "GET" ? json([]) : json(body ?? {}, 201);
  if (path.startsWith("/api/v1/steams/")) return json({ message: "not found" }, 404);

  return json({ message: `mock: unhandled ${method} ${path}` }, 404);
}

/* ── static file serving (packages/nsx/src as web root) ──── */

async function serveStatic(url, res) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const filePath = join(WEB_ROOT, normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(WEB_ROOT) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  const body = await readFile(filePath);
  res.writeHead(200, {
    "Content-Type": MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/* ── HTTP server ─────────────────────────────────────────── */

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (!url.pathname.startsWith("/api/")) return void serveStatic(url, res);

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = null;
    if (chunks.length) {
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
    }
    try {
      routeApi(req, res, url, body);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: String(err?.message || err) }));
    }
  });
});

/* ── WebSockets ──────────────────────────────────────────── */

const WS_PATHS = [
  "/ws/v1/machine/snapshot",
  "/ws/v1/scale/snapshot",
  "/ws/v1/machine/waterLevels",
  "/ws/v1/devices",
  "/ws/v1/logs",
  "/ws/v1/plugins/time-to-ready.reaplugin/timeToReady",
];

const wss = new Map(WS_PATHS.map((p) => [p, new WebSocketServer({ noServer: true })]));

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);
  const target = wss.get(pathname);
  if (!target) return void socket.destroy();
  target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
});

const broadcast = (path, payload) => {
  for (const ws of wss.get(path).clients) {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  }
};

// Announce connected devices + scale status on connect.
wss.get("/ws/v1/devices").on("connection", (ws) =>
  ws.send(JSON.stringify({
    devices: [
      { type: "machine", state: "connected" },
      { type: "scale", state: "connected" },
    ],
  })));
wss.get("/ws/v1/scale/snapshot").on("connection", (ws) => ws.send(JSON.stringify({ status: "connected" })));
wss.get("/ws/v1/machine/waterLevels").on("connection", (ws) => ws.send(JSON.stringify(fx.waterLevels)));

// Live streams.
setInterval(() => broadcast("/ws/v1/machine/snapshot", snapshot()), 250);
setInterval(() => {
  const flowing = FLOWING.has(state.machine.state) && state.shotStartedAt > 0;
  const elapsed = flowing ? (Date.now() - state.shotStartedAt) / 1000 : 0;
  broadcast("/ws/v1/scale/snapshot", {
    weight: flowing ? Math.round(elapsed * 1.2 * 10) / 10 : 0,
    weightFlow: flowing ? 1.2 : 0,
  });
}, 250);
setInterval(() => broadcast("/ws/v1/machine/waterLevels", fx.waterLevels), 5000);

server.listen(PORT, () => {
  console.log(`Mock gateway on http://localhost:${PORT}`);
  console.log(`  web root: ${WEB_ROOT}`);
  console.log(`  PUT /api/v1/machine/state/espresso to start a simulated shot`);
});
