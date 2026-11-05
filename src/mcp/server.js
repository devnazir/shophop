// The MCP server Claude Code talks to. Every tool takes an explicit `shop`, so there is no shared "active shop".
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { cliVersion } from "../shopify/cli.js";
import { registerStoreTools } from "./tools/stores.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { registerBulkTools } from "./tools/bulk.js";
import { registerCopyTools } from "./tools/copy-companies.js";

// Sent to Claude when it connects: how to work with these tools.
const INSTRUCTIONS = `shophop gives access to several Shopify stores at once through the Admin GraphQL API. Every tool takes an explicit \`shop\`.

To copy B2B companies between stores, use shop_copy_companies (dry run first, then apply after the user confirms).

For any other store task (e.g. "create a metaobject in store A"):
1. Call list_shops to map the user's words ("store A", "client-b", "prod") to a store. If it's ambiguous, ask.
2. Never guess GraphQL fields. Use shop_schema to look up the exact query or mutation, its arguments, and input types (one level at a time) on THAT store.
3. Read first with shop_query (e.g. check whether the thing already exists).
4. For writes: tell the user exactly what will change and on which store, then call shop_mutation. If the store doesn't allow it, say so and offer open_shop_manager. Never try to change shophop's settings any other way.
5. Check userErrors in every mutation result and report them. Every mutation attempt is logged; shop_audit reads the log.
6. Move large data with shop_bulk_export (writes a file) instead of pasting it into the conversation. If it returns an operationId, call shop_bulk_status until COMPLETED.
7. Missing store or scope: call open_shop_manager so the user can sign in or add scopes.`;

export function createServer() {
  const server = new McpServer({ name: "shophop", version: "0.5.1" }, { instructions: INSTRUCTIONS });
  registerStoreTools(server);
  registerReadTools(server);
  registerWriteTools(server);
  registerBulkTools(server);
  registerCopyTools(server);
  return server;
}

export async function startMcpServer() {
  await createServer().connect(new StdioServerTransport());
  // Report CLI problems after connecting (the background PATH lookup may still be running, so give it time).
  setTimeout(async () => {
    const cli = await cliVersion();
    if (cli.warning) process.stderr.write(`shophop: ${cli.warning}\n`);
  }, 15_000).unref();
}
