// shophop copy-companies <from> <to> [--file f] [--only "A,B"] [--apply] [--batch 10]
import { resolveShop } from "../core/shops.js";
import { productionCopyBlock } from "../core/approvals.js";
import { startBulk, checkBulk } from "../shopify/bulk.js";
import { COMPANIES_BULK_QUERY, parseCompaniesJsonl, planCompanies, summarizePlan, applyPlan } from "../features/copy-companies.js";
import { DATA_DIR } from "../settings.js";

const USAGE = 'Usage: shophop copy-companies <from> <to> [--file export.jsonl] [--only "Acme,Globex"] [--apply] [--batch 10]\nWithout --apply it only prints the plan.';
const die = (msg) => { console.error(msg); process.exit(1); };

function parseArgs(args) {
  const valueFlags = ["--file", "--only", "--batch"];
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const positional = args.filter((a, i) => !a.startsWith("--") && !valueFlags.includes(args[i - 1]));
  return {
    from: positional[0], to: positional[1],
    file: flag("--file"),
    only: flag("--only")?.split(",").map((s) => s.trim()).filter(Boolean),
    batch: Number(flag("--batch")) || 10,
    apply: args.includes("--apply"),
  };
}

async function exportCompanies(from) {
  process.stdout.write(`Exporting companies from ${from.alias}…`);
  const started = await startBulk(from, COMPANIES_BULK_QUERY, {});
  if (!started.ok) die(`\n${started.error?.message}\n${JSON.stringify(started.error?.details ?? "", null, 2)}`);
  for (;;) {
    const r = await checkBulk(from, started.gid, { dataDir: DATA_DIR, name: "companies", waitSeconds: 30 });
    if (r.state === "COMPLETED") { console.log(` done (${r.lines} rows) → ${r.file}`); return r.file; }
    if (!["CREATED", "RUNNING", "CANCELING"].includes(r.state)) die(`\nExport ${r.state}: ${JSON.stringify(r.error ?? r.errorCode)}`);
    process.stdout.write(".");
  }
}

export async function run(args) {
  const opts = parseArgs(args);
  if (!opts.to) { console.log(USAGE); process.exit(2); }
  const [from, to] = await Promise.all([resolveShop(opts.from), resolveShop(opts.to)]).catch((e) => die(e.message));
  if (from.store === to.store) die("Source and target are the same store.");

  const file = opts.file || await exportCompanies(from);
  const companies = await parseCompaniesJsonl(file);
  const plan = await planCompanies({ from, to, companies, dataDir: DATA_DIR, only: opts.only }).catch((e) => die(`Could not read ${to.alias}: ${e.message}`));
  const summary = summarizePlan(plan);
  console.log(`\n${to.production ? "⚠ PRODUCTION target. " : ""}Plan ${from.alias} → ${to.alias}:`);
  console.log(JSON.stringify(summary, null, 2));

  const approvalNeeded = await productionCopyBlock({ kind: "companies", from, to, exportFile: file, only: opts.only, summary });
  if (!opts.apply) {
    console.log("\nDry run only. Nothing was written. Add --apply to copy.");
    if (approvalNeeded) console.log(`\n⚠ ${to.alias} is PRODUCTION. Approve request ${approvalNeeded.id} in the Shop Manager (shophop ui) first, then re-run with --apply --file ${file}`);
    return;
  }
  if (!to.writable) die(`\n${to.alias} doesn't allow edits. Change that in the Shop Manager first.`);
  if (approvalNeeded) die(`\n${to.alias} is PRODUCTION. Approve request ${approvalNeeded.id} in the Shop Manager (shophop ui), then re-run with --file ${file}`);

  let current = plan;
  for (;;) {
    const r = await applyPlan({ to, plan: current, batch: opts.batch, source: "cli" });
    for (const x of r.results) {
      console.log(`${x.ok ? "✓" : "✗"} ${x.name}${x.ok ? `  (${x.locations} locations, ${x.contacts} contacts)` : `  ${x.error}`}${x.warning ? `  ⚠ ${x.warning}` : ""}`);
    }
    if (r.remaining === 0) {
      if (r.failed.length) console.log(`\n${r.failed.length} failed: ${r.failed.join(", ")}. Fix the cause and run the same command again to retry only those.`);
      console.log(`\nID map: ${r.idmapFile}`);
      if (r.failed.length) process.exitCode = 1;
      return;
    }
    current = await planCompanies({ from, to, companies, dataDir: DATA_DIR, only: opts.only });
  }
}
