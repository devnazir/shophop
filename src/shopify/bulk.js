// Async bulk exports: start → poll → download. Stateless: everything is keyed by the
// Shopify operation ID, so a restart of Claude Code or this server loses nothing.
import { createWriteStream, createReadStream } from "node:fs";
import { mkdir, stat, rename } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { bulkStart, bulkStatus } from "./cli.js";

const DONE = new Set(["COMPLETED", "FAILED", "CANCELED", "CANCELLED", "EXPIRED"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const numericId = (gid) => String(gid).split("/").pop();

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

// Line count + first few parsed rows, streamed so big files don't load into memory.
async function summarize(file, previewRows = 3) {
  const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  let lines = 0;
  const preview = [];
  for await (const line of rl) {
    if (!line) continue;
    lines++;
    if (preview.length < previewRows) { try { preview.push(JSON.parse(line)); } catch {} }
  }
  return { lines, preview };
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const tmp = `${file}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  await rename(tmp, file);
}

export function exportFile(dataDir, shop, gid, name = "export") {
  return join(dataDir, shop.alias, `${name}-${numericId(gid)}.jsonl`);
}

// Check once (or wait up to waitSeconds), download when complete. Returns a plain result object.
export async function checkBulk(shop, gid, { dataDir, name, waitSeconds = 0 }) {
  const deadline = Date.now() + waitSeconds * 1000;
  const file = exportFile(dataDir, shop, gid, name);
  if (await exists(file)) return { state: "COMPLETED", file, ...(await summarize(file)), note: "Already downloaded." };

  for (;;) {
    const res = await bulkStatus(shop.store, gid);
    if (!res.ok) return { state: "ERROR", error: res.error };
    const op = res.data?.operation;
    if (!op) return { state: "ERROR", error: { message: `No bulk operation ${gid} on ${shop.store}. Operations are kept for about a week.` } };

    if (op.status === "COMPLETED") {
      await mkdir(join(dataDir, shop.alias), { recursive: true });
      if (op.url) await download(op.url, file);
      else await pipeline(Readable.from([]), createWriteStream(file)); // zero results → empty file
      return { state: "COMPLETED", operationId: gid, objectCount: Number(op.objectCount), file, ...(await summarize(file)) };
    }
    if (DONE.has(op.status)) {
      const out = { state: op.status, operationId: gid, errorCode: op.errorCode, objectCount: Number(op.objectCount) };
      if (op.partialDataUrl) {
        const partial = file.replace(/\.jsonl$/, ".partial.jsonl");
        await mkdir(join(dataDir, shop.alias), { recursive: true });
        await download(op.partialDataUrl, partial);
        Object.assign(out, { partialFile: partial, ...(await summarize(partial)) });
      }
      return out;
    }
    if (Date.now() >= deadline) {
      return { state: op.status, operationId: gid, objectCount: Number(op.objectCount), createdAt: op.createdAt };
    }
    await sleep(Math.min(3000, Math.max(250, deadline - Date.now())));
  }
}

export async function startBulk(shop, query, { apiVersion }) {
  const res = await bulkStart(shop.store, query, { version: apiVersion });
  if (!res.ok) return { ok: false, error: res.error };
  const op = res.data?.operation;
  if (!op?.gid) return { ok: false, error: { message: "Shopify CLI did not return a bulk operation ID", details: res.data } };
  return { ok: true, gid: op.gid, status: op.status };
}
