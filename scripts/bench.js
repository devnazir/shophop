import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// Usage: npm run bench -- <shop>   (times a read-only query on a real store)
const shop = process.argv[2];
if (!shop) { console.error("Usage: npm run bench -- <shop>"); process.exit(2); }
const c = new Client({ name: "b", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: [new URL("../bin/shophop.js", import.meta.url).pathname], stderr: "ignore" }));
const times = [];
for (let i = 0; i < 4; i++) { const t = Date.now(); await c.callTool({ name: "shop_query", arguments: { shop, query: "{ shop { name } }" } }); times.push(Date.now() - t); }
console.log("shop_query ms:", times.join(", "));
await c.close();
