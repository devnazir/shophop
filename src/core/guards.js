// Write gates shared by shop_mutation and the companies copy. Pure functions, so tests cover them.
import { isMutation, mutationFields } from "../shopify/graphql.js";

// Mutation fields that destroy, detach, reverse or can't easily be undone: deletes and removals, cancellations,
// money movements (refunds, captures, voids), closing orders, deactivating, unpublishing, archiving and merging,
// plus bulk mutations (which can touch any number of records). Matched on the mutation's name, so an ordinary
// update that sets harmful values (e.g. productUpdate to status ARCHIVED) is not caught; see the README.
export const DESTRUCTIVE_RE = /delete|remove|revoke|cancel|destroy|erase|clear|refund|capture|void|close|deactivate|disable|unpublish|archive|merge|bulkOperationRunMutation/i;

// Fields the parser couldn't resolve ("(unknown fragment X)", "(unreadable mutation)") are always risky.
export function destructiveFields(fields) {
  return fields.filter((f) => f.startsWith("(") || DESTRUCTIVE_RE.test(f));
}

// Decide whether a mutation may run on a shop. Returns { ok } or { ok: false, reason }.
export function checkWrite(shop, mutation) {
  if (!isMutation(mutation)) return { ok: false, reason: "No mutation operation found. Use shop_query for reads.", refused: false };
  const fields = mutationFields(mutation);
  if (!shop.writable) {
    return {
      ok: false, refused: true, fields, auditError: "store is read-only",
      reason: `Store "${shop.alias}" (${shop.store}) is read-only. Nothing was sent. The user can allow writes for this store in the Shop Manager (open_shop_manager). Do not try to change the config any other way.`,
    };
  }
  // Nothing recognisable: treat as destructive rather than guess.
  const risky = fields.length ? destructiveFields(fields) : ["(unrecognised mutation)"];
  if (risky.length && !shop.allowDestructive) {
    return {
      ok: false, refused: true, fields, auditError: `destructive mutation not allowed: ${risky.join(", ")}`,
      reason: `Store "${shop.alias}" allows writes but not destructive changes (${risky.join(", ")}). Nothing was sent. The user can allow deletes and other destructive changes for this store in the Shop Manager. Do not try to change the config any other way.`,
    };
  }
  return { ok: true, fields };
}

export const prodBanner = (shop) => `⚠ PRODUCTION store: ${shop.alias} (${shop.store})`;
