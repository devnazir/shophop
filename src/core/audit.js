// Append-only JSONL audit log of every mutation attempt (sent, failed, or refused).
// Lives next to the config, so Claude Code's deny rules on ~/.config/shophop/ protect it too.
import { appendFile, readFile, mkdir, chmod, stat, rename, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AUDIT_PATH, AUDIT_KEEP_MONTHS as KEEP_MONTHS } from "../settings.js";
import { mutationFields } from "../shopify/graphql.js";

export { AUDIT_PATH };


function collectUserErrors(data) {
  const out = [];
  for (const v of Object.values(data || {})) {
    if (v && Array.isArray(v.userErrors)) out.push(...v.userErrors);
  }
  return out;
}

const clip = (v, n) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + `…(+${s.length - n} chars)` : s;
};

export async function audit({ shop, mutation, variables, outcome, data, error, source = "claude" }) {
  const userErrors = outcome === "sent" ? collectUserErrors(data) : [];
  const entry = {
    ts: new Date().toISOString(),
    shop: shop.alias,
    store: shop.store,
    user: shop.user,
    writable: shop.writable,
    ...(shop.production && { production: true }),
    source, // claude | shop-manager | cli | copy-companies
    fields: mutationFields(mutation),
    outcome: outcome === "sent" && userErrors.length ? "userErrors" : outcome, // sent | userErrors | failed | refused
    ...(userErrors.length && { userErrors }),
    ...(error && { error: clip(error.message ?? error, 1000) }),
    ...(error?.details && { errorDetails: clip(error.details, 2000) }),
    mutation: clip(mutation, 8000),
    ...(variables && { variables: clip(variables, 8000) }),
    ...(data && { result: clip(data, 4000) }),
  };
  try {
    await mkdir(dirname(AUDIT_PATH), { recursive: true });
    await rotate();
    await appendFile(AUDIT_PATH, JSON.stringify(entry) + "\n", { encoding: "utf8", mode: 0o600 });
    await chmod(AUDIT_PATH, 0o600).catch(() => {});
  } catch (e) {
    process.stderr.write(`shophop: could not write audit log: ${e.message}\n`);
  }
  return entry;
}

// Monthly rotation: when the current log was last written in an earlier month, it is renamed to
// audit-YYYY-MM.log (that month) and a fresh audit.log starts. Only the newest KEEP_MONTHS archives are kept.
const monthOf = (d) => d.toISOString().slice(0, 7);
const ARCHIVE_RE = /^audit-(\d{4}-\d{2})\.log$/;

async function archives() {
  const files = await readdir(dirname(AUDIT_PATH)).catch(() => []);
  return files.filter((f) => ARCHIVE_RE.test(f)).sort().reverse(); // newest first
}

export async function rotate(now = new Date()) {
  let st;
  try { st = await stat(AUDIT_PATH); } catch { return; }
  const month = monthOf(st.mtime);
  if (month === monthOf(now) || st.size === 0) return;
  const target = join(dirname(AUDIT_PATH), `audit-${month}.log`);
  try {
    // If an archive for that month already exists, append instead of overwriting it.
    await stat(target);
    await appendFile(target, await readFile(AUDIT_PATH, "utf8"), { mode: 0o600 });
    await unlink(AUDIT_PATH);
  } catch {
    await rename(AUDIT_PATH, target);
  }
  for (const old of (await archives()).slice(KEEP_MONTHS)) await unlink(join(dirname(AUDIT_PATH), old)).catch(() => {});
}

export async function readAudit({ limit = 100, shop } = {}) {
  const files = [AUDIT_PATH, ...(await archives()).map((f) => join(dirname(AUDIT_PATH), f))];
  const entries = [];
  for (const file of files) {
    if (entries.length >= limit) break;
    let lines = [];
    try { lines = (await readFile(file, "utf8")).split("\n").filter(Boolean); } catch (e) { if (e.code !== "ENOENT") throw e; }
    for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (!shop || e.shop === shop || e.store === shop) entries.push(e);
      } catch {}
    }
  }
  return entries; // newest first
}
