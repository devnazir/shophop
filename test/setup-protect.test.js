import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { protectionRules, applyProtection } from "../src/commands/setup-protect.js";

const rules = protectionRules({ stateDirs: [join(homedir(), ".config", "shophop")], tokenDir: join(homedir(), "Library", "Preferences", "shopify-cli-store-nodejs") });

test("rules use ~ paths for folders in the home folder", () => {
  assert.deepEqual(rules.deny, [
    "Edit(~/.config/shophop/**)",
    "Read(~/Library/Preferences/shopify-cli-store-nodejs/**)",
    "Edit(~/Library/Preferences/shopify-cli-store-nodejs/**)",
  ]);
  assert.match(rules.hardDeny[0], /~\/\.config\/shophop\//);
  if (process.platform !== "win32") {
    assert.equal(protectionRules({ stateDirs: ["/srv/shophop"], tokenDir: "/srv/t" }).deny[0], "Edit(//srv/shophop/**)");
  }
});

test("adds rules to empty settings, with $defaults first", () => {
  const { settings } = applyProtection({}, rules);
  assert.deepEqual(settings.permissions.deny, rules.deny);
  assert.deepEqual(settings.autoMode.hard_deny, ["$defaults", ...rules.hardDeny]);
});

test("keeps the user's own rules and settings, and doesn't add $defaults to a list that had none", () => {
  const mine = { theme: "dark", permissions: { allow: ["Bash(npm *)"], deny: ["Bash(rm -rf *)"] }, autoMode: { hard_deny: ["No deploys"], environment: ["x"] } };
  const { settings } = applyProtection(mine, rules);
  assert.equal(settings.theme, "dark");
  assert.deepEqual(settings.permissions.allow, ["Bash(npm *)"]);
  assert.deepEqual(settings.permissions.deny, ["Bash(rm -rf *)", ...rules.deny]);
  assert.deepEqual(settings.autoMode.hard_deny, ["No deploys", ...rules.hardDeny]);
  assert.deepEqual(settings.autoMode.environment, ["x"]);
});

test("running twice changes nothing and older shophop wording is replaced, not duplicated", () => {
  const once = applyProtection({ autoMode: { hard_deny: ["$defaults", "Old wording about ~/.config/shophop/ files"] } }, rules).settings;
  assert.deepEqual(once.autoMode.hard_deny, ["$defaults", ...rules.hardDeny]);
  const twice = applyProtection(once, rules);
  assert.equal(twice.changed, false);
});

test("--remove takes out only shophop's rules", () => {
  const mine = { permissions: { deny: ["Bash(rm -rf *)"] }, autoMode: { hard_deny: ["$defaults", "No deploys"] } };
  const added = applyProtection(mine, rules).settings;
  const { settings } = applyProtection(added, rules, { remove: true });
  assert.deepEqual(settings, mine);
});

test("the command writes the file, backs it up once, and is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "shophop-protect-"));
  const file = join(dir, "settings.json");
  writeFileSync(file, JSON.stringify({ theme: "dark" }));
  const BIN = fileURLToPath(new URL("../bin/shophop.js", import.meta.url));
  const run = (...a) => execFileSync(process.execPath, [BIN, "setup", "protect", ...a], { env: { ...process.env, CLAUDE_SETTINGS: file }, encoding: "utf8" });
  assert.match(run(), /Protected/);
  assert.ok(existsSync(`${file}.bak`));
  assert.equal(JSON.parse(readFileSync(`${file}.bak`, "utf8")).theme, "dark");
  assert.match(run(), /Already protected/);
  assert.match(run("--remove"), /Removed/);
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.permissions, undefined);
  assert.equal(after.theme, "dark");
});

test("a moved approvals file or audit log is protected too", () => {
  const r = protectionRules({ stateDirs: [join(homedir(), ".config", "shophop"), join(homedir(), "elsewhere")], tokenDir: join(homedir(), "t") });
  assert.ok(r.deny.includes("Edit(~/.config/shophop/**)"));
  assert.ok(r.deny.includes("Edit(~/elsewhere/**)"));
  assert.match(r.hardDeny[0], /~\/elsewhere\//);
});
