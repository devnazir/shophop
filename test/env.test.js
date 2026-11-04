import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const ENV = new URL("../src/shopify/env.js", import.meta.url).href;
// Ask env.js (in a fresh process, since settings are read at import) how it would start the CLI.
function commandFor(shopifyBin) {
  const code = `const { shopifyCommand } = await import(${JSON.stringify(ENV)}); console.log(JSON.stringify(shopifyCommand(["version"])));`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, SHOPIFY_BIN: shopifyBin }, encoding: "utf8",
  }));
}
const dir = realpathSync(mkdtempSync(join(tmpdir(), "shophop-env-")));

test("npm on Windows: shopify.cmd is started as <node> node_modules/@shopify/cli/bin/run.js", () => {
  const prefix = join(dir, "npm");
  const runJs = join(prefix, "node_modules", "@shopify", "cli", "bin", "run.js");
  mkdirSync(dirname(runJs), { recursive: true });
  writeFileSync(runJs, "console.log('4.9.4')\n");
  writeFileSync(join(prefix, "shopify.cmd"), "@ECHO off\r\nnode \"%~dp0\\node_modules\\@shopify\\cli\\bin\\run.js\" %*\r\n");
  const [file, args] = commandFor(join(prefix, "shopify.cmd"));
  assert.match(file, /node(\.exe)?$/i, "a real Node runs it, not cmd.exe");
  assert.equal(args[0], runJs);
  assert.deepEqual(args.slice(1), ["version"]);
  assert.equal(execFileSync(file, args, { encoding: "utf8" }).trim(), "4.9.4", "and it actually runs");
});

test("a .js CLI (like the test stand-in) is started with Node on every platform", () => {
  const js = join(dir, "fake.js");
  writeFileSync(js, "console.log('ok')\n");
  const [file, args] = commandFor(js);
  assert.match(file, /node(\.exe)?$/i);
  assert.equal(execFileSync(file, args, { encoding: "utf8" }).trim(), "ok");
});
