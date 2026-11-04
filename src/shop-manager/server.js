#!/usr/bin/env node
// Local "Shop manager" web UI: add/sign in stores, set aliases and the writable flag.
// Binds to 127.0.0.1 only, and every API call needs the random session token in the URL,
// so other websites in your browser can't drive it.
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { listShops, loadConfig, saveConfig, normalize, invalidateSessions } from "../core/shops.js";
import { readAudit } from "../core/audit.js";
import { listApprovals, decide } from "../core/approvals.js";
import { UI_PORT, CONFIG_PATH, AUDIT_PATH } from "../settings.js";
import { shopifyCommand } from "../shopify/env.js";

const HTML_PATH = fileURLToPath(new URL("./page.html", import.meta.url));

const STORE_RE = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/;
const SCOPE_RE = /^(unauthenticated_)?(read|write)_[a-z_]+$/;
const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const jobs = new Map(); // auth runs: id -> { lines, done, code, listeners:Set }

function startAuth(store, scopes) {
  const id = randomBytes(6).toString("hex");
  const job = { id, store, lines: [], done: false, code: null, listeners: new Set() };
  jobs.set(id, job);
  const push = (type, data) => {
    const evt = { type, data };
    if (type === "line") job.lines.push(data);
    for (const fn of job.listeners) fn(evt);
  };
  const [file, args] = shopifyCommand(["store", "auth", "-s", store, "--scopes", scopes.join(","), "--no-color"]);
  const child = spawn(file, args, {
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let pressedEnter = false;
  const onData = (buf) => {
    for (const raw of buf.toString().split(/\r?\n/)) {
      const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd();
      if (!line.trim()) continue;
      push("line", line);
      // If the CLI waits for a key press before opening the browser, press it for the user.
      if (!pressedEnter && /press (any key|enter)/i.test(line)) {
        pressedEnter = true;
        child.stdin.write("\n");
      }
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (e) => push("line", `Failed to start Shopify CLI: ${e.message}`));
  child.on("close", (code) => {
    invalidateSessions();
    job.done = true;
    job.code = code;
    push("done", { code });
  });
  job.kill = () => child.kill();
  setTimeout(() => { if (!job.done) child.kill(); }, 10 * 60_000); // give up after 10 min
  return job;
}

async function body(req) {
  let s = "";
  for await (const c of req) { s += c; if (s.length > 64_000) throw new Error("body too large"); }
  return s ? JSON.parse(s) : {};
}

const send = (res, status, obj) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
};

export async function startShopManager({ port = UI_PORT } = {}) {
  const token = randomBytes(16).toString("hex");

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (url.pathname === "/" && req.method === "GET") {
        if (url.searchParams.get("t") !== token) { res.writeHead(403); return res.end("Forbidden. Open the link printed by shophop."); }
        const html = (await readFile(HTML_PATH, "utf8")).replace("__TOKEN__", token);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(html);
      }
      if (!url.pathname.startsWith("/api/")) { res.writeHead(404); return res.end(); }
      if (req.headers["x-token"] !== token && url.searchParams.get("t") !== token) return send(res, 403, { error: "bad token" });

      // GET /api/shops
      if (url.pathname === "/api/shops" && req.method === "GET") {
        return send(res, 200, { configFile: CONFIG_PATH, ...(await listShops()) });
      }

      // GET /api/approvals  → copy-into-production requests;  POST /api/approvals {id, action, confirm}
      if (url.pathname === "/api/approvals" && req.method === "GET") {
        return send(res, 200, { approvals: await listApprovals() });
      }
      if (url.pathname === "/api/approvals" && req.method === "POST") {
        const b = await body(req);
        try { return send(res, 200, { approval: await decide(String(b.id || ""), b.action, b.confirm) }); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }

      // GET /api/audit?limit=50
      if (url.pathname === "/api/audit" && req.method === "GET") {
        const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 500);
        return send(res, 200, { auditFile: AUDIT_PATH, entries: await readAudit({ limit }) });
      }

      // PUT /api/shops  {alias, store, writable, note, previousAlias?}
      if (url.pathname === "/api/shops" && req.method === "PUT") {
        const b = await body(req);
        const store = normalize(b.store || "");
        const alias = String(b.alias || "").trim().toLowerCase();
        if (!STORE_RE.test(store)) return send(res, 400, { error: "Store must look like name.myshopify.com" });
        if (!ALIAS_RE.test(alias)) return send(res, 400, { error: "Alias: lowercase letters, digits, - or _, max 32 chars" });
        const cfg = await loadConfig();
        const clash = Object.entries(cfg).find(([a, c]) => a === alias && normalize(c.store) !== store);
        if (clash) return send(res, 400, { error: `Alias "${alias}" is already used by ${clash[1].store}` });
        for (const [a, c] of Object.entries(cfg)) if (normalize(c.store) === store) delete cfg[a]; // one alias per store
        cfg[alias] = {
          store,
          writable: b.writable === true,
          ...(b.writable === true && b.allowDestructive === true && { allowDestructive: true }),
          ...(b.production === true && { production: true }),
          ...(b.note ? { note: String(b.note).slice(0, 200) } : {}),
        };
        await saveConfig(cfg);
        return send(res, 200, { ok: true });
      }

      // DELETE /api/shops?store=...  → hide the store from shophop (the CLI has no sign-out command).
      // POST /api/shops/restore {store} → show it again. Signing in again (PUT) also restores it.
      if (url.pathname === "/api/shops" && req.method === "DELETE") {
        const store = normalize(url.searchParams.get("store") || "");
        if (!STORE_RE.test(store)) return send(res, 400, { error: "Bad store" });
        const cfg = await loadConfig();
        for (const [a, c] of Object.entries(cfg)) if (normalize(c.store) === store) delete cfg[a];
        cfg[`~removed-${store.split(".")[0]}`] = { store, hidden: true, removedAt: new Date().toISOString() };
        await saveConfig(cfg);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === "/api/shops/restore" && req.method === "POST") {
        const store = normalize((await body(req)).store || "");
        const cfg = await loadConfig();
        for (const [a, c] of Object.entries(cfg)) if (normalize(c.store) === store && c.hidden) delete cfg[a];
        await saveConfig(cfg);
        return send(res, 200, { ok: true });
      }

      // POST /api/auth  {store, scopes[]}
      if (url.pathname === "/api/auth" && req.method === "POST") {
        const b = await body(req);
        const store = normalize(b.store || "");
        const scopes = [...new Set((b.scopes || []).map((s) => String(s).trim()).filter(Boolean))];
        if (!STORE_RE.test(store)) return send(res, 400, { error: "Store must look like name.myshopify.com" });
        if (!scopes.length || !scopes.every((s) => SCOPE_RE.test(s))) return send(res, 400, { error: "Pick at least one valid scope" });
        const job = startAuth(store, scopes);
        return send(res, 200, { id: job.id });
      }

      // GET /api/auth/<id>/events  (Server-Sent Events)
      const m = url.pathname.match(/^\/api\/auth\/([a-f0-9]+)\/events$/);
      if (m && req.method === "GET") {
        const job = jobs.get(m[1]);
        if (!job) return send(res, 404, { error: "no such job" });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        const write = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
        for (const l of job.lines) write({ type: "line", data: l });
        if (job.done) { write({ type: "done", data: { code: job.code } }); return res.end(); }
        job.listeners.add(write);
        req.on("close", () => job.listeners.delete(write));
        return;
      }

      // POST /api/auth/<id>/cancel
      const c = url.pathname.match(/^\/api\/auth\/([a-f0-9]+)\/cancel$/);
      if (c && req.method === "POST") { jobs.get(c[1])?.kill?.(); return send(res, 200, { ok: true }); }

      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });

  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/?t=${token}`;
  return { url, server };
}

export function openInBrowser(url) {
  // Windows: the standard URL handler, started directly (no cmd.exe, so the link isn't re-parsed).
  if (process.platform === "win32") return execFile("rundll32", ["url.dll,FileProtocolHandler", url], () => {});
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [url], () => {});
}
