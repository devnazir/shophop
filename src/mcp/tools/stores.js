// list_shops, open_shop_manager, and the /shops prompt.
import { listShops, CONFIG_PATH } from "../../core/shops.js";
import { cliVersion } from "../../shopify/cli.js";
import { text } from "../respond.js";

let shopManager = null; // started on first use, then reused

export function registerStoreTools(server) {
  server.registerTool(
    "list_shops",
    {
      title: "List Shopify stores",
      description:
        "List every store available to shophop with its short name, domain, scopes, staff user, and whether writes, destructive changes and production apply. " +
        "Also reports the Shopify CLI version and warns if it is untested. Call this first to learn the `shop` values the other tools accept.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const [stores, cli] = await Promise.all([listShops(), cliVersion()]);
      return text({ configFile: CONFIG_PATH, shopifyCli: cli, ...stores });
    },
  );

  server.registerTool(
    "open_shop_manager",
    {
      title: "Open the Shop Manager",
      description:
        "Open the local Shop Manager page in the user's browser. There the user adds stores and signs in (browser login, no custom app), " +
        "chooses what Claude may do per store, marks production stores, and approves copies into production. " +
        "Use it when a store is missing, lacks a scope, is read-only, or needs an approval. Never use the page or its API yourself.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      if (!shopManager) {
        const { startShopManager, openInBrowser } = await import("../../shop-manager/server.js");
        shopManager = { ...(await startShopManager()), openInBrowser };
      }
      shopManager.openInBrowser(shopManager.url);
      return text({ opened: true, note: "The Shop Manager is open in the user's browser. Call list_shops after they finish." });
    },
  );

  server.registerPrompt(
    "shops",
    { title: "Manage Shopify stores", description: "Open the Shop Manager to add stores, sign in, or change what Claude may do" },
    () => ({
      messages: [{ role: "user", content: { type: "text", text: "Open the shophop Shop Manager (open_shop_manager) and wait. When I say I'm done, call list_shops and summarize the stores." } }],
    }),
  );
}
