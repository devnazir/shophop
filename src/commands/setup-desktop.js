// shophop setup desktop [--data-dir DIR] [--remove]
// Adds (or removes) shophop in Claude Desktop's config, with the right paths, so nobody edits JSON by hand.
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_CONFIG = process.env.CLAUDE_DESKTOP_CONFIG || ({
  darwin: join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"),
  win32: join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json"),
}[process.platform] ?? join(homedir(), ".config", "Claude", "claude_desktop_config.json"));

const ENTRY_POINT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "shophop.js");
export async function run(args) {
  const i = args.indexOf("--data-dir");
  const dataDir = resolve(i >= 0 ? args[i + 1] : join(homedir(), "shophop-data"));

  let config = {};
  if (existsSync(DESKTOP_CONFIG)) {
    try { config = JSON.parse(readFileSync(DESKTOP_CONFIG, "utf8")); }
    catch (e) { console.error(`Could not read ${DESKTOP_CONFIG}: ${e.message}\nFix or remove it, then try again.`); process.exit(1); }
    const backup = `${DESKTOP_CONFIG}.bak`;
    if (!existsSync(backup)) copyFileSync(DESKTOP_CONFIG, backup);
  }
  config.mcpServers ||= {};

  if (args.includes("--remove")) {
    delete config.mcpServers.shophop;
  } else {
    // process.execPath is the Node running this command, so the path is right even with nvm.
    // No PATH entry needed: shophop finds the Shopify CLI through your login shell (see src/shopify/env.js).
    config.mcpServers.shophop = { command: process.execPath, args: [ENTRY_POINT], env: { SHOPHOP_DATA_DIR: dataDir } };
  }

  mkdirSync(dirname(DESKTOP_CONFIG), { recursive: true });
  writeFileSync(DESKTOP_CONFIG, JSON.stringify(config, null, 2) + "\n");
  console.log(args.includes("--remove")
    ? `Removed shophop from ${DESKTOP_CONFIG}.`
    : `Added shophop to ${DESKTOP_CONFIG}\n  node:    ${process.execPath}\n  server:  ${ENTRY_POINT}\n  exports: ${dataDir}`);
  console.log("\nQuit Claude Desktop completely (Cmd+Q) and reopen it to apply.");
}
