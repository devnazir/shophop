// shophop ui [--no-open] [--port N]
import { startShopManager, openInBrowser } from "../shop-manager/server.js";

export async function run(args) {
  const i = args.indexOf("--port");
  const port = i >= 0 ? Number(args[i + 1]) : undefined;
  const { url } = await startShopManager(port !== undefined ? { port } : {});
  console.log(`Shop Manager: ${url}\nCtrl+C to stop.`);
  if (!args.includes("--no-open")) openInBrowser(url);
}
