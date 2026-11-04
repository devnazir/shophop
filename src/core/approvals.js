// Human approvals for copying data INTO a production store (e.g. dev → prod).
// A dry run files a request; the user approves it in the Shop Manager by typing the target domain.
// Stored next to the config, which Claude Code's deny rules keep Claude's file tools out of.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { APPROVALS_PATH, APPROVAL_TTL_MS } from "../settings.js";

export { APPROVALS_PATH };

// Stable across apply batches: depends only on what is copied, not on progress.
export async function copyId({ kind, from, to, exportFile, only }) {
  const h = createHash("sha256");
  h.update([kind, from.store, to.store, (only || []).map((s) => s.toLowerCase()).sort().join(",")].join("|"));
  h.update(await readFile(exportFile));
  return h.digest("hex").slice(0, 12);
}

async function load() {
  try { return JSON.parse(await readFile(APPROVALS_PATH, "utf8")); } catch { return { requests: {} }; }
}
async function save(data) {
  await mkdir(dirname(APPROVALS_PATH), { recursive: true });
  await writeFile(`${APPROVALS_PATH}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(`${APPROVALS_PATH}.tmp`, APPROVALS_PATH);
}

const live = (r, now = Date.now()) => r.status === "approved" && Date.parse(r.expiresAt) > now;

export async function requestApproval({ id, kind, from, to, exportFile, summary }) {
  const data = await load();
  const existing = data.requests[id];
  if (existing && (live(existing) || existing.status === "pending")) return existing;
  data.requests[id] = {
    id, kind, status: "pending", requestedAt: new Date().toISOString(),
    from: from.alias, fromStore: from.store, fromProduction: !!from.production,
    to: to.alias, toStore: to.store, exportFile, summary,
  };
  // Keep the file small: drop decided requests older than 30 days.
  const cutoff = Date.now() - 30 * 24 * 3600e3;
  for (const [k, r] of Object.entries(data.requests)) if (r.status !== "pending" && Date.parse(r.decidedAt || r.requestedAt) < cutoff) delete data.requests[k];
  await save(data);
  return data.requests[id];
}

export async function approvalStatus(id) {
  const r = (await load()).requests[id];
  if (!r) return { state: "none" };
  if (live(r)) return { state: "approved", request: r };
  if (r.status === "approved") return { state: "expired", request: r };
  return { state: r.status, request: r };
}

// Only the Shop Manager calls these, after the user typed the target store's domain.
export async function decide(id, action, confirmStore) {
  const data = await load();
  const r = data.requests[id];
  if (!r) throw new Error("No such approval request");
  if (action === "approve") {
    if (String(confirmStore || "").trim().toLowerCase() !== r.toStore) throw new Error(`Type ${r.toStore} to approve`);
    Object.assign(r, { status: "approved", decidedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString() });
  } else if (action === "reject") {
    Object.assign(r, { status: "rejected", decidedAt: new Date().toISOString() });
  } else throw new Error("Unknown action");
  await save(data);
  return r;
}

export async function listApprovals() {
  const data = await load();
  const now = Date.now();
  return Object.values(data.requests)
    .map((r) => ({ ...r, state: live(r, now) ? "approved" : r.status === "approved" ? "expired" : r.status }))
    .sort((a, b) => (b.decidedAt || b.requestedAt).localeCompare(a.decidedAt || a.requestedAt));
}

// One check used by both the MCP tool and the CLI. Returns null when the copy may proceed.
export async function productionCopyBlock({ kind, from, to, exportFile, only, summary }) {
  if (!to.production) return null;
  const id = await copyId({ kind, from, to, exportFile, only });
  const st = await approvalStatus(id);
  if (st.state === "approved") return null;
  await requestApproval({ id, kind, from, to, exportFile, summary });
  const what = from.production ? `${from.alias} (production)` : `${from.alias} (not production)`;
  const why = st.state === "rejected" ? "The user rejected this copy." : st.state === "expired" ? "The earlier approval expired (24 h)." : "Nothing has been written.";
  return {
    id,
    message: `Copying from ${what} into PRODUCTION store ${to.alias} needs the user's approval. ${why} ` +
      `The user must open the Shop Manager (open_shop_manager), find approval request ${id} under "Approvals", and approve it by typing ${to.store}. ` +
      `Then run the same copy again. Never approve on the user's behalf.`,
  };
}
