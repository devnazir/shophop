import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, connect, session } from "./helpers.js";

const KEEP = "keep-fake.myshopify.com", GONE = "gone-fake.myshopify.com";
const e = makeEnv({
  sessions: [session(KEEP), session(GONE)],
  config: { keep: { store: KEEP }, "~removed-gone-fake": { store: GONE, hidden: true } },
});
const s = await connect(e.env);
after(() => s.close());

test("a removed store is hidden even though its CLI sign-in still exists", async () => {
  const r = await s.call("list_shops");
  assert.deepEqual(r.json.shops.map((x) => x.alias), ["keep"]);
  assert.deepEqual(r.json.removed, [GONE]);
});

test("tools refuse a removed store and point to the Shop Manager", async () => {
  const r = await s.call("shop_query", { shop: GONE, query: "{ shop { name } }" });
  assert.equal(r.isError, true);
  assert.match(r.all, /Unknown shop/);
  assert.equal(e.state().calls.filter((c) => c.cmd === "store execute").length, 0);
});

test("a signed-in store never borrows another store's short name", async () => {
  const { makeEnv, connect, session } = await import("./helpers.js");
  const e2 = makeEnv({
    sessions: [session("acme.myshopify.com"), session("acme-staging.myshopify.com")],
    config: { acme: { store: "acme-staging.myshopify.com", writable: true } },
  });
  const s2 = await connect(e2.env);
  try {
    const shops = (await s2.call("list_shops")).json.shops;
    const byStore = Object.fromEntries(shops.map((x) => [x.store, x.alias]));
    assert.equal(byStore["acme-staging.myshopify.com"], "acme");
    assert.equal(byStore["acme.myshopify.com"], "acme.myshopify.com", "falls back to the full domain");
    const r = await s2.call("shop_query", { shop: "acme.myshopify.com", query: "{ shop { name } }" });
    assert.equal(r.json.store, "acme.myshopify.com", "a full domain always means that exact store");
  } finally { await s2.close(); }
});
