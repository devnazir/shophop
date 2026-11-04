import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeEnv, connect, session, FIXTURES } from "./helpers.js";

const DEV = "dev-fake.myshopify.com", PROD = "prod-fake.myshopify.com", DEV2 = "dev2-fake.myshopify.com";
const exportFile = join(FIXTURES, "companies.jsonl");
const e = makeEnv({
  sessions: [session(DEV), session(PROD), session(DEV2)],
  config: { dev: { store: DEV }, prod: { store: PROD, writable: true, production: true }, dev2: { store: DEV2, writable: true } },
  stores: { [PROD]: { companies: [], customers: [], terms: [], nextId: 1000 }, [DEV2]: { companies: [], customers: [], terms: [], nextId: 1000 } },
});
process.env.SHOPHOP_APPROVALS = e.env.SHOPHOP_APPROVALS;
const { decide, listApprovals } = await import("../src/core/approvals.js");
const s = await connect(e.env);
after(() => s.close());
const mutations = () => e.state().calls.filter((c) => c.mutation).length;

test("copying into a non-production store needs no approval", async () => {
  const r = await s.call("shop_copy_companies", { from: "dev", to: "dev2", exportFile });
  assert.equal(r.json.productionApproval, undefined);
});

test("dev → prod: dry run files an approval request, apply is refused and sends nothing", async () => {
  const dry = await s.call("shop_copy_companies", { from: "dev", to: "prod", exportFile });
  assert.equal(dry.json.productionApproval.state, "needed");
  assert.match(dry.all, /PRODUCTION store: prod/);
  const id = dry.json.productionApproval.requestId;
  const [req] = (await listApprovals()).filter((a) => a.id === id);
  assert.equal(req.state, "pending");
  assert.equal(req.fromProduction, false);

  const before = mutations();
  const apply = await s.call("shop_copy_companies", { from: "dev", to: "prod", exportFile, apply: true });
  assert.equal(apply.isError, true);
  assert.match(apply.all, /needs the user's approval/);
  assert.equal(mutations(), before);
});

test("approval needs the exact target domain typed, then the copy runs", async () => {
  const [req] = (await listApprovals()).filter((a) => a.to === "prod");
  await assert.rejects(decide(req.id, "approve", "prod"), /Type prod-fake\.myshopify\.com/);
  await decide(req.id, "approve", PROD);
  const apply = await s.call("shop_copy_companies", { from: "dev", to: "prod", exportFile, apply: true });
  assert.equal(apply.isError, false);
  assert.ok(apply.json.results.every((x) => x.ok));
  assert.equal(e.state().stores[PROD].companies.length, 3);
});

test("an approval covers only that copy: a different selection needs a new one", async () => {
  const r = await s.call("shop_copy_companies", { from: "dev", to: "prod", exportFile, only: ["Globex"], apply: true });
  assert.equal(r.isError, true);
  assert.match(r.all, /needs the user's approval/);
});

test("a rejected request stays blocked", async () => {
  const dry = await s.call("shop_copy_companies", { from: "dev", to: "prod", exportFile, only: ["Acme Corp"] });
  await decide(dry.json.productionApproval.requestId, "reject");
  const r = await s.call("shop_copy_companies", { from: "dev", to: "prod", exportFile, only: ["Acme Corp"], apply: true });
  assert.match(r.all, /rejected/);
});
