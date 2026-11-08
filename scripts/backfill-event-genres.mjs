import { appendFileSync, chmodSync, closeSync, existsSync, lstatSync, openSync, readFileSync, truncateSync, unlinkSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolveEventGenresBatch } from "../lib/ai/resolve-event-genres.ts";

const { values } = parseArgs({ options: {
  journal: { type: "string" },
  concurrency: { type: "string", default: "2" },
  limit: { type: "string" },
  "scan-only": { type: "boolean", default: false },
} });
const journal = values.journal;
const concurrency = Number(values.concurrency);
const limit = values.limit === undefined ? Infinity : Number(values.limit);
const batchSize = 12;
const origin = new URL(process.env.EVENTZEKA_BACKFILL_CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL || "invalid").origin;
const serviceSecret = process.env.CRON_SECRET;
if (!journal || !serviceSecret || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4 ||
  (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 1))) throw new Error("Invalid genre backfill configuration.");
if (!values["scan-only"] && !process.env.OPENAI_API_KEY) throw new Error("Missing OpenAI credentials for genre backfill.");

const lockPath = `${journal}.lock`;
const lock = openSync(lockPath, "wx", 0o600);
const candidates = new Map();
const outcomes = new Map();
const applied = new Map();
const methods = new Set(["instagram", "announcement", "estimate", "web", "unknown"]);
let cursor = null;
let scanComplete = false;
let searchCalls = 0;
let stop = false;
const stopAfterBatch = () => { stop = true; };
process.once("SIGTERM", stopAfterBatch);
process.once("SIGINT", stopAfterBatch);

function save(record) {
  appendFileSync(journal, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function accept(record) {
  if (record.kind === "page") {
    if (scanComplete || record.from !== cursor || (record.to !== null && (typeof record.to !== "string" || record.to === cursor))) {
      throw new Error("Invalid backfill page checkpoint.");
    }
    for (const event of record.events) {
      if (typeof event.key !== "string" || candidates.has(event.key)) throw new Error("Duplicate or invalid backfill event.");
      candidates.set(event.key, event);
    }
    cursor = record.to;
    scanComplete = cursor === null;
  } else if (record.kind === "outcomes") {
    searchCalls += record.searchCalls;
    for (const row of record.rows) {
      const event = candidates.get(row.eventId);
      if (!event || outcomes.has(row.eventId) || event.expectedUpdatedAt !== row.expectedUpdatedAt || !methods.has(row.method) || row.deferred) {
        throw new Error("Invalid backfill outcome checkpoint.");
      }
      outcomes.set(row.eventId, { model: record.model, row });
    }
  } else if (record.kind === "applied") {
    for (const id of record.ids) {
      if (applied.has(id) || outcomes.get(id)?.row.method !== record.method) throw new Error("Invalid backfill write checkpoint.");
      applied.set(id, record);
    }
  } else {
    throw new Error("Unknown backfill checkpoint.");
  }
}

function checkpoint(record) {
  save(record);
  accept(record);
}

function load() {
  if (!existsSync(journal)) {
    const header = { kind: "snapshot", version: 1, origin, cutoff: Date.now() };
    appendFileSync(journal, `${JSON.stringify(header)}\n`, { flag: "wx", mode: 0o600 });
    return header.cutoff;
  }
  if (!lstatSync(journal).isFile()) throw new Error("Backfill journal must be a regular file.");
  chmodSync(journal, 0o600);
  const data = readFileSync(journal);
  const end = data.lastIndexOf(10);
  if (end < 0) throw new Error("Backfill journal has no complete header.");
  const [header, ...records] = data.subarray(0, end).toString("utf8").split("\n").map((line) => JSON.parse(line));
  if (header.kind !== "snapshot" || header.version !== 1 || header.origin !== origin || !Number.isSafeInteger(header.cutoff)) {
    throw new Error("Backfill journal belongs to a different deployment or protocol.");
  }
  for (const record of records) accept(record);
  if (end < data.length - 1) truncateSync(journal, end + 1);
  return header.cutoff;
}

async function convex(operation, name, args) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${origin}/api/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: `eventDiscovery:${name}`, args: { serviceSecret, ...args }, format: "json" }),
        signal: AbortSignal.timeout(25_000),
      });
      if (response.ok) {
        const result = await response.json();
        if (result.status === "success") return result.value;
      }
      if (response.status < 500 && response.status !== 429) throw new Error("Convex rejected the genre backfill request.");
      if (attempt >= 3) throw new Error("Convex genre backfill request failed.");
    } catch (error) {
      if (attempt >= 3 || error.message === "Convex rejected the genre backfill request.") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
}

