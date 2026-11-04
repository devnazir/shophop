import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeEnv, connect, session, FIXTURES } from "./helpers.js";
import { parseCompaniesJsonl } from "../src/features/copy-companies.js";

const SRC = "src-fake.myshopify.com", DST = "dst-fake.myshopify.com", RO = "ro-fake.myshopify.com";
const exportFile = join(FIXTURES, "companies.jsonl");
const terms = [{ id: "gid://shopify/PaymentTermsTemplate/4", name: "Net 30", paymentTermsType: "NET", dueInDays: 30 }];

function env() {
  return makeEnv({
    sessions: [session(SRC), session(DST), session(RO)],
    config: { a: { store: SRC }, b: { store: DST, writable: true }, ro: { store: RO } },
    stores: {
      [DST]: { companies: [{ id: "gid://shopify/Company/900", name: "Initech" }], customers: [{ id: "gid://shopify/Customer/77", email: "bob@acme.test" }], terms, nextId: 1000 },
      [RO]: { companies: [], customers: [], terms, nextId: 1000 },
    },
  });
}

test("parse rebuilds companies, contacts, locations and roles from bulk JSONL", async () => {
  const cs = await parseCompaniesJsonl(exportFile);
  assert.deepEqual(cs.map((c) => c.name), ["Acme Corp", "Globex", "Initech"]);
  const acme = cs[0];
  assert.equal(acme.contacts.length, 2);
  assert.equal(acme.locations.length, 2);
  assert.deepEqual(acme.locations[0].roles.map((r) => r.role), ["Location admin", "Ordering only"]);
});

test("dry run writes nothing and explains the plan", async () => {
  const e = env();
  const s = await connect(e.env);
  try {
    const r = await s.call("shop_copy_companies", { from: "a", to: "b", exportFile });
    assert.equal(r.isError, false);
    const sum = r.json.summary;
    assert.deepEqual(sum.companies, { total: 3, create: 2, resume: 0, skip: 1 });
    assert.match(sum.skipped[0], /Initech.*already exists/);
    assert.deepEqual(sum.contacts, { assignExisting: 1, createNew: 2 });
    assert.equal(sum.locations, 3);
    assert.ok(sum.warnings.some((w) => /Net 90/.test(w)), "unmatched payment terms are flagged");
    assert.equal(e.state().calls.filter((c) => c.mutation).length, 0);
  } finally { await s.close(); }
});

test("apply copies in batches, maps everything, and a re-run creates nothing new", async () => {
  const e = env();
  const s = await connect(e.env);
  try {
    const first = await s.call("shop_copy_companies", { from: "a", to: "b", exportFile, apply: true, batch: 1 });
    assert.equal(first.json.results.length, 1);
    assert.equal(first.json.results[0].ok, true);
    assert.equal(first.json.remaining, 1);
    const second = await s.call("shop_copy_companies", { from: "a", to: "b", exportFile, apply: true, batch: 1 });
    assert.equal(second.json.results[0].name, "Globex");
    assert.equal(second.json.remaining, 0);

    const dst = e.state().stores[DST];
    const acme = dst.companies.find((c) => c.name === "Acme Corp");
    assert.equal(acme.externalId, "ACME-1");
    assert.equal(acme.locations.length, 2);
    const hq = acme.locations.find((l) => l.name === "Acme HQ");
    assert.equal(hq.billingSameAsShipping, true);
    assert.equal(hq.taxExempt, true);
    assert.equal(hq.buyerExperienceConfiguration.paymentTermsTemplateId, terms[0].id);
    const wh = acme.locations.find((l) => l.name === "Acme Warehouse");
    assert.equal(wh.billingAddress.address1, "1 Main St");
    assert.equal(wh.shippingAddress.address1, "9 Dock Rd");
    assert.equal(acme.contacts.length, 2);
    assert.ok(acme.contacts.some((c) => c.customerId === "gid://shopify/Customer/77"), "existing customer reused by email");
    assert.ok(acme.mainContact);
    assert.equal(acme.roleAssignments.length, 3);

    const companiesBefore = dst.companies.length;
    const mutationsBefore = e.state().calls.filter((c) => c.mutation).length;
    const rerun = await s.call("shop_copy_companies", { from: "a", to: "b", exportFile, apply: true });
    assert.equal(rerun.json.results.length, 0);
    assert.equal(e.state().stores[DST].companies.length, companiesBefore);
    assert.equal(e.state().calls.filter((c) => c.mutation).length, mutationsBefore);
    assert.ok(e.audit().every((a) => a.source === "copy-companies"));
  } finally { await s.close(); }
});

