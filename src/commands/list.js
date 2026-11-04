// shophop list
import { listShops, CONFIG_PATH } from "../core/shops.js";

const access = (s) => (s.allowDestructive ? "edit+delete" : s.writable ? "edit" : "read-only");

export async function run() {
  const { shops, removed } = await listShops();
  console.log(`config: ${CONFIG_PATH}\n`);
  for (const s of shops) {
    const flags = [s.production ? "PRODUCTION" : "dev", access(s)].join(", ");
    console.log(`${s.alias.padEnd(20)} ${s.store.padEnd(36)} ${flags.padEnd(24)} ${s.authed ? (s.scopes || []).join(",") : "(not signed in)"}`);
  }
  if (!shops.length) console.log("No stores yet. Run: shophop ui");
  if (removed?.length) console.log(`\nremoved: ${removed.join(", ")}`);
}
