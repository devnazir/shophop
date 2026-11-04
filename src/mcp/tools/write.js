// Writes and their history: shop_mutation and shop_audit.
import { z } from "zod";
import { execute } from "../../shopify/cli.js";
import { checkWrite } from "../../core/guards.js";
import { audit, readAudit, AUDIT_PATH } from "../../core/audit.js";
import { text, fail, tagProd, shopOrFail, cliError, deliver } from "../respond.js";

export function registerWriteTools(server) {
  server.registerTool(
    "shop_mutation",
    {
      title: "Run a mutation on a Shopify store",
      description:
        "Run an Admin GraphQL mutation on ONE store. Refused unless the user allowed edits for that store in the Shop Manager. " +
        "Destructive changes (deletes, removals, cancellations, refunds, closing, deactivating, unpublishing, archiving, merging, bulk mutations) also need the store's 'delete' access. Every attempt is logged. " +
        "Replies about production stores start with a PRODUCTION banner. Before calling this, tell the user exactly what will change and on which store.",
      inputSchema: {
        shop: z.string().describe("Short name, subdomain or myshopify.com domain from list_shops"),
        mutation: z.string().describe("GraphQL mutation document"),
        variables: z.record(z.string(), z.unknown()).optional(),
        apiVersion: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ shop: ref, mutation, variables, apiVersion }) => {
      const { shop, error } = await shopOrFail(ref);
      if (error) return error;

      const gate = checkWrite(shop, mutation);
      if (!gate.ok) {
        if (gate.refused) await audit({ shop, mutation, variables, outcome: "refused", error: gate.auditError });
        return tagProd(shop, fail(gate.reason));
      }

      const res = await execute(shop.store, mutation, { variables, version: apiVersion, allowMutations: true });
      if (!res.ok) {
        await audit({ shop, mutation, variables, outcome: "failed", error: res.error });
        return cliError(shop, res.error);
      }
      const entry = await audit({ shop, mutation, variables, outcome: "sent", data: res.data });
      const reply = await deliver(shop, "mutation", res.data);
      reply.content.push({ type: "text", text: `Logged as "${entry.outcome}" (${entry.fields.join(", ")}).` });
      return reply;
    },
  );

  server.registerTool(
    "shop_audit",
    {
      title: "Show the change log",
      description:
        "Read the audit log: every mutation that was sent, rejected by Shopify, failed, or blocked, newest first. " +
        "Use it to answer 'what did we change on store X?' or to check a write.",
      inputSchema: {
        shop: z.string().optional().describe("Filter by short name or domain"),
        limit: z.number().int().min(1).max(200).optional().describe("Default 20"),
        full: z.boolean().optional().describe("Include mutation text, variables and result"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ shop, limit = 20, full = false }) => {
      const entries = await readAudit({ limit, shop });
      const rows = full ? entries : entries.map(({ ts, shop, store, user, source, fields, outcome, userErrors, error }) =>
        ({ ts, shop, store, user, source, fields, outcome, ...(userErrors && { userErrors }), ...(error && { error }) }));
      return text({ auditFile: AUDIT_PATH, count: rows.length, entries: rows });
    },
  );
}
