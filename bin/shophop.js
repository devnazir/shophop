#!/usr/bin/env node
// Entry point.
//   shophop                 MCP server for Claude Code / Claude Desktop (stdio)
//   shophop ui              open the Shop Manager
//   shophop list            stores and what Claude may do on each
//   shophop audit           recent changes
//   shophop copy-companies  copy B2B companies between stores
//   shophop setup desktop   add shophop to Claude Desktop

import { ensureShopifyOnPath, findShopifyViaLoginShell } from "../src/shopify/env.js";

const COMMANDS = {
  ui: () => import("../src/commands/ui.js"),
  list: () => import("../src/commands/list.js"),
  audit: () => import("../src/commands/audit.js"),
  "copy-companies": () => import("../src/commands/copy-companies.js"),
  setup: () => import("../src/commands/setup.js"),
};

// Started from Claude Desktop (or anything outside a terminal), PATH may not include the Shopify CLI.
// The quick checks run now; the slow login-shell lookup only if needed (in the background for the server).
const found = ensureShopifyOnPath();

const [command, ...args] = process.argv.slice(2);

if (!command || command === "serve") {
  if (found.source === "missing") findShopifyViaLoginShell(); // don't block: Claude Desktop needs a fast handshake
  const { startMcpServer } = await import("../src/mcp/server.js");
  await startMcpServer();
} else if (COMMANDS[command]) {
  if (found.source === "missing") await findShopifyViaLoginShell();
  const { run } = await COMMANDS[command]();
  await run(args);
} else {
  console.log("Usage: shophop [ui [--no-open] [--port N] | list | audit [-n N] | copy-companies <from> <to> [--apply] | setup desktop | serve]");
  process.exit(command === "help" || command === "--help" ? 0 : 2);
}
