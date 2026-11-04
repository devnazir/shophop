// Test helpers: an isolated temp environment with the fake Shopify CLI, and an MCP client for the server.
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const FIXTURES = join(ROOT, "test", "fixtures");

export function makeEnv({ config = {}, sessions = [], stores = {}, version = "4.9.4", ...extra } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "shophop-test-"));
  const stateFile = join(dir, "state.json");
  const configFile = join(dir, "shops.json");
  writeFileSync(stateFile, JSON.stringify({ sessions, stores, version, ...extra }));
  writeFileSync(configFile, JSON.stringify({ shops: config }));
  const env = {
    ...process.env,
    SHOPIFY_BIN: join(ROOT, "test", "fake-shopify.js"),
    FAKE_SHOPIFY_STATE: stateFile,
    SHOPHOP_CONFIG: configFile,
    SHOPHOP_DATA_DIR: join(dir, "data"),
    SHOPHOP_AUDIT: join(dir, "audit.log"),
    SHOPHOP_APPROVALS: join(dir, "approvals.json"),
  };
  return {
    dir, env, stateFile,
    state: () => {
      const st = JSON.parse(readFileSync(stateFile, "utf8"));
      try { st.calls = readFileSync(`${stateFile}.calls`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { st.calls = []; }
      return st;
    },
    setState: (fn) => { const s = JSON.parse(readFileSync(stateFile, "utf8")); fn(s); writeFileSync(stateFile, JSON.stringify(s)); },
    audit: () => { try { return readFileSync(env.SHOPHOP_AUDIT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
  };
}

export async function connect(env) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "bin", "shophop.js")], env, stderr: "ignore" }));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const texts = r.content.map((c) => c.text);
    let json;
    for (const t of texts) { try { json = JSON.parse(t); break; } catch {} }
    return { isError: !!r.isError, texts, json, all: texts.join("\n") };
  };
  return { client, call, close: () => client.close() };
}

export const session = (store, scopes = ["read_products"]) => ({ subdomain: store.split(".")[0], store, scopes, associatedUser: { email: "tester@example.com" } });
