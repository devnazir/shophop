// Shops = every store authed with `shopify store auth`, plus optional aliases/flags from a config file.
// Config is optional. A store is writable ONLY if the config says `"writable": true`.
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { authList } from "../shopify/cli.js";
import { CONFIG_PATH } from "../settings.js";

export { CONFIG_PATH };

export async function loadConfig() {
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    return raw.shops ?? {};
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw new Error(`Could not read ${CONFIG_PATH}: ${e.message}`);
  }
}

export async function saveConfig(shops) {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify({ shops }, null, 2) + "\n", "utf8");
  await rename(tmp, CONFIG_PATH);
}

export const normalize = (s) => {
  const v = String(s).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return v.endsWith(".myshopify.com") ? v : `${v}.myshopify.com`;
};

// `shopify store auth list` costs a full CLI start (seconds), and every tool call resolves its shop,
// so cache the sign-in list briefly. The Shop Manager clears it after a sign-in.
const SESSIONS_TTL_MS = 30_000;
// The lookup in flight is shared too, so parallel calls (e.g. resolving the source and target of a copy)
// start one CLI process, not one each.
let sessionsCache = null;   // { at, value } of the last successful lookup
let sessionsPending = null; // the lookup currently running
export function invalidateSessions() { sessionsCache = null; }
function cachedSessions() {
  if (sessionsCache && Date.now() - sessionsCache.at < SESSIONS_TTL_MS) return Promise.resolve(sessionsCache.value);
  sessionsPending ||= authList()
    .then((value) => { if (value.ok) sessionsCache = { at: Date.now(), value }; return value; })
    .finally(() => { sessionsPending = null; });
  return sessionsPending;
}

export async function listShops() {
  const config = await loadConfig();
  const sessions = await cachedSessions();
  const byStore = new Map();
  // Removed stores: the Shopify CLI can't sign out of a store, so "remove" hides it from shophop.
  const hidden = new Set(Object.values(config).filter((c) => c.hidden).map((c) => normalize(c.store)));

  for (const [alias, c] of Object.entries(config)) {
    if (c.hidden) continue;
    const store = normalize(c.store);
    byStore.set(store, {
      alias,
      store,
      writable: c.writable === true,
      // Deletes/removals/cancellations need this on top of writable.
      allowDestructive: c.writable === true && c.allowDestructive === true,
      production: c.production === true,
      note: c.note,
      authed: false,
    });
  }
  if (sessions.ok) {
    for (const s of sessions.data) {
      const store = normalize(s.store);
      if (hidden.has(store)) continue;
      // Signed in but not configured: its short name is the subdomain, unless a configured store already uses
      // that name, in which case the full domain is used so the two can never be mixed up.
      const sub = s.subdomain || store.split(".")[0];
      const taken = [...byStore.values()].some((e) => e.alias.toLowerCase() === sub.toLowerCase());
      const entry = byStore.get(store) ?? { alias: taken ? store : sub, store, writable: false, allowDestructive: false, production: false, authed: false };
      Object.assign(entry, {
        authed: true,
        scopes: s.scopes,
        user: s.associatedUser?.email,
        tokenExpiresAt: s.expiresAt,
      });
      byStore.set(store, entry);
    }
  }
  return { shops: [...byStore.values()], removed: [...hidden], authListError: sessions.ok ? undefined : sessions.error };
}

// Accepts a short name, a subdomain, or a full myshopify domain. A full domain always means that exact store.
export async function resolveShop(ref) {
  const { shops } = await listShops();
  const key = String(ref).trim().toLowerCase();
  const exactDomain = key.includes(".") ? shops.find((s) => s.store === normalize(key)) : undefined;
  const hit =
    exactDomain ??
    shops.find((s) => s.alias.toLowerCase() === key) ??
    shops.find((s) => s.store === normalize(key));
  if (!hit) {
    const known = shops.map((s) => `${s.alias} (${s.store})`).join(", ") || "none";
    throw new Error(`Unknown shop "${ref}". Known shops: ${known}. The user can add or restore stores in the Shop Manager (open_shop_manager).`);
  }
  return hit;
}