function progress(selected) {
  const selectedIds = new Set(selected.map(({ key }) => key));
  const totals = { written: 0, unchanged: 0, stale: 0 };
  const byMethod = Object.fromEntries([...methods].map((method) => [method, { resolved: 0, written: 0 }]));
  for (const id of selectedIds) {
    const method = outcomes.get(id)?.row.method;
    if (method) byMethod[method].resolved++;
  }
  const writes = new Set([...selectedIds].map((id) => applied.get(id)).filter(Boolean));
  for (const receipt of writes) {
    for (const key of Object.keys(totals)) totals[key] += receipt.counts[key];
    byMethod[receipt.method].written += receipt.counts.written;
  }
  const completed = [...selectedIds].filter((id) => applied.has(id)).length;
  console.log(JSON.stringify({ phase: "progress", scanned: candidates.size, selected: selected.length, completed,
    remaining: selected.length - completed, searchCalls, byMethod, ...totals }));
  return completed;
}

async function applyRows(cutoff, rows) {
  const groups = new Map();
  for (const { model, row } of rows) {
    if (applied.has(row.eventId)) continue;
    const key = JSON.stringify([model, row.method]);
    const group = groups.get(key) ?? { model, method: row.method, results: [] };
    const { method: _method, deferred: _deferred, ...result } = row;
    group.results.push(result);
    groups.set(key, group);
  }
  for (const { model, method, results } of groups.values()) {
    for (let start = 0; start < results.length; start += batchSize) {
      const batch = results.slice(start, start + batchSize);
      const counts = await convex("mutation", "recordUnknownGenreBatch", { cutoff, model, results: batch });
      if ([counts.written, counts.unchanged, counts.stale].some((value) => !Number.isSafeInteger(value) || value < 0) ||
        counts.written + counts.unchanged + counts.stale !== batch.length) throw new Error("Invalid genre backfill write receipt.");
      checkpoint({ kind: "applied", method, counts, ids: batch.map(({ eventId }) => eventId) });
    }
  }
}

try {
  const cutoff = load();
  while (!scanComplete && !stop) {
    const page = await convex("query", "listUnknownGenreInputs", { cutoff, cursor });
    checkpoint({ kind: "page", from: cursor, to: page.cursor, events: page.events });
  }
  if (!scanComplete) {
    process.exitCode = 1;
  } else {
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Belgrade" }).format(cutoff);
    const selected = [...candidates.values()].sort((a, b) =>
      Number(a.date < today) - Number(b.date < today) || (a.date < today ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date)),
    ).slice(0, limit);
    if (values["scan-only"]) {
      console.log(JSON.stringify({ phase: "scan", candidates: candidates.size, upcoming: selected.filter(({ date }) => date >= today).length,
        withCaption: selected.filter(({ sourceCaption }) => Boolean(sourceCaption)).length }));
    } else {
      await applyRows(cutoff, selected.flatMap(({ key }) => outcomes.has(key) ? [outcomes.get(key)] : []));
      progress(selected);
      for (let pass = 0; pass < 3 && !stop; pass++) {
        const pending = selected.filter(({ key }) => !outcomes.has(key));
        if (!pending.length) break;
        let next = 0;
        const workers = Array.from({ length: concurrency }, async () => {
          while (!stop && next < pending.length) {
            const batch = pending.slice(next, next + batchSize);
            next += batchSize;
            let resolved;
            try {
              resolved = await resolveEventGenresBatch(batch, { deadlineAt: Date.now() + 220_000 });
            } catch (error) {
              console.log(JSON.stringify({ phase: "provider-deferred", size: batch.length, status: error.status }));
              if ([400, 401, 403].includes(error.status) || /blocked|quota/i.test(error.code ?? "")) stop = true;
              continue;
            }
            const rows = resolved.results.filter(({ deferred }) => !deferred);
            checkpoint({ kind: "outcomes", model: resolved.model, rows, searchCalls: resolved.searchCalls });
            await applyRows(cutoff, rows.map((row) => ({ model: resolved.model, row })));
            progress(selected);
          }
        });
        const settled = await Promise.allSettled(workers);
        const failed = settled.find(({ status }) => status === "rejected");
        if (failed) throw failed.reason;
      }
      if (progress(selected) !== selected.length) process.exitCode = 1;
    }
  }
} finally {
  process.removeListener("SIGTERM", stopAfterBatch);
  process.removeListener("SIGINT", stopAfterBatch);
  closeSync(lock);
  unlinkSync(lockPath);
}
