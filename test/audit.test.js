import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "shophop-audit-"));
process.env.SHOPHOP_AUDIT = join(dir, "audit.log");
process.env.SHOPHOP_AUDIT_KEEP_MONTHS = "2";
const { audit, readAudit, rotate, AUDIT_PATH } = await import("../src/core/audit.js");

const shop = { alias: "dev", store: "dev.myshopify.com", writable: true, user: "t@example.com" };
const m = 'mutation { tagsAdd(id: "1", tags: ["a"]) { userErrors { message } } }';

test("audit writes JSONL with mode 600 and reads newest first", async () => {
  await audit({ shop, mutation: m, outcome: "sent", data: { tagsAdd: { userErrors: [] } } });
  await audit({ shop, mutation: m, outcome: "sent", data: { tagsAdd: { userErrors: [{ message: "nope" }] } } });
  const e = await readAudit({ limit: 10 });
  assert.equal(e.length, 2);
  assert.equal(e[0].outcome, "userErrors");
  assert.equal(e[1].outcome, "sent");
  if (process.platform !== "win32") assert.equal(statSync(AUDIT_PATH).mode & 0o777, 0o600); // Windows has no Unix modes
});

test("rotate moves last month's log to an archive and keeps reading across files", async () => {
  const lastMonth = new Date(); lastMonth.setUTCDate(1); lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
  utimesSync(AUDIT_PATH, lastMonth, lastMonth);
  await audit({ shop, mutation: m, outcome: "refused", error: "store is read-only" });
  const files = readdirSync(dir).filter((f) => f.startsWith("audit"));
  assert.ok(files.includes(`audit-${lastMonth.toISOString().slice(0, 7)}.log`), files.join(","));
  const e = await readAudit({ limit: 10 });
  assert.deepEqual(e.map((x) => x.outcome), ["refused", "userErrors", "sent"]);
});

test("rotate keeps only the newest KEEP_MONTHS archives", async () => {
  for (const mth of ["2020-01", "2020-02", "2020-03"]) writeFileSync(join(dir, `audit-${mth}.log`), "{}\n");
  const old = new Date("2021-06-15T00:00:00Z");
  utimesSync(AUDIT_PATH, old, old);
  await rotate();
  const archives = readdirSync(dir).filter((f) => /^audit-\d{4}-\d{2}\.log$/.test(f)).sort();
  assert.equal(archives.length, 2, archives.join(","));
  assert.ok(!archives.includes("audit-2020-01.log"));
});