test("a failed company is reported and resumed on the next run", async () => {
  const e = env();
  e.setState((st) => { st.stores[DST].failCompany = "Globex"; });
  const s = await connect(e.env);
  try {
    const r = await s.call("shop_copy_companies", { from: "a", to: "b", exportFile, apply: true });
    const globex = r.json.results.find((x) => x.name === "Globex");
    assert.equal(globex.ok, false);
    assert.match(globex.error, /Simulated failure/);
    assert.deepEqual(r.json.failed, ["Globex"]);
    assert.doesNotMatch(r.json.next, /^Done/, "never says Done when something failed");
    assert.match(r.json.next, /1 company failed: Globex/);
    e.setState((st) => { delete st.stores[DST].failCompany; });
    const again = await s.call("shop_copy_companies", { from: "a", to: "b", exportFile, apply: true });
    assert.deepEqual(again.json.results.map((x) => [x.name, x.ok]), [["Globex", true]]);
  } finally { await s.close(); }
});

test("apply on a read-only target is refused before anything is sent", async () => {
  const e = env();
  const s = await connect(e.env);
  try {
    const r = await s.call("shop_copy_companies", { from: "a", to: "ro", exportFile, apply: true });
    assert.equal(r.isError, true);
    assert.match(r.all, /doesn't allow edits/);
    assert.equal(e.state().calls.filter((c) => c.mutation).length, 0);
  } finally { await s.close(); }
});

test("a failing company goes to the back of the queue instead of blocking the rest", async () => {
  const e = env();
  e.setState((st) => { st.stores[DST].failCompany = "Acme Corp"; });
  const s = await connect(e.env);
  try {
    const first = await s.call("shop_copy_companies", { from: "a", to: "b", exportFile, apply: true, batch: 1 });
    assert.deepEqual(first.json.results.map((x) => [x.name, x.ok]), [["Acme Corp", false]]);
    const second = await s.call("shop_copy_companies", { from: "a", to: "b", exportFile, apply: true, batch: 1 });
    assert.deepEqual(second.json.results.map((x) => [x.name, x.ok]), [["Globex", true]], "Globex goes first next time");
  } finally { await s.close(); }
});

test("two companies with the same new contact email share one customer", async () => {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const file = join(mkdtempSync(join(tmpdir(), "shophop-dup-")), "export.jsonl");
  const rows = [
    { id: "gid://shopify/Company/1", name: "One" },
    { id: "gid://shopify/CompanyContact/1", isMainContact: true, customer: { email: "jane@x.test", firstName: "Jane" }, __parentId: "gid://shopify/Company/1" },
    { id: "gid://shopify/CompanyLocation/1", name: "One HQ", __parentId: "gid://shopify/Company/1" },
    { id: "gid://shopify/Company/2", name: "Two" },
    { id: "gid://shopify/CompanyContact/2", isMainContact: true, customer: { email: "jane@x.test", firstName: "Jane" }, __parentId: "gid://shopify/Company/2" },
    { id: "gid://shopify/CompanyLocation/2", name: "Two HQ", __parentId: "gid://shopify/Company/2" },
  ];
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const e = env();
  const s = await connect(e.env);
  try {
    const r = await s.call("shop_copy_companies", { from: "a", to: "b", exportFile: file, apply: true });
    assert.deepEqual(r.json.results.map((x) => [x.name, x.ok]), [["One", true], ["Two", true]]);
    const dst = e.state().stores[DST];
    assert.equal(dst.customers.filter((c) => c.email === "jane@x.test").length, 1, "one customer, used by both companies");
  } finally { await s.close(); }
});

test("resolving source and target together starts only one store lookup", async () => {
  const e = env();
  const s = await connect(e.env);
  try {
    await s.call("shop_copy_companies", { from: "a", to: "b", exportFile });
    assert.equal(e.state().calls.filter((c) => c.cmd === "store auth list").length, 1);
    assert.ok(!e.state().calls.some((c) => c.warning), "variables never go on the command line");
  } finally { await s.close(); }
});
