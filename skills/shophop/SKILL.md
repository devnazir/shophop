---
name: shophop
description: Use when a task involves more than one Shopify store, names a store by alias ("store A", "client-b", "prod"), compares or moves data between stores, copies B2B companies, or needs a store's Admin API while the claude.ai Shopify connector is pointed at a different shop. Covers the shophop MCP tools, their safety rules, and common recipes.
---

# shophop

Every shophop tool takes an explicit `shop`, so several stores can be used in the same conversation without switching.

## Before anything

1. `list_shops`: map the user's words to an alias. Check `writable`, `allowDestructive`, `production` and `scopes`. If `shopifyCli.warning` is set, mention it.
2. Missing store or scope: call `open_shop_manager` and let the user sign in. Never edit `~/.config/shophop/` or call the Shop Manager's HTTP API yourself.

## Rules

- **Read first.** Use `shop_query` (and `shop_schema` for exact field names) before any write.
- **Writes** go through `shop_mutation`. Before calling it, say exactly what changes and on which store. It refuses:
  - read-only stores (the user can make one writable in the Shop Manager)
  - destructive changes (deletes, removals, cancellations, refunds, closing, deactivating, unpublishing, archiving, merging, bulk mutations) unless the store allows them
- **Production.** Results about a production store start with a `PRODUCTION` banner. Repeat it to the user before any write there.
- **Copies into production** (dev → prod, prod → prod) need the user's approval in the Shop Manager. Never approve on their behalf.
- **Large data** goes through `shop_bulk_export` and `shop_bulk_status`, which write files. Don't paste thousands of rows into the conversation.
- Every mutation attempt is in the audit log (`shop_audit`).

## Recipes

**Compare two stores**: run the same `shop_query` with each `shop` and diff the results. For whole catalogs, run `shop_bulk_export` on both and compare the files.

**Copy B2B companies A → B**
1. `shop_copy_companies(from: A, to: B)`. This starts the export; if needed, poll `shop_bulk_status` (name `companies`) and call again with `exportFile`.
2. Show the dry-run summary: creates, skips (same name or externalId), contacts reusing customers by email, payment-terms warnings, and what isn't copied.
3. If B is production, the user approves the request in the Shop Manager.
4. After the user confirms, call it with `apply: true`. Repeat until `remaining` is 0. Re-runs never duplicate.
5. For large copies, suggest the terminal: `shophop copy-companies A B --apply`.

**Create something (e.g. a metaobject definition)**: `shop_schema` (look up the mutation and its input type) → `shop_query` (check it doesn't exist) → describe the change → `shop_mutation` → check `userErrors`.
