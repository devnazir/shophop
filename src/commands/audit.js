// shophop audit [-n 20]
import { readAudit, AUDIT_PATH } from "../core/audit.js";

export async function run(args) {
  const i = args.indexOf("-n");
  const limit = (i >= 0 && Number(args[i + 1])) || 20;
  const entries = await readAudit({ limit });
  console.log(`audit: ${AUDIT_PATH}\n`);
  for (const e of entries.reverse()) {
    const why = e.userErrors ? `  ${e.userErrors.map((u) => u.message).join("; ")}` : e.error ? `  ${e.error}` : "";
    console.log(`${e.ts}  ${e.outcome.padEnd(10)} ${e.shop.padEnd(18)} ${e.fields.join(",")}${why}`);
  }
  if (!entries.length) console.log("No mutations logged yet.");
}
