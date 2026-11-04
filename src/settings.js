// Every path and tunable in one place. Each can be overridden with an environment variable.
import { homedir } from "node:os";
import { join, dirname, resolve, parse } from "node:path";

/**
 * Read an environment variable, treating empty values and unfilled templates as unset.
 * Claude Desktop extensions pass optional settings the user left empty as "" or as the literal
 * placeholder (e.g. "${user_config.shopify_cli}"), and neither should be used as a real value.
 */
export function fromEnv(name) {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" || /^\$\{[^}]*\}$/.test(t) ? undefined : t;
}

/** The Shopify CLI binary. */
export const SHOPIFY_BIN = fromEnv("SHOPIFY_BIN") || "shopify";

/** Pin the Admin API version (e.g. "2026-10"). Unset = the CLI's latest stable, which costs ~0.5 s per call to resolve. */
export const API_VERSION = fromEnv("SHOPHOP_API_VERSION");

/** Store settings written by the Shop Manager. */
export const CONFIG_PATH = fromEnv("SHOPHOP_CONFIG") || join(homedir(), ".config", "shophop", "shops.json");

/** Append-only log of every mutation attempt. Rotated monthly. */
export const AUDIT_PATH = fromEnv("SHOPHOP_AUDIT") || join(dirname(CONFIG_PATH), "audit.log");
export const AUDIT_KEEP_MONTHS = Number(fromEnv("SHOPHOP_AUDIT_KEEP_MONTHS")) || 12;

/** Approvals for copies into production stores. */
export const APPROVALS_PATH = fromEnv("SHOPHOP_APPROVALS") || join(dirname(CONFIG_PATH), "approvals.json");
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Where exports, copy plans and ID maps go: SHOPHOP_DATA_DIR if set, then SHOPHOP_DEFAULT_DATA_DIR (the
 * Claude Desktop extension sets it to ~/shophop-data), then ./shopify-data in the Claude Code project folder,
 * or ~/shophop-data when started in a drive's root folder (apps without a project folder).
 */
const cwd = process.cwd();
const startedAtRoot = parse(cwd).root === cwd;
export const DATA_DIR = resolve(fromEnv("SHOPHOP_DATA_DIR") || fromEnv("SHOPHOP_DEFAULT_DATA_DIR")
  || (startedAtRoot ? join(homedir(), "shophop-data") : "shopify-data"));

/** Tool results longer than this (characters) are written to a file instead of the conversation. */
export const INLINE_LIMIT = Number(fromEnv("SHOPHOP_INLINE_LIMIT")) || 15_000;

/** Shop Manager port. 0 = any free port. */
export const UI_PORT = Number(fromEnv("SHOPHOP_UI_PORT")) || 0;

/** The `shopify store` commands this tool relies on were tested on these CLI versions. */
export const TESTED_CLI = { major: 4, minMinor: 9, label: "4.9.x" };
