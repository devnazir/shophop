// Copy B2B companies (with locations, contacts, main contact and roles) from one store to another.
// Dry run by default. Apply runs in batches and records an ID map, so re-runs resume and never duplicate.
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { execute } from "../shopify/cli.js";
import { audit } from "../core/audit.js";
import { checkWrite } from "../core/guards.js";

const ADDRESS = "address1 address2 city zip recipient firstName lastName phone zoneCode countryCode";

// 4 connections; roleAssignments is the deepest (companies > locations > roleAssignments).
export const COMPANIES_BULK_QUERY = `{
  companies {
    edges { node {
      id name externalId note customerSince
      contacts { edges { node { id title isMainContact locale customer { email firstName lastName phone } } } }
      locations { edges { node {
        id name externalId phone locale note
        billingAddress { ${ADDRESS} }
        shippingAddress { ${ADDRESS} }
        taxSettings { taxExempt taxExemptions taxRegistrationId }
        buyerExperienceConfiguration { checkoutToDraft editableShippingAddress paymentTermsTemplate { name paymentTermsType dueInDays } }
        roleAssignments { edges { node { id companyContact { id } role { name } } } }
      } } }
    } }
  }
}`;

const kind = (gid) => (gid || "").split("/")[3];

// Rebuild nested companies from bulk JSONL (children point to parents via __parentId).
export async function parseCompaniesJsonl(file) {
  const companies = new Map(), contacts = new Map(), locations = new Map(), pendingRoles = [];
  const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    switch (kind(row.id)) {
      case "Company": companies.set(row.id, { ...row, contacts: [], locations: [] }); break;
      case "CompanyContact": contacts.set(row.id, row); break;
      case "CompanyLocation": locations.set(row.id, { ...row, roles: [] }); break;
      case "CompanyContactRoleAssignment": pendingRoles.push(row); break;
    }
  }
  for (const c of contacts.values()) companies.get(c.__parentId)?.contacts.push(c);
  for (const l of locations.values()) companies.get(l.__parentId)?.locations.push(l);
  for (const r of pendingRoles) locations.get(r.__parentId)?.roles.push({ contactId: r.companyContact?.id, role: r.role?.name });
  return [...companies.values()];
}

// ---------- target lookups (read-only) ----------

async function q(shop, query, variables) {
  const r = await execute(shop.store, query, { variables });
  if (!r.ok) throw Object.assign(new Error(r.error?.message || "Query failed"), { details: r.error });
  return r.data;
}

async function targetCompanies(shop) {
  const out = [];
  let after = null;
  for (let page = 0; page < 200; page++) {
    const d = await q(shop, `query($after: String) { companies(first: 250, after: $after) { nodes { id name externalId } pageInfo { hasNextPage endCursor } } }`, { after });
    out.push(...d.companies.nodes);
    if (!d.companies.pageInfo.hasNextPage) break;
    after = d.companies.pageInfo.endCursor;
  }
  return out;
}

// Look up customers by email, 20 per request using aliases.
async function customersByEmail(shop, emails) {
  const found = new Map();
  const list = [...new Set(emails.filter(Boolean).map((e) => e.toLowerCase()))];
  for (let i = 0; i < list.length; i += 20) {
    const chunk = list.slice(i, i + 20);
    const vars = {}, parts = [], defs = [];
    chunk.forEach((email, j) => {
      vars[`q${j}`] = `email:"${email.replace(/"/g, "")}"`;
      defs.push(`$q${j}: String!`);
      parts.push(`c${j}: customers(first: 1, query: $q${j}) { nodes { id email } }`);
    });
    const d = await q(shop, `query(${defs.join(", ")}) { ${parts.join("\n")} }`, vars);
    chunk.forEach((email, j) => {
      const hit = d[`c${j}`].nodes.find((n) => (n.email || "").toLowerCase() === email);
      if (hit) found.set(email, hit.id);
    });
  }
  return found;
}

async function paymentTerms(shop) {
  const d = await q(shop, `{ paymentTermsTemplates { id name paymentTermsType dueInDays } }`);
  return d.paymentTermsTemplates;
}

