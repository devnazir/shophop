// Read-only tools: shop_query and shop_schema.
import { z } from "zod";
import { execute } from "../../shopify/cli.js";
import { isMutation } from "../../shopify/graphql.js";
import { rootFields, describeType, typeString } from "../../shopify/schema.js";
import { text, fail, shopOrFail, cliError, deliver } from "../respond.js";

const shopArg = z.string().describe("Short name, subdomain or myshopify.com domain from list_shops");

export function registerReadTools(server) {
  server.registerTool(
    "shop_query",
    {
      title: "Query a Shopify store",
      description:
        "Run a read-only Admin GraphQL query on ONE store. Mutations are rejected (use shop_mutation). " +
        "Call it once per store to compare stores. Large results go to a file. For more than a few hundred records use shop_bulk_export.",
      inputSchema: {
        shop: shopArg,
        query: z.string().describe("GraphQL query document"),
        variables: z.record(z.string(), z.unknown()).optional(),
        apiVersion: z.string().optional().describe("Admin API version, e.g. 2026-10"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ shop: ref, query, variables, apiVersion }) => {
      if (isMutation(query)) return fail("This is a mutation. shop_query is read-only; use shop_mutation.");
      const { shop, error } = await shopOrFail(ref);
      if (error) return error;
      const res = await execute(shop.store, query, { variables, version: apiVersion });
      if (!res.ok) return cliError(shop, res.error);
      return deliver(shop, "query", res.data);
    },
  );

  server.registerTool(
    "shop_schema",
    {
      title: "Look up the Admin GraphQL schema",
      description:
        "Read-only lookup of ONE store's Admin GraphQL schema, so field names are exact. Modes: " +
        "(1) operation + search → matching root fields; (2) operation + field → that field's arguments and return type; " +
        "(3) type → a type's fields, input fields or enum values. Inspect nested input types one at a time.",
      inputSchema: {
        shop: shopArg,
        operation: z.enum(["query", "mutation"]).optional(),
        search: z.string().optional().describe("Case-insensitive substring, e.g. 'metaobject'"),
        field: z.string().optional().describe("Exact root field, e.g. metaobjectDefinitionCreate"),
        type: z.string().optional().describe("Exact type, e.g. MetaobjectDefinitionCreateInput"),
        apiVersion: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ shop: ref, operation, search, field, type, apiVersion }) => {
      const { shop, error } = await shopOrFail(ref);
      if (error) return error;

      if (type) {
        const res = await describeType(shop.store, type, apiVersion);
        if (!res.ok) return cliError(shop, res.error);
        if (!res.data) return fail(`Type "${type}" not found on ${shop.alias}'s API version.`);
        return text({ shop: shop.alias, ...res.data });
      }

      if (!operation) return fail("Pass `type`, or `operation` with `search` or `field`.");
      const res = await rootFields(shop.store, operation, apiVersion);
      if (!res.ok) return cliError(shop, res.error);

      if (field) {
        const f = res.data.find((x) => x.name === field);
        if (!f) return fail(`No ${operation} field "${field}". Try search instead.`);
        return text({ shop: shop.alias, operation, name: f.name, description: f.description,
          args: f.args.map((a) => ({ name: a.name, type: typeString(a.type) })), returns: typeString(f.type) });
      }

      const q = (search || "").toLowerCase();
      const hits = res.data.filter((f) => f.name.toLowerCase().includes(q));
      return text({
        shop: shop.alias, operation, count: hits.length,
        fields: hits.slice(0, 80).map((f) => ({ name: f.name, description: (f.description || "").split("\n")[0].slice(0, 120) })),
        ...(hits.length > 80 && { note: "Showing 80; narrow the search." }),
      });
    },
  );
}
