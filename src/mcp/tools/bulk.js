// Large exports: shop_bulk_export starts one, shop_bulk_status checks and downloads it.
import { z } from "zod";
import { isMutation } from "../../shopify/graphql.js";
import { startBulk, checkBulk } from "../../shopify/bulk.js";
import { DATA_DIR } from "../../settings.js";
import { text, fail, tagProd, shopOrFail, cliError } from "../respond.js";

const FINISHED_BADLY = ["FAILED", "CANCELED", "CANCELLED", "EXPIRED"];
const fileName = z.string().regex(/^[\w.-]+$/);

/** Shape a checkBulk result into a reply. */
function bulkReply(shop, name, r) {
  if (r.state === "ERROR") return cliError(shop, r.error);
  const body = { shop: shop.alias, store: shop.store, ...r };
  if (r.state === "COMPLETED") return tagProd(shop, text(body));
  if (FINISHED_BADLY.includes(r.state)) return tagProd(shop, fail(`Bulk export ${r.state}`, body));
  return tagProd(shop, text({ ...body, next: `Still ${r.state}. Call shop_bulk_status with shop "${shop.alias}", operationId "${r.operationId}" and name "${name}".` }));
}

export function registerBulkTools(server) {
  server.registerTool(
    "shop_bulk_export",
    {
      title: "Start a bulk export",
      description:
        "Start a read-only bulk query on ONE store and wait up to `waitSeconds` (default 20). If it finishes, the JSONL is saved to a file " +
        "and the path, line count and a short preview are returned (not the data). Otherwise it returns an operationId for shop_bulk_status. " +
        "Bulk query rules: one top-level connection, at most 5 connections, nesting at most 2 levels, no `first:` needed. Child rows carry `__parentId`.",
      inputSchema: {
        shop: z.string().describe("Short name, subdomain or myshopify.com domain from list_shops"),
        query: z.string().describe("e.g. { products { edges { node { id title } } } }"),
        name: fileName.optional().describe("File name stem, e.g. products. Default: export"),
        waitSeconds: z.number().int().min(0).max(45).optional(),
        apiVersion: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ shop: ref, query, name = "export", waitSeconds = 20, apiVersion }) => {
      if (isMutation(query)) return fail("Only bulk queries are supported, not bulk mutations.");
      const { shop, error } = await shopOrFail(ref);
      if (error) return error;
      const started = await startBulk(shop, query, { apiVersion });
      if (!started.ok) return cliError(shop, started.error);
      return bulkReply(shop, name, await checkBulk(shop, started.gid, { dataDir: DATA_DIR, name, waitSeconds }));
    },
  );

  server.registerTool(
    "shop_bulk_status",
    {
      title: "Check or download a bulk export",
      description:
        "Check a bulk export from shop_bulk_export, waiting up to `waitSeconds` (default 30). When COMPLETED it downloads the JSONL once " +
        "and returns the path, line count and preview. Still RUNNING: call again. FAILED/CANCELED/EXPIRED: returns the error and any partial file.",
      inputSchema: {
        shop: z.string().describe("Same store as the export"),
        operationId: z.string().describe("From shop_bulk_export (gid://shopify/BulkOperation/… or just the number)"),
        name: fileName.optional().describe("Same name used for the export. Default: export"),
        waitSeconds: z.number().int().min(0).max(45).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ shop: ref, operationId, name = "export", waitSeconds = 30 }) => {
      const { shop, error } = await shopOrFail(ref);
      if (error) return error;
      const gid = operationId.startsWith("gid://") ? operationId : `gid://shopify/BulkOperation/${operationId}`;
      return bulkReply(shop, name, await checkBulk(shop, gid, { dataDir: DATA_DIR, name, waitSeconds }));
    },
  );
}
