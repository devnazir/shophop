// Thin wrapper around the Shopify CLI `store` commands.
// Never uses a shell: args are passed as an array. The GraphQL document and its variables go through
// private temp files, never the command line, where other local users could see them (`ps`) and where
// Windows limits the length.
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { API_VERSION as DEFAULT_VERSION, TESTED_CLI } from "../settings.js";
import { shopifyCommand } from "./env.js";

function run(cliArgs, { timeoutMs = 120_000 } = {}) {
  const [file, args] = shopifyCommand(cliArgs);
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } },
      (err, stdout, stderr) => {
        resolve({ code: err ? (err.code ?? 1) : 0, killed: err?.killed ?? false, stdout, stderr });
      },
    );
  });
}

// Pull the JSON object or array out of stdout. The CLI prints one JSON value, but other lines can appear
// around it (e.g. an "update available" notice). Only a whole object/array counts: a stray scalar line from
// inside a pretty-printed payload must never be mistaken for the result.
function extractJson(text) {
  try { return { value: JSON.parse(text) }; } catch {}
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^[{[]/.test(l.trimStart()));
  if (start >= 0) {
    const closer = lines[start].trimStart()[0] === "{" ? "}" : "]";
    for (let end = lines.length - 1; end >= start; end--) {
      if (lines[end].trimEnd().endsWith(closer)) {
        try { return { value: JSON.parse(lines.slice(start, end + 1).join("\n")) }; } catch {}
      }
    }
  }
  return null;
}

// stdout holds either the result JSON or {"error": {...}}; progress events go to stderr.
export function parseOutput({ code, killed, stdout, stderr = "" }) {
  if (killed) return { ok: false, error: { message: "Shopify CLI timed out" } };
  const text = stdout.trim();
  const parsed = text ? extractJson(text) : { value: null };
  const json = parsed?.value;
  if (json && typeof json === "object" && !Array.isArray(json) && json.error) return { ok: false, error: json.error };
  if (code !== 0) {
    return { ok: false, error: { message: `Shopify CLI exited with ${code}`, stdout: text.slice(0, 2000), stderr: stderr.slice(-2000) } };
  }
  if (!parsed || (json !== null && typeof json !== "object")) {
    return { ok: false, error: { message: "Couldn't read the Shopify CLI's output", stdout: text.slice(0, 2000) } };
  }
  return { ok: true, data: json };
}

// Write files to a fresh private temp folder, run fn with their paths, then delete the folder.
async function withTempFiles(files, fn) {
  const dir = await mkdtemp(join(tmpdir(), "shophop-"));
  try {
    const paths = {};
    for (const [name, content] of Object.entries(files)) {
      paths[name] = join(dir, name);
      await writeFile(paths[name], content, { encoding: "utf8", mode: 0o600 });
    }
    return await fn(paths);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function authList() {
  const res = parseOutput(await run(["store", "auth", "list", "--json", "--no-input"]));
  if (!res.ok) return res;
  return { ok: true, data: res.data?.sessions ?? [] };
}

export async function execute(store, query, { variables, version = DEFAULT_VERSION, allowMutations = false } = {}) {
  const hasVars = variables && Object.keys(variables).length > 0;
  const files = { "op.graphql": query, ...(hasVars && { "variables.json": JSON.stringify(variables) }) };
  return withTempFiles(files, async (p) => {
    const args = ["store", "execute", "-s", store, "--query-file", p["op.graphql"], "--json", "--no-input"];
    if (hasVars) args.push("--variable-file", p["variables.json"]);
    if (version) args.push("--version", version);
    if (allowMutations) args.push("--allow-mutations");
    return parseOutput(await run(args));
  });
}

// Start a bulk *query* (never --allow-mutations) and return right away with the operation.
export async function bulkStart(store, query, { version = DEFAULT_VERSION } = {}) {
  return withTempFiles({ "bulk.graphql": query }, async (p) => {
    const args = ["store", "bulk", "execute", "-s", store, "--query-file", p["bulk.graphql"], "--json", "--no-input"];
    if (version) args.push("--version", version);
    return parseOutput(await run(args));
  });
}

// Status of one bulk operation: { operationGid, operation: { status, objectCount, url, partialDataUrl, errorCode, ... } }
export async function bulkStatus(store, id) {
  return parseOutput(await run(["store", "bulk", "status", "-s", store, "--id", id, "--json", "--no-input"]));
}

let versionCache;
export async function cliVersion() {
  if (versionCache) return versionCache;
  const r = await run(["version"], { timeoutMs: 20_000 });
  const v = (r.stdout.match(/(\d+)\.(\d+)\.(\d+)/) || [])[0];
  let warning;
  if (!v) warning = "Could not find the Shopify CLI. Install it with `npm install -g @shopify/cli`, or set its path (`which shopify`) in shophop's settings.";
  else {
    const [maj, min] = v.split(".").map(Number);
    if (maj !== TESTED_CLI.major || min < TESTED_CLI.minMinor) {
      warning = `Shopify CLI ${v} is untested with shophop (tested: ${TESTED_CLI.label}). The 'shopify store' commands or their JSON output may differ.`;
    }
  }
  const result = { version: v || null, tested: TESTED_CLI.label, ...(warning && { warning }) };
  if (v) versionCache = result; // don't remember a failure: PATH may still be fixed in the background
  return result;
}

export function authCommand(store, scopes) {
  return `shopify store auth -s ${store} --scopes ${scopes || "<comma-separated scopes>"}`;
}
