// shop_copy_companies: export → dry run → (production approval) → apply in batches.
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveShop } from "../../core/shops.js";
import { productionCopyBlock } from "../../core/approvals.js";
import { startBulk, checkBulk } from "../../shopify/bulk.js";
import { COMPANIES_BULK_QUERY, parseCompaniesJsonl, planCompanies, summarizePlan, applyPlan } from "../../features/copy-companies.js";
import { DATA_DIR } from "../../settings.js";
import { text, fail, tagProd, cliError } from "../respond.js";

const DESCRIPTION = [
  "Copy B2B companies from one store to another: locations (addresses, tax and checkout settings, payment terms), contacts, main contact and roles.",
  "Step 1, no exportFile: exports the source's companies. If that takes over ~40 s, poll shop_bulk_status (name 'companies'), then call again with exportFile.",
  "Step 2, apply false (default): dry run. Reads the target and returns the plan: what gets created, contacts that reuse existing customers, skips and warnings. Nothing is written. Show it to the user.",
  "Step 3, apply true, only after the user confirms: creates up to `batch` companies per call. Call again until `remaining` is 0. Re-runs never duplicate; companies already in the target (same name or externalId) are skipped, not merged.",
  "The target must allow edits. Copying INTO a production store also needs the user's approval of that exact copy in the Shop Manager; the dry run files the request. Never approve it yourself.",
  "Not copied: catalogs/price lists, staff assignments, metafields, orders, store credit, deposits. For big copies the user can run `shophop copy-companies <from> <to> --apply` in a terminal.",
].join(" ");

/** Export the source's companies. Returns { file } or { reply } when it isn't ready yet. */
async function exportCompanies(from) {
  const started = await startBulk(from, COMPANIES_BULK_QUERY, {});
  if (!started.ok) return { reply: cliError(from, started.error) };
  const r = await checkBulk(from, started.gid, { dataDir: DATA_DIR, name: "companies", waitSeconds: 40 });
  if (r.state === "COMPLETED") return { file: r.file };
  if (r.state === "ERROR") return { reply: cliError(from, r.error) };
  return { reply: text({ step: "export", state: r.state, operationId: r.operationId,
    next: `Poll shop_bulk_status (shop "${from.alias}", operationId "${r.operationId}", name "companies") until COMPLETED, then call shop_copy_companies again with exportFile set to the returned file.` }) };
}

export function registerCopyTools(server) {
  server.registerTool(
    "shop_copy_companies",
    {
      title: "Copy B2B companies between stores",
      description: DESCRIPTION,
      inputSchema: {
        from: z.string().describe("Source store short name"),
        to: z.string().describe("Target store short name"),
        exportFile: z.string().optional().describe("JSONL from the source's companies export"),
        apply: z.boolean().optional().describe("false (default) = dry run only"),
        only: z.array(z.string()).optional().describe("Copy only these company names"),
        batch: z.number().int().min(1).max(25).optional().describe("Companies per apply call, default 10"),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ from: fromRef, to: toRef, exportFile, apply = false, only, batch = 10 }) => {
      let from, to;
      try { [from, to] = await Promise.all([resolveShop(fromRef), resolveShop(toRef)]); } catch (e) { return fail(e.message); }
      if (from.store === to.store) return fail("Source and target are the same store.");

      if (!exportFile) {
        const exported = await exportCompanies(from);
        if (exported.reply) return exported.reply;
        exportFile = exported.file;
      }

      let plan;
      try {
        const companies = await parseCompaniesJsonl(exportFile);
        plan = await planCompanies({ from, to, companies, dataDir: DATA_DIR, only });
      } catch (e) { return tagProd(to, fail(`Could not build the copy plan: ${e.message}`, { details: e.details })); }

      const planFile = join(DATA_DIR, to.alias, `plan-companies-from-${from.alias}.json`);
      await mkdir(join(DATA_DIR, to.alias), { recursive: true });
      await writeFile(planFile, JSON.stringify(plan, null, 2));
      const summary = summarizePlan(plan);
      const approvalNeeded = await productionCopyBlock({ kind: "companies", from, to, exportFile, only, summary });

      if (!apply) {
        const before = [];
        if (!to.writable) before.push(`${to.alias} doesn't allow edits yet; the user can change that in the Shop Manager.`);
        if (approvalNeeded) before.push(`${to.alias} is PRODUCTION: the user must approve request ${approvalNeeded.id} in the Shop Manager. Never approve it yourself.`);
        return tagProd(to, text({
          step: "dry run (nothing written)", from: from.alias, to: to.alias, exportFile, planFile, summary,
          ...(to.production && { productionApproval: approvalNeeded ? { state: "needed", requestId: approvalNeeded.id } : { state: "approved" } }),
          next: `Show this plan to the user. ${before.join(" ")} If they confirm, call again with the same from/to/exportFile and apply: true.`,
        }));
      }

      if (!to.writable) return tagProd(to, fail(`${to.alias} doesn't allow edits. Nothing was written. The user can change that in the Shop Manager (open_shop_manager).`));
      if (approvalNeeded) return tagProd(to, fail(approvalNeeded.message, { requestId: approvalNeeded.id }));

      const result = await applyPlan({ to, plan, batch });
      return tagProd(to, text({
        step: "apply", from: from.alias, to: to.alias, exportFile, ...result, summaryBefore: summary,
        next: result.remaining > 0
          ? `Call again with the same arguments to continue (${result.remaining} companies not tried yet).`
          : result.failed.length
            ? `Finished, but ${result.failed.length} compan${result.failed.length === 1 ? "y" : "ies"} failed: ${result.failed.join(", ")}. Tell the user why (see results). After the cause is fixed, calling again retries only those; nothing is duplicated.`
            : "Done. Re-running skips everything already copied.",
      }));
    },
  );
}
