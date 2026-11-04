// Helpers every tool uses to build its reply.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { authCommand } from "../shopify/cli.js";
import { resolveShop } from "../core/shops.js";
import { prodBanner } from "../core/guards.js";
import { DATA_DIR, INLINE_LIMIT } from "../settings.js";

/** A successful reply. Objects are pretty-printed as JSON. */
export const text = (body) => ({ content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body, null, 2) }] });

/** An error reply Claude will see as failed. */
export const fail = (message, extra) => ({ isError: true, ...text(extra ? { error: message, ...extra } : message) });

/** Put a PRODUCTION banner in front of any reply about a production store, so it can't be missed. */
export function tagProd(shop, reply) {
  if (shop?.production) reply.content.unshift({ type: "text", text: prodBanner(shop) });
  return reply;
}

/** Resolve the `shop` argument, or return a ready-made error reply. */
export async function shopOrFail(ref) {
  try { return { shop: await resolveShop(ref) }; } catch (e) { return { error: fail(e.message) }; }
}

/** Turn a Shopify CLI error into a reply, with a sign-in hint when it looks like auth or scopes. */
export function cliError(shop, error) {
  const looksLikeAuth = /auth|token|unauthori[sz]ed|401|403|access denied|scope/i.test(JSON.stringify(error));
  return tagProd(shop, fail(error.message ?? "Shopify CLI error", {
    shop: shop.alias,
    store: shop.store,
    details: error.details ?? error.tryMessage ?? error,
    ...(looksLikeAuth && {
      hint: `Looks like a sign-in or scope problem. Offer open_shop_manager so the user can sign in again with the missing scopes (CLI equivalent: ${authCommand(shop.store, shop.scopes?.join(","))}).`,
    }),
  }));
}

/** Return data inline, or write it to a file when it's too big for the conversation. */
export async function deliver(shop, label, data) {
  const body = JSON.stringify(data, null, 2);
  if (body.length <= INLINE_LIMIT) return tagProd(shop, text({ shop: shop.alias, store: shop.store, data }));
  const dir = join(DATA_DIR, shop.alias);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(file, body, "utf8");
  return tagProd(shop, text({
    shop: shop.alias,
    store: shop.store,
    note: `Result was ${body.length} chars, so it was written to a file instead. Read only the parts you need.`,
    file,
  }));
}
