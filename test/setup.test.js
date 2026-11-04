import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/shophop.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "shophop-setup-"));
const cfg = join(dir, "claude_desktop_config.json");
const run = (...args) => execFileSync(process.execPath, [BIN, "setup", "desktop", ...args], { env: { ...process.env, CLAUDE_DESKTOP_CONFIG: cfg }, encoding: "utf8" });
const read = () => JSON.parse(readFileSync(cfg, "utf8"));

test("adds shophop and keeps the user's other settings and servers", () => {
  writeFileSync(cfg, JSON.stringify({ preferences: { theme: "dark" }, mcpServers: { other: { command: "x" } } }));
  run("--data-dir", join(dir, "exports"));
  const c = read();
  assert.deepEqual(c.preferences, { theme: "dark" });
  assert.ok(c.mcpServers.other, "other servers untouched");
  assert.equal(c.mcpServers.shophop.command, process.execPath);
  assert.deepEqual(c.mcpServers.shophop.args, [BIN]);
  assert.equal(c.mcpServers.shophop.env.SHOPHOP_DATA_DIR, join(dir, "exports"));
  assert.equal(c.mcpServers.shophop.env.PATH, undefined, "no PATH needed any more");
  assert.ok(existsSync(`${cfg}.bak`), "backup made before the first change");
});

test("--remove takes shophop out again", () => {
  run("--remove");
  const c = read();
  assert.equal(c.mcpServers.shophop, undefined);
  assert.ok(c.mcpServers.other);
});
