import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { makeEnv, connect, session } from "./helpers.js";

const DEV = "dev-fake.myshopify.com", PROD = "prod-fake.myshopify.com", DEL = "del-fake.myshopify.com";
const env = makeEnv({
  sessions: [session(DEV), session(PROD), session(DEL)],
  config: {
    dev: { store: DEV, writable: true },
    prod: { store: PROD, writable: false, production: true },
    del: { store: DEL, writable: true, allowDestructive: true },
  },
});
const srv = await connect(env.env);
after(() => srv.close());

test("list_shops shows flags and the CLI version", async () => {
  const r = await srv.call("list_shops");
  const byAlias = Object.fromEntries(r.json.shops.map((s) => [s.alias, s]));
  assert.equal(byAlias.prod.production, true);
  assert.equal(byAlias.dev.allowDestructive, false);
  assert.equal(byAlias.del.allowDestructive, true);
  assert.equal(r.json.shopifyCli.version, "4.9.4");
  assert.equal(r.json.shopifyCli.warning, undefined);
});

test("queries about a production store start with a PRODUCTION banner", async () => {
  const r = await srv.call("shop_query", { shop: "prod", query: "{ shop { name } }" });
  assert.match(r.texts[0], /PRODUCTION store: prod/);
  const d = await srv.call("shop_query", { shop: "dev", query: "{ shop { name } }" });
  assert.doesNotMatch(d.all, /PRODUCTION/);
});

test("shop_query rejects mutations", async () => {
  const r = await srv.call("shop_query", { shop: "dev", query: "mutation { tagsAdd(id: \"1\", tags: [\"a\"]) { node { id } } }" });
  assert.equal(r.isError, true);
});

test("mutation gates: read-only refused, delete needs allowDestructive, all audited", async () => {
  const before = env.state().calls.filter((c) => c.mutation).length;
  const ro = await srv.call("shop_mutation", { shop: "prod", mutation: 'mutation { tagsAdd(id: "1", tags: ["a"]) { userErrors { message } } }' });
  assert.equal(ro.isError, true); assert.match(ro.all, /read-only/); assert.match(ro.all, /PRODUCTION/);
  const del = await srv.call("shop_mutation", { shop: "dev", mutation: 'mutation { productDelete(input: {id: "1"}) { deletedProductId userErrors { message } } }' });
  assert.equal(del.isError, true); assert.match(del.all, /destructive/);
  assert.equal(env.state().calls.filter((c) => c.mutation).length, before, "refused mutations must never reach the CLI");

  const ok = await srv.call("shop_mutation", { shop: "dev", mutation: 'mutation { tagsAdd(id: "1", tags: ["a"]) { userErrors { message } } }' });
  assert.equal(ok.isError, false);
  const delOk = await srv.call("shop_mutation", { shop: "del", mutation: 'mutation { productDelete(input: {id: "1"}) { userErrors { message } } }' });
  assert.equal(delOk.isError, false);

  const outcomes = env.audit().map((e) => `${e.shop}:${e.outcome}`);
  assert.deepEqual(outcomes.slice(-4), ["prod:refused", "dev:refused", "dev:sent", "del:sent"]);
});

test("bulk export: start, poll, download once", async () => {
  const body = '{"id":"gid://shopify/Product/1"}\n{"id":"gid://shopify/Product/2"}\n';
  const files = http.createServer((_, res) => res.end(body));
  await new Promise((r) => files.listen(0, "127.0.0.1", r));
  env.setState((s) => { s.bulkUrl = `http://127.0.0.1:${files.address().port}/r.jsonl`; s.bulkRunningPolls = 2; s.bulkPolls = 0; });
  try {
    const start = await srv.call("shop_bulk_export", { shop: "dev", query: "{ products { edges { node { id } } } }", name: "p", waitSeconds: 0 });
    assert.equal(start.json.state, "RUNNING");
    const done = await srv.call("shop_bulk_status", { shop: "dev", operationId: start.json.operationId, name: "p", waitSeconds: 10 });
    assert.equal(done.json.state, "COMPLETED");
    assert.equal(done.json.lines, 2);
    const again = await srv.call("shop_bulk_status", { shop: "dev", operationId: start.json.operationId, name: "p", waitSeconds: 0 });
    assert.equal(again.json.note, "Already downloaded.");
  } finally { files.close(); }
});

test("an untested Shopify CLI version produces a warning", async () => {
  const old = makeEnv({ version: "3.80.1", sessions: [session(DEV)] });
  const s = await connect(old.env);
  try {
    const r = await s.call("list_shops");
    assert.match(r.json.shopifyCli.warning, /untested/);
  } finally { await s.close(); }
});
