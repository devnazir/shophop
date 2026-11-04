import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve, parse } from "node:path";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

const SETTINGS = new URL("../src/settings.js", import.meta.url).href;
// Load settings.js in a fresh process with the given env and working folder, return the values.
function settingsWith(env, cwd = process.cwd()) {
  const code = `const s = await import(${JSON.stringify(SETTINGS)}); console.log(JSON.stringify({ bin: s.SHOPIFY_BIN, api: s.API_VERSION ?? null, data: s.DATA_DIR }));`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: { HOME: homedir(), PATH: process.env.PATH, ...env }, cwd, encoding: "utf8" }));
}

test("empty and unfilled ${...} values from Claude Desktop count as unset", () => {
  const root = parse(process.cwd()).root; // "/" or e.g. "C:\\"
  const s = settingsWith({ SHOPIFY_BIN: "${user_config.shopify_cli}", SHOPHOP_API_VERSION: "", SHOPHOP_DATA_DIR: "  " }, root);
  assert.equal(s.bin, "shopify");
  assert.equal(s.api, null);
  assert.equal(s.data, join(homedir(), "shophop-data"), "started in a drive's root folder, so exports go to ~/shophop-data");
});

test("real values are used as given", () => {
  const s = settingsWith({ SHOPIFY_BIN: "/opt/bin/shopify", SHOPHOP_API_VERSION: "2026-10", SHOPHOP_DATA_DIR: "/tmp/exports" });
  assert.deepEqual(s, { bin: "/opt/bin/shopify", api: "2026-10", data: resolve("/tmp/exports") });
});

test("the extension's fallback folder is used when no folder is set", () => {
  const s = settingsWith({ SHOPHOP_DATA_DIR: "${user_config.data_dir}", SHOPHOP_DEFAULT_DATA_DIR: join(homedir(), "x-data") }, parse(process.cwd()).root);
  assert.equal(s.data, join(homedir(), "x-data"));
});

test("inside a project folder, exports default to ./shopify-data", () => {
  const dir = realpathSync(tmpdir()); // macOS: /tmp is really /private/tmp
  const s = settingsWith({}, dir);
  assert.equal(s.data, join(dir, "shopify-data"));
});
