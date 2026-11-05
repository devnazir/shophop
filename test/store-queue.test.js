import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, connect, session } from "./helpers.js";

// The Shopify CLI can lose a store's sign-in when two commands for that store refresh its token at once,
// so shophop runs commands for the same store one at a time (different stores still in parallel).
const A = "a-fake.myshopify.com", B = "b-fake.myshopify.com";
const e = makeEnv({ sessions: [session(A), session(B)], config: { a: { store: A }, b: { store: B } }, delayMs: 400 });
const s = await connect(e.env);
after(() => s.close());

const overlaps = (x, y) => x.t0 < y.t1 && y.t0 < x.t1;
const executes = (store) => e.state().calls.filter((c) => c.cmd.startsWith("store execute") && c.store === store);

test("parallel calls for the same store never overlap", async () => {
  await s.call("list_shops"); // warm the store list so only the queries below hit the CLI
  await Promise.all([1, 2, 3].map(() => s.call("shop_query", { shop: "a", query: "{ shop { name } }" })));
  const runs = executes(A);
  assert.equal(runs.length, 3);
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) assert.ok(!overlaps(runs[i], runs[j]), "same-store commands ran at the same time");
});

test("different stores still run in parallel", async () => {
  await Promise.all([s.call("shop_query", { shop: "a", query: "{ shop { name } }" }), s.call("shop_query", { shop: "b", query: "{ shop { name } }" })]);
  const a = executes(A).at(-1), b = executes(B).at(-1);
  assert.ok(overlaps(a, b), "commands for different stores should overlap");
});