// ---------- ID map ----------

export function idmapPath(dataDir, from, to) {
  return join(dataDir, to.alias, `idmap-companies-from-${from.alias}.json`);
}
async function loadIdmap(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return { companies: {} }; }
}
async function saveIdmap(file, map) {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(map, null, 2));
  await rename(`${file}.tmp`, file);
}

// ---------- plan ----------

const addr = (a) => a && Object.fromEntries(ADDRESS.split(" ").filter((k) => a[k] != null && a[k] !== "").map((k) => [k, a[k]]));
const sameAddr = (a, b) => JSON.stringify(addr(a) || {}) === JSON.stringify(addr(b) || {});

function locationInput(loc, terms, warnings, companyName) {
  const input = { name: loc.name };
  for (const k of ["externalId", "phone", "locale", "note"]) if (loc[k]) input[k] = loc[k];
  if (loc.shippingAddress) input.shippingAddress = addr(loc.shippingAddress);
  if (loc.billingAddress && loc.shippingAddress && sameAddr(loc.billingAddress, loc.shippingAddress)) input.billingSameAsShipping = true;
  else if (loc.billingAddress) input.billingAddress = addr(loc.billingAddress);
  const tax = loc.taxSettings;
  if (tax) {
    if (tax.taxExempt) input.taxExempt = true;
    if (tax.taxExemptions?.length) input.taxExemptions = tax.taxExemptions;
    if (tax.taxRegistrationId) input.taxRegistrationId = tax.taxRegistrationId;
  }
  const bx = loc.buyerExperienceConfiguration;
  if (bx) {
    input.buyerExperienceConfiguration = { checkoutToDraft: bx.checkoutToDraft, editableShippingAddress: bx.editableShippingAddress };
    const pt = bx.paymentTermsTemplate;
    if (pt) {
      const match = terms.find((t) => t.paymentTermsType === pt.paymentTermsType && (t.dueInDays ?? null) === (pt.dueInDays ?? null));
      if (match) input.buyerExperienceConfiguration.paymentTermsTemplateId = match.id;
      else warnings.push(`${companyName} / ${loc.name}: no matching payment terms "${pt.name}" in target; left unset`);
    }
  }
  return input;
}

export async function planCompanies({ from, to, companies, dataDir, only }) {
  const idmapFile = idmapPath(dataDir, from, to);
  const idmap = await loadIdmap(idmapFile);
  const selected = only?.length ? companies.filter((c) => only.some((n) => n.toLowerCase() === c.name.toLowerCase())) : companies;
  const [existing, terms, customers] = await Promise.all([
    targetCompanies(to),
    paymentTerms(to),
    customersByEmail(to, selected.flatMap((c) => c.contacts.map((ct) => ct.customer?.email))),
  ]);
  const byExt = new Map(existing.filter((c) => c.externalId).map((c) => [c.externalId, c]));
  const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c]));

  const warnings = [];
  const items = selected.map((c) => {
    const mapped = idmap.companies[c.id];
    if (mapped?.done) return { source: c.id, name: c.name, action: "skip", reason: "already copied (in ID map)", targetId: mapped.targetId };
    const clash = !mapped && ((c.externalId && byExt.get(c.externalId)) || byName.get(c.name.toLowerCase()));
    if (clash) return { source: c.id, name: c.name, action: "skip", reason: `a company with this ${c.externalId && byExt.get(c.externalId) ? "externalId" : "name"} already exists in ${to.alias} (${clash.id}); not merged` };
    if (!c.locations.length) warnings.push(`${c.name}: has no locations in the source`);
    const contacts = c.contacts.map((ct) => {
      const email = ct.customer?.email?.toLowerCase();
      if (!email) warnings.push(`${c.name}: contact ${ct.id} has no email; it will be created without one`);
      return {
        source: ct.id, email, isMainContact: ct.isMainContact,
        customerId: email ? customers.get(email) : undefined,
        action: email && customers.get(email) ? "assign existing customer" : "create contact + customer",
        input: { email: ct.customer?.email, firstName: ct.customer?.firstName, lastName: ct.customer?.lastName, phone: ct.customer?.phone, title: ct.title, locale: ct.locale },
      };
    });
    const locations = c.locations.map((l) => ({ source: l.id, name: l.name, input: locationInput(l, terms, warnings, c.name), roles: l.roles }));
    return {
      source: c.id, name: c.name, action: mapped ? "resume" : "create",
      company: Object.fromEntries(Object.entries({ name: c.name, externalId: c.externalId, note: c.note, customerSince: c.customerSince }).filter(([, v]) => v)),
      locations, contacts,
    };
  });
  return { idmapFile, items, warnings };
}

