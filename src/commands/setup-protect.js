// shophop setup protect [--remove]
// Adds Claude Code rules so Claude can't change shophop's settings, approve its own copies, or read Shopify tokens.
// Merges into ~/.claude/settings.json: keeps every other rule, never duplicates, and backs the file up once.
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, relative, isAbsolute } from "node:path";
import { CONFIG_PATH, AUDIT_PATH, APPROVALS_PATH } from "../settings.js";

const CLAUDE_SETTINGS = process.env.CLAUDE_SETTINGS
  || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");

// Where the Shopify CLI keeps store tokens (the `conf` package's folder per platform).
function shopifyTokenDir() {
  if (process.platform === "darwin") return join(homedir(), "Library", "Preferences", "shopify-cli-store-nodejs");
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "shopify-cli-store-nodejs", "Config");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "shopify-cli-store-nodejs");
}

// Claude Code permission paths: "~/x" for paths in your home folder, "//abs/path" for other absolute paths.
function rulePath(abs) {
  const rel = relative(homedir(), abs);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return `~/${rel.split("\\").join("/")}`;
  return `/${abs.split("\\").join("/")}`;
}

/**
 * The rules for this machine. Pure, so tests can check them. Every folder holding shophop's state is
 * protected: settings, audit log and approvals normally share one folder, but each can be moved
 * (SHOPHOP_CONFIG / SHOPHOP_AUDIT / SHOPHOP_APPROVALS), and an unprotected approvals file would let
 * Claude approve its own production copies.
 */
export function protectionRules({
  stateDirs = [dirname(CONFIG_PATH), dirname(AUDIT_PATH), dirname(APPROVALS_PATH)],
  tokenDir = shopifyTokenDir(),
} = {}) {
  const dirs = [...new Set(stateDirs.map(rulePath))];
  const tokens = rulePath(tokenDir);
  const list = dirs.map((d) => `${d}/`).join(" and ");
  return {
    deny: [...dirs.map((d) => `Edit(${d}/**)`), `Read(${tokens}/**)`, `Edit(${tokens}/**)`],
    hardDeny: [
      `Creating, modifying, moving or deleting anything under ${list} (the shophop store config, audit log and production-copy approvals) by any means, including shell commands, scripts or other programs. Only the user changes these, through the Shop Manager UI.`,
      "Calling the shophop Shop Manager's local HTTP API (127.0.0.1 /api/approvals, /api/shops, /api/auth) with curl, fetch, a browser automation tool or any other client, e.g. to approve a copy into a production store or change a store's writable, destructive or production settings. Only the user does this, by hand in their own browser.",
    ],
  };
}

// Our hard_deny entries are recognised by mentioning shophop, so re-running replaces older wording.
const isOurHardDeny = (rule) => typeof rule === "string" && /shophop/i.test(rule);

/** Apply (or remove) the rules on a parsed settings object. Pure; returns { settings, changed }. */
export function applyProtection(settings, rules, { remove = false } = {}) {
  const before = JSON.stringify(settings);
  const s = structuredClone(settings);

  s.permissions ||= {};
  const deny = (s.permissions.deny || []).filter((r) => !rules.deny.includes(r));
  s.permissions.deny = remove ? deny : [...deny, ...rules.deny];
  if (!s.permissions.deny.length) delete s.permissions.deny;
  if (!Object.keys(s.permissions).length) delete s.permissions;

  const had = s.autoMode?.hard_deny;
  let hard = (had || []).filter((r) => !isOurHardDeny(r));
  if (!remove) {
    // A new list starts with "$defaults" so Claude Code's built-in rules keep applying.
    // An existing list is left as the user wrote it, apart from our entries.
    if (!had) hard = ["$defaults"];
    hard = [...hard, ...rules.hardDeny];
  }
  if (had || !remove) {
    if (hard.length) {
      s.autoMode ||= {};
      s.autoMode.hard_deny = hard;
    } else {
      delete s.autoMode.hard_deny;
      if (!Object.keys(s.autoMode).length) delete s.autoMode;
    }
  }
  return { settings: s, changed: JSON.stringify(s) !== before };
}

export async function run(args) {
  const remove = args.includes("--remove");
  let settings = {};
  if (existsSync(CLAUDE_SETTINGS)) {
    try { settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8")); }
    catch (e) { console.error(`Could not read ${CLAUDE_SETTINGS}: ${e.message}\nFix it, then try again. Nothing was changed.`); process.exit(1); }
  }

  const rules = protectionRules();
  const { settings: next, changed } = applyProtection(settings, rules, { remove });
  if (!changed) { console.log(remove ? "No shophop rules found. Nothing to remove." : `Already protected. ${CLAUDE_SETTINGS} is up to date.`); return; }

  if (existsSync(CLAUDE_SETTINGS) && !existsSync(`${CLAUDE_SETTINGS}.bak`)) copyFileSync(CLAUDE_SETTINGS, `${CLAUDE_SETTINGS}.bak`);
  mkdirSync(dirname(CLAUDE_SETTINGS), { recursive: true });
  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(next, null, 2) + "\n");

  if (remove) { console.log(`Removed shophop's rules from ${CLAUDE_SETTINGS}.`); return; }
  console.log(`Protected. Updated ${CLAUDE_SETTINGS}:`);
  console.log("  Claude can't read or edit:");
  for (const r of rules.deny) console.log(`    ${r}`);
  console.log("  In auto mode, Claude also can't change shophop's folder with shell commands or use the Shop Manager's API.");
  console.log("\nRestart Claude Code so the rules are loaded.");
}
