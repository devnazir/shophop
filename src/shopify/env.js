// Find and start the Shopify CLI reliably, on macOS, Linux and Windows.
//
// Apps started outside a terminal (Claude Desktop) don't get your terminal's PATH, so they may not find
// `shopify` or the `node` it runs on. This finds it without slowing startup:
//   1. PATH as given (terminals, Claude Code)                          instant
//   2. the usual install folders (nvm, Homebrew, Volta, npm global, …)   milliseconds
//   3. the PATH found last time, cached on disk                          instant
//   4. macOS/Linux only: ask the login shell, in the background          seconds (heavy shell setups)
// Startup must stay fast: Claude Desktop gives up on servers that don't answer within a few seconds.
//
// Starting it: the Shopify CLI is a Node program. Rather than trusting its launcher (a `#!/usr/bin/env node`
// script on macOS/Linux, a `shopify.cmd` wrapper on Windows), shophop runs the CLI's JavaScript entry with a
// suitable Node directly. That avoids an older Node earlier on PATH, and on Windows it avoids cmd.exe,
// which can't be started without a shell and would mangle JSON arguments.
import { execFile } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter, dirname, isAbsolute, basename, resolve } from "node:path";
import { SHOPIFY_BIN } from "../settings.js";

const WIN = process.platform === "win32";
const env = process.env;

function cacheFile() {
  if (WIN) return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "shophop", "Cache", "path.json");
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "shophop", "path.json");
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "shophop", "path.json");
}

// Windows has no "executable" bit; existing is enough there.
const canRun = (file) => { try { accessSync(file, WIN ? constants.F_OK : constants.X_OK); return true; } catch { return false; } };
const exists = (file) => { try { accessSync(file, constants.F_OK); return true; } catch { return false; } };

