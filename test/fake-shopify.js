#!/usr/bin/env node
// Stand-in for the Shopify CLI used by the tests. Never touches the network.
// State lives in the JSON file named by FAKE_SHOPIFY_STATE and is updated in place, so tests can inspect it.
import { readFileSync, writeFileSync, appendFileSync, renameSync } from "node:fs";

const STATE = process.env.FAKE_SHOPIFY_STATE;
const state = JSON.parse(readFileSync(STATE, "utf8"));
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
// Reads can run in parallel, so only state-changing calls rewrite the state file (atomically).
// Every call is appended to a separate log, which is safe for concurrent writers.
let dirty = false;
const save = () => { if (!dirty) return; writeFileSync(`${STATE}.${process.pid}`, JSON.stringify(state, null, 2)); renameSync(`${STATE}.${process.pid}`, STATE); };
const out = (o) => { save(); process.stdout.write(JSON.stringify(o)); process.exit(0); };
const err = (message, details) => { save(); process.stdout.write(JSON.stringify({ error: { type: "abort", message, ...(details && { details }) } })); process.exit(1); };

const store = flag("-s");
const query = flag("--query-file") ? readFileSync(flag("--query-file"), "utf8") : flag("-q") || "";
const vars = flag("--variable-file") ? JSON.parse(readFileSync(flag("--variable-file"), "utf8")) : flag("--variables") ? JSON.parse(flag("--variables")) : {};
if (flag("--variables")) appendFileSync(`${STATE}.calls`, JSON.stringify({ warning: "variables passed on the command line" }) + "\n");
appendFileSync(`${STATE}.calls`, JSON.stringify({ cmd: args.slice(0, 3).join(" "), store, mutation: args.includes("--allow-mutations"), op: (query.match(/\b(\w+)\s*\(/) || [])[1] }) + "\n");

if (args[0] === "version") { process.stdout.write(`${state.version || "4.9.4"}\n`); process.exit(0); }
if (args.join(" ").startsWith("store auth list")) out({ sessions: state.sessions || [] });

const shop = (state.stores ||= {})[store] ||= { companies: [], customers: [], terms: [], nextId: 100 };
const gid = (type) => `gid://shopify/${type}/${shop.nextId++}`;

// ---- bulk ----
if (args.join(" ").startsWith("store bulk execute")) {
  if (args.includes("--allow-mutations")) err("bulk mutations not expected in tests");
  out({ storeDomain: store, apiVersion: "2026-10", status: "success",
    operation: { gid: "gid://shopify/BulkOperation/1", type: "QUERY", status: "CREATED", errorCode: null, createdAt: "2026-11-04T00:00:00Z", completedAt: null, objectCount: "0", url: null, partialDataUrl: null } });
}
if (args.join(" ").startsWith("store bulk status")) {
  dirty = true;
  state.bulkPolls = (state.bulkPolls || 0) + 1;
  const done = state.bulkPolls > (state.bulkRunningPolls ?? 0);
  out({ storeDomain: store, apiVersion: "2026-10", operationGid: flag("--id"),
    operation: { gid: flag("--id"), type: "QUERY", status: done ? "COMPLETED" : "RUNNING", errorCode: null, createdAt: "2026-11-04T00:00:00Z", completedAt: null,
      objectCount: "3", url: done ? state.bulkUrl : null, partialDataUrl: null } });
}

if (!args.join(" ").startsWith("store execute")) err(`unexpected command: ${args.join(" ")}`);

// ---- queries ----
if (/^\s*(query|\{)/.test(query) && !/^\s*mutation/.test(query)) {
  if (/__schema|__type/.test(query)) out({ __type: null });
  if (/companies\(first: 250/.test(query)) out({ companies: { nodes: shop.companies.map(({ id, name, externalId }) => ({ id, name, externalId })), pageInfo: { hasNextPage: false, endCursor: null } } });
  if (/paymentTermsTemplates/.test(query)) out({ paymentTermsTemplates: shop.terms });
  if (/customers\(first: 1/.test(query)) {
    const res = {};
    for (const [k, v] of Object.entries(vars)) {
      const email = v.match(/email:"([^"]+)"/)[1];
      res[k.replace("q", "c")] = { nodes: shop.customers.filter((c) => c.email === email) };
    }
    out(res);
  }
  if (/shop\s*\{/.test(query)) out({ shop: { name: store } });
  out({});
}

// ---- mutations ----
if (!args.includes("--allow-mutations")) err("Mutations are disabled by default for shopify store execute.");
dirty = true;
const field = (query.match(/\{\s*(\w+)\s*\(/) || [])[1];
const company = (id) => shop.companies.find((c) => c.id === id);
const roles = () => [{ id: gid("CompanyContactRole"), name: "Location admin" }, { id: gid("CompanyContactRole"), name: "Ordering only" }];

switch (field) {
  case "companyCreate": {
    if (shop.failCompany && vars.input.company.name === shop.failCompany) out({ companyCreate: { company: null, userErrors: [{ field: ["name"], message: "Simulated failure" }] } });
    const c = { id: gid("Company"), name: vars.input.company.name, externalId: vars.input.company.externalId, locations: [], contacts: [], mainContact: null, contactRoles: roles(), roleAssignments: [] };
    if (vars.input.companyLocation) c.locations.push({ id: gid("CompanyLocation"), ...vars.input.companyLocation });
    shop.companies.push(c);
    out({ companyCreate: { company: { id: c.id, locations: { nodes: c.locations.map((l) => ({ id: l.id })) }, contactRoles: { nodes: c.contactRoles } }, userErrors: [] } });
  }
  case "companyLocationCreate": {
    const l = { id: gid("CompanyLocation"), ...vars.input };
    company(vars.companyId).locations.push(l);
    out({ companyLocationCreate: { companyLocation: { id: l.id }, userErrors: [] } });
  }
  case "companyAssignCustomerAsContact": {
    const ct = { id: gid("CompanyContact"), customerId: vars.customerId };
    company(vars.companyId).contacts.push(ct);
    out({ companyAssignCustomerAsContact: { companyContact: { id: ct.id }, userErrors: [] } });
  }
  case "companyContactCreate": {
    if (vars.input.email && shop.customers.some((c) => c.email === vars.input.email)) {
      out({ companyContactCreate: { companyContact: null, userErrors: [{ field: ["input", "email"], message: "Email has already been taken" }] } });
    }
    const cust = { id: gid("Customer"), email: vars.input.email };
    shop.customers.push(cust);
    const ct = { id: gid("CompanyContact"), customerId: cust.id, title: vars.input.title };
    company(vars.companyId).contacts.push(ct);
    out({ companyContactCreate: { companyContact: { id: ct.id, customer: { id: cust.id } }, userErrors: [] } });
  }
  case "companyAssignMainContact":
    company(vars.companyId).mainContact = vars.companyContactId;
    out({ companyAssignMainContact: { company: { id: vars.companyId }, userErrors: [] } });
  case "companyContactAssignRoles": {
    const c = shop.companies.find((x) => (x.contacts || []).some((ct) => ct.id === vars.companyContactId));
    c.roleAssignments.push(...vars.rolesToAssign.map((r) => ({ contact: vars.companyContactId, ...r })));
    out({ companyContactAssignRoles: { roleAssignments: vars.rolesToAssign.map(() => ({ id: gid("CompanyContactRoleAssignment") })), userErrors: [] } });
  }
  default:
    out({ [field || "unknown"]: { userErrors: [] } });
}
