import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeEnv, session } from "./helpers.js";

const DEV = "dev-fake.myshopify.com";
const e = makeEnv({ sessions: [session(DEV)], config: { dev: { store: DEV, writable: true } } });
Object.assign(process.env, e.env);
const { startShopManager } = await import("../src/shop-manager/server.js");
const { url, server } = await startShopManager({ port: 0 });
after(() => server.close());
const base = url.split("/?")[0], token = url.split("t=")[1];
const call = (path, opts = {}) => fetch(base + path, { ...opts, headers: { "x-token": token, "content-type": "application/json" } }).then(async (r) => ({ status: r.status, json: await r.json() }));
const config = () => JSON.parse(readFileSync(e.env.SHOPHOP_CONFIG, "utf8")).shops;

test("requests without the token are refused", async () => {
  const r = await fetch(`${base}/api/shops`);
  assert.equal(r.status, 403);
});

test("remove hides the store; restore brings it back", async () => {
  assert.equal((await call(`/api/shops?store=${DEV}`, { method: "DELETE" })).status, 200);
  let r = await call("/api/shops");
  assert.equal(r.json.shops.length, 0);
  assert.deepEqual(r.json.removed, [DEV]);
  assert.ok(Object.values(config()).every((c) => c.hidden), "settings cleared, only the hidden marker left");

  await call("/api/shops/restore", { method: "POST", body: JSON.stringify({ store: DEV }) });
  r = await call("/api/shops");
  assert.deepEqual(r.json.shops.map((s) => s.alias), ["dev-fake"]);
  assert.equal(r.json.shops[0].writable, false, "restored stores come back read-only");
});

test("saving settings maps access levels and also un-hides a removed store", async () => {
  await call(`/api/shops?store=${DEV}`, { method: "DELETE" });
  const r = await call("/api/shops", { method: "PUT", body: JSON.stringify({ store: DEV, alias: "dev", writable: true, allowDestructive: true, production: true }) });
  assert.equal(r.status, 200);
  assert.deepEqual(config(), { dev: { store: DEV, writable: true, allowDestructive: true, production: true } });
  const s = (await call("/api/shops")).json.shops[0];
  assert.equal(s.allowDestructive, true);
});

test("destructive needs writable, and bad input is rejected", async () => {
  await call("/api/shops", { method: "PUT", body: JSON.stringify({ store: DEV, alias: "dev", writable: false, allowDestructive: true }) });
  assert.equal(config().dev.allowDestructive, undefined);
  assert.equal((await call("/api/shops", { method: "PUT", body: JSON.stringify({ store: "evil.com", alias: "x" }) })).status, 400);
  assert.equal((await call("/api/shops", { method: "PUT", body: JSON.stringify({ store: DEV, alias: "Bad Name!" }) })).status, 400);
});