// Windows finds `shopify` as shopify.cmd / shopify.exe etc. (PATHEXT).
const EXTS = WIN ? ["", ...(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").toLowerCase().split(";").filter(Boolean)] : [""];
function findIn(cmd, pathValue) {
  for (const dir of (pathValue || "").split(delimiter).filter(Boolean)) {
    for (const ext of EXTS) {
      const file = join(dir, cmd + ext);
      if (canRun(file)) return file;
    }
  }
  return undefined;
}

function prependPath(...dirs) {
  const fallback = WIN ? "" : "/usr/bin:/bin:/usr/sbin:/sbin";
  const current = (env.PATH || fallback).split(delimiter);
  env.PATH = [...new Set([...dirs, ...current])].filter(Boolean).join(delimiter);
}

// Newest version first, e.g. v22.20.0 before v18.12.1.
const newestFirst = (names) => names.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
function subdirs(base, then = "") {
  try { return newestFirst(readdirSync(base)).map((v) => join(base, v, then)); } catch { return []; }
}

function knownDirs() {
  const h = homedir();
  if (WIN) {
    const appData = env.APPDATA || join(h, "AppData", "Roaming");
    const local = env.LOCALAPPDATA || join(h, "AppData", "Local");
    return [
      join(appData, "npm"),                                     // npm install -g (default prefix)
      env.NVM_SYMLINK, ...subdirs(env.NVM_HOME || join(appData, "nvm")), // nvm-windows
      join(env.ProgramFiles || "C:\\Program Files", "nodejs"),
      join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "nodejs"),
      join(local, "Volta", "bin"), join(local, "pnpm"), join(h, "scoop", "shims"),
    ].filter(Boolean);
  }
  return [
    ...subdirs(join(h, ".nvm", "versions", "node"), "bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
    join(h, ".volta", "bin"), join(h, ".asdf", "shims"), join(h, ".local", "bin"),
    join(h, ".npm-global", "bin"), join(h, "Library", "pnpm"), join(h, ".local", "share", "pnpm"), join(h, ".bun", "bin"),
  ];
}

function readCache() { try { return JSON.parse(readFileSync(cacheFile(), "utf8")); } catch { return null; } }
function writeCache(data) {
  try { mkdirSync(dirname(cacheFile()), { recursive: true }); writeFileSync(cacheFile(), JSON.stringify(data)); } catch {}
}

/** Fast, synchronous. Fixes PATH if it can; never runs a shell. */
export function ensureShopifyOnPath() {
  if (isAbsolute(SHOPIFY_BIN)) {
    if (!canRun(SHOPIFY_BIN)) return { source: "missing" };
    prependPath(dirname(SHOPIFY_BIN)); // its `node` is usually next to it
    return { source: "configured" };
  }
  const onPath = findIn(SHOPIFY_BIN, env.PATH);
  if (onPath) {
    // Put its folder first anyway, so its own `node` wins over older ones earlier on PATH
    // (e.g. /usr/local/bin/node v14 ahead of nvm's folder).
    prependPath(dirname(onPath));
    return { source: "inherited" };
  }

  const found = knownDirs().map((d) => findIn(SHOPIFY_BIN, d)).find(Boolean);
  if (found) { prependPath(dirname(found)); return { source: "known-folder", dir: dirname(found) }; }

  const cached = readCache();
  if (cached?.path && findIn(SHOPIFY_BIN, cached.path)) { prependPath(...cached.path.split(delimiter)); return { source: "cache" }; }

  return { source: "missing" };
}

// ---- starting the CLI ----

const isJs = (file) => /\.(c|m)?js$/i.test(file);
function hasNodeShebang(file) {
  try { return /^#!.*\bnode\b/.test(readFileSync(file, "utf8").slice(0, 200)); } catch { return false; }
}

// The CLI's JavaScript entry for a launcher found on PATH: the file itself (macOS/Linux symlink to run.js),
// or, for a Windows npm wrapper (shopify.cmd), node_modules/@shopify/cli/bin/run.js next to it.
function jsEntryFor(bin) {
  if (isJs(bin)) return bin;
  if (!WIN && hasNodeShebang(bin)) return bin;
  const dir = dirname(bin);
  return [
    join(dir, "node_modules", "@shopify", "cli", "bin", "run.js"),
    join(dir, "..", "lib", "node_modules", "@shopify", "cli", "bin", "run.js"),
  ].find(exists); // Node runs it, so it only has to exist, not be executable
}

// A Node to run it with: the one installed next to the CLI (nvm, Homebrew, Program Files\nodejs),
// then the first `node` on PATH, then the Node running shophop itself if that is a real Node binary.
function nodeFor(bin) {
  const nodeName = WIN ? "node.exe" : "node";
  const sibling = join(dirname(bin), nodeName);
  if (canRun(sibling)) return sibling;
  const onPath = findIn("node", env.PATH);
  if (onPath) return onPath;
  if (/^node(\.exe)?$/i.test(basename(process.execPath))) return process.execPath;
  return null;
}

/**
 * How to start the Shopify CLI: [file, args]. Uses `<node> <cli's run.js> …args` whenever it can,
 * and only falls back to starting the launcher itself.
 */
export function shopifyCommand(args) {
  const bin = isAbsolute(SHOPIFY_BIN) ? SHOPIFY_BIN : findIn(SHOPIFY_BIN, env.PATH);
  if (bin) {
    let real = bin;
    try { real = realpathSync(bin); } catch {}
    const entry = jsEntryFor(real) || jsEntryFor(bin);
    const node = entry && nodeFor(bin);
    if (entry && node) return [node, [resolve(entry), ...args]];
  }
  return [SHOPIFY_BIN, args];
}

/** Slow path (macOS/Linux), asynchronous: ask the login shell for its PATH, then cache it. Resolves true if found. */
export function findShopifyViaLoginShell({ timeoutMs = 20_000 } = {}) {
  if (WIN) return Promise.resolve(false);
  const shell = env.SHELL || "/bin/zsh";
  return new Promise((resolveFound) => {
    execFile(shell, ["-ilc", 'printf "__SHOPHOP_PATH__%s__END__" "$PATH"'], { encoding: "utf8", timeout: timeoutMs }, (err, stdout) => {
      const shellPath = stdout?.match(/__SHOPHOP_PATH__(.*)__END__/s)?.[1];
      if (!shellPath || !findIn(SHOPIFY_BIN, shellPath)) return resolveFound(false);
      prependPath(...shellPath.split(delimiter));
      writeCache({ path: shellPath, savedAt: new Date().toISOString() });
      resolveFound(true);
    });
  });
}