export function summarizePlan(plan) {
  const count = (a) => plan.items.filter((i) => i.action === a).length;
  const work = plan.items.filter((i) => i.action === "create" || i.action === "resume");
  return {
    companies: { total: plan.items.length, create: count("create"), resume: count("resume"), skip: count("skip") },
    locations: work.reduce((n, i) => n + i.locations.length, 0),
    contacts: {
      assignExisting: work.reduce((n, i) => n + i.contacts.filter((c) => c.customerId).length, 0),
      createNew: work.reduce((n, i) => n + i.contacts.filter((c) => !c.customerId).length, 0),
    },
    roleAssignments: work.reduce((n, i) => n + i.locations.reduce((m, l) => m + l.roles.length, 0), 0),
    skipped: plan.items.filter((i) => i.action === "skip").map((i) => `${i.name}: ${i.reason}`),
    warnings: plan.warnings,
    notCopied: "catalogs / price lists, staff assignments, metafields, orders, store credit, deposits",
  };
}

// ---------- apply ----------

const PAYLOAD_FIELDS = {
  companyCreate: "company { id locations(first: 1) { nodes { id } } contactRoles(first: 20) { nodes { id name } } }",
  companyLocationCreate: "companyLocation { id }",
  companyAssignCustomerAsContact: "companyContact { id }",
  companyContactCreate: "companyContact { id customer { id } }",
  companyAssignMainContact: "company { id }",
  companyContactAssignRoles: "roleAssignments { id }",
};

async function write(shop, field, args, vars, source) {
  const defs = Object.entries(args).map(([k, t]) => `$${k}: ${t}`).join(", ");
  const call = Object.keys(args).map((k) => `${k}: $${k}`).join(", ");
  const mutation = `mutation(${defs}) { ${field}(${call}) { ${PAYLOAD_FIELDS[field]} userErrors { field message } } }`;
  const gate = checkWrite(shop, mutation);
  if (!gate.ok) {
    if (gate.refused) await audit({ shop, mutation, variables: vars, outcome: "refused", error: gate.auditError, source });
    throw new Error(gate.reason);
  }
  const r = await execute(shop.store, mutation, { variables: vars, allowMutations: true });
  if (!r.ok) {
    await audit({ shop, mutation, variables: vars, outcome: "failed", error: r.error, source });
    throw Object.assign(new Error(`${field} failed: ${r.error?.message}`), { details: r.error });
  }
  await audit({ shop, mutation, variables: vars, outcome: "sent", data: r.data, source });
  const p = r.data[field];
  if (p.userErrors?.length) throw new Error(`${field}: ${p.userErrors.map((e) => e.message).join("; ")}`);
  return p;
}

/**
 * Apply up to `batch` companies. Returns per-company results, the companies that failed, and how many
 * still haven't been tried. Companies that failed on an earlier run go to the back of the queue, so a
 * company that keeps failing can't block the others; each run retries it once, after the rest.
 */
export async function applyPlan({ to, plan, batch = 10, source = "copy-companies" }) {
  const idmap = await loadIdmap(plan.idmapFile);
  idmap.customersByEmail ||= {}; // customers this copy created, so a later contact with the same email reuses them
  const failedBefore = (item) => (idmap.companies[item.source]?.lastError ? 1 : 0);
  const work = plan.items
    .filter((i) => i.action === "create" || i.action === "resume")
    .sort((a, b) => failedBefore(a) - failedBefore(b));
  const thisRun = work.slice(0, batch);
  const results = [];
  for (const item of thisRun) {
    const m = (idmap.companies[item.source] ||= { name: item.name, locations: {}, contacts: {}, roles: {} });
    try {
      // 1. company + first location
      if (!m.targetId) {
        const [first] = item.locations;
        const p = await write(to, "companyCreate", { input: "CompanyCreateInput!" },
          { input: { company: item.company, ...(first && { companyLocation: first.input }) } }, source);
        m.targetId = p.company.id;
        m.contactRoles = Object.fromEntries(p.company.contactRoles.nodes.map((r) => [r.name.toLowerCase(), r.id]));
        if (first && p.company.locations.nodes[0]) m.locations[first.source] = p.company.locations.nodes[0].id;
        await saveIdmap(plan.idmapFile, idmap);
      }
      // 2. remaining locations
      for (const loc of item.locations) {
        if (m.locations[loc.source]) continue;
        const p = await write(to, "companyLocationCreate", { companyId: "ID!", input: "CompanyLocationInput!" }, { companyId: m.targetId, input: loc.input }, source);
        m.locations[loc.source] = p.companyLocation.id;
        await saveIdmap(plan.idmapFile, idmap);
      }
      // 3. contacts
      for (const ct of item.contacts) {
        if (m.contacts[ct.source]) continue;
        // An existing customer (found when planning), or one this copy created for an earlier company.
        const customerId = ct.customerId || (ct.email && idmap.customersByEmail[ct.email]);
        const p = customerId
          ? await write(to, "companyAssignCustomerAsContact", { companyId: "ID!", customerId: "ID!" }, { companyId: m.targetId, customerId }, source)
          : await write(to, "companyContactCreate", { companyId: "ID!", input: "CompanyContactInput!" },
              { companyId: m.targetId, input: Object.fromEntries(Object.entries(ct.input).filter(([, v]) => v)) }, source);
        m.contacts[ct.source] = p.companyContact.id;
        if (!customerId && ct.email && p.companyContact.customer?.id) idmap.customersByEmail[ct.email] = p.companyContact.customer.id;
        await saveIdmap(plan.idmapFile, idmap);
      }
      // 4. main contact
      const main = item.contacts.find((c) => c.isMainContact);
      if (main && !m.mainContactSet) {
        await write(to, "companyAssignMainContact", { companyId: "ID!", companyContactId: "ID!" }, { companyId: m.targetId, companyContactId: m.contacts[main.source] }, source);
        m.mainContactSet = true;
        await saveIdmap(plan.idmapFile, idmap);
      }
      // 5. roles, grouped per contact
      const perContact = new Map();
      const missingRoles = new Set();
      for (const loc of item.locations) {
        for (const r of loc.roles) {
          const contactId = m.contacts[r.contactId];
          const roleId = m.contactRoles?.[String(r.role).toLowerCase()];
          if (!contactId) continue;
          if (!roleId) { missingRoles.add(r.role); continue; }
          if (!perContact.has(contactId)) perContact.set(contactId, []);
          perContact.get(contactId).push({ companyContactRoleId: roleId, companyLocationId: m.locations[loc.source] });
        }
      }
      for (const [contactId, roles] of perContact) {
        if (m.roles[contactId]) continue;
        await write(to, "companyContactAssignRoles", { companyContactId: "ID!", rolesToAssign: "[CompanyContactRoleAssign!]!" }, { companyContactId: contactId, rolesToAssign: roles }, source);
        m.roles[contactId] = true;
        await saveIdmap(plan.idmapFile, idmap);
      }
      m.done = true;
      delete m.lastError;
      await saveIdmap(plan.idmapFile, idmap);
      results.push({ name: item.name, ok: true, targetId: m.targetId, locations: Object.keys(m.locations).length, contacts: Object.keys(m.contacts).length,
        ...(missingRoles.size && { warning: `roles not found in target: ${[...missingRoles].join(", ")}` }) });
    } catch (e) {
      m.lastError = e.message;
      await saveIdmap(plan.idmapFile, idmap);
      results.push({ name: item.name, ok: false, error: e.message, partial: !!m.targetId });
    }
  }
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  return { results, failed, remaining: work.length - thisRun.length, idmapFile: plan.idmapFile };
}
