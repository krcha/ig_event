import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  classifyEventDiscoveryBatch,
  EVENT_DISCOVERY_BATCH_LIMIT,
  EventDiscoveryProviderError,
  revalidateEventDiscoveryClassification,
} from "../lib/ai/classify-event-discovery.ts";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    output: { type: "string" },
    limit: { type: "string" },
    "batch-size": { type: "string" },
    concurrency: { type: "string" },
    replay: { type: "string" },
  },
});

function bounded(value, fallback, max) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new Error("Invalid numeric audit option.");
  return number;
}

const text = (value) => typeof value === "string" ? value : undefined;
if (!values.input || !values.output || values.input === values.output) {
  throw new Error("Specify distinct --input snapshot.json and --output private-results.jsonl.");
}

const snapshot = readFileSync(values.input);
const source = JSON.parse(snapshot);
if (!Array.isArray(source.rows) || !source.rows.length) throw new Error("The snapshot has no rows.");
const sourceHash = createHash("sha256").update(snapshot).digest("hex");
const limit = bounded(values.limit, source.rows.length, source.rows.length);
const batchSize = bounded(values["batch-size"], EVENT_DISCOVERY_BATCH_LIMIT, EVENT_DISCOVERY_BATCH_LIMIT);
const concurrency = bounded(values.concurrency, 3, 4);
const journal = values.output;
const header = { kind: "source", protocol: "event-discovery-v1", sourceHash, rows: source.rows.length };
const write = (record) => appendFileSync(journal, JSON.stringify(record) + "\n", { mode: 0o600 });

function projectRow(row, index) {
  return {
    key: index + 1,
    title: text(row.title) ?? "",
    venue: text(row.venue),
    description: text(row.description),
    occurrenceText: text(row.occurrenceText),
    sourceCaption: text(row.sourceCaption),
    artists: Array.isArray(row.artists) ? row.artists.filter((name) => typeof name === "string") : [],
  };
}

function assertSource(storedHeader) {
  if (storedHeader.protocol !== header.protocol || storedHeader.sourceHash !== sourceHash || storedHeader.rows !== header.rows) {
    throw new Error("Audit journal belongs to a different snapshot or protocol.");
  }
}

if (values.replay) {
  const previous = readFileSync(values.replay);
  const [priorHeader, ...records] = previous.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  assertSource(priorHeader);
  const seen = new Set();
  const revalidated = records.map((record) => {
    if (record.kind === "error") return record;
    if (record.kind !== "batch") throw new Error("Unexpected journal entry.");
    return {
      ...record,
      results: record.results.map((prior) => {
        if (!Number.isInteger(prior.key) || prior.key < 1 || prior.key > header.rows || seen.has(prior.key)) {
          throw new Error("Audit journal contains a duplicate or invalid row.");
        }
        seen.add(prior.key);
        return revalidateEventDiscoveryClassification(projectRow(source.rows[prior.key - 1], prior.key - 1), prior);
      }),
    };
  });
  if (seen.size !== source.rows.length) throw new Error("Complete the input audit before replay.");
  const replayHeader = { ...header, revalidatedFromSha256: createHash("sha256").update(previous).digest("hex") };
  writeFileSync(journal, [replayHeader, ...revalidated].map((entry) => JSON.stringify(entry) + "\n").join(""), {
    mode: 0o600, flag: "wx",
  });
  process.exit(0);
}

if (!existsSync(journal)) appendFileSync(journal, JSON.stringify(header) + "\n", { mode: 0o600, flag: "wx" });
chmodSync(journal, 0o600);
const saved = readFileSync(journal);
const endOfLastLine = saved.lastIndexOf(10);
if (endOfLastLine < 0) throw new Error("Invalid audit journal header.");
const [storedHeader, ...receipts] = saved.subarray(0, endOfLastLine + 1).toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
assertSource(storedHeader);
if (endOfLastLine < saved.length - 1) truncateSync(journal, endOfLastLine + 1);

const complete = new Set();
const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const models = new Set();
let providerAttempts = 0;
let errors = 0;
let stopped = false;
let batchesThisRun = 0;

function register(receipt) {
  providerAttempts += receipt.attempts ?? 0;
  if (receipt.kind === "error") {
    errors += 1;
    return;
  }
  if (receipt.kind !== "batch") throw new Error("Unexpected journal entry.");
  for (const item of receipt.results) {
    if (!Number.isInteger(item.key) || item.key < 1 || item.key > header.rows || complete.has(item.key)) {
      throw new Error("Audit journal contains a duplicate or invalid row.");
    }
    complete.add(item.key);
  }
  for (const tokenKind of Object.keys(usage)) usage[tokenKind] += receipt.usage[tokenKind];
  models.add(receipt.model);
}

for (const receipt of receipts) register(receipt);
const pending = source.rows.slice(0, limit).flatMap((row, index) => {
  const key = index + 1;
  return complete.has(key) ? [] : [projectRow(row, index)];
});

function progress() {
  console.log(JSON.stringify({
    reviewed: complete.size,
    selected: limit,
    snapshotRows: header.rows,
    usage,
    models: [...models],
    providerAttempts,
    errors,
  }));
}

let next = 0;
async function review() {
  while (!stopped && next < pending.length) {
    const batch = pending.slice(next, next + batchSize);
    next += batchSize;
    try {
      const receipt = { kind: "batch", ...await classifyEventDiscoveryBatch(batch) };
      write(receipt);
      register(receipt);
      batchesThisRun += 1;
      if (batchesThisRun % 5 === 0) progress();
    } catch (error) {
      const known = error instanceof EventDiscoveryProviderError;
      if (!known) throw error;
      const receipt = {
        kind: "error",
        rows: batch.map(({ key }) => key),
        code: error.code,
        status: error.status,
        attempts: error.attempts,
      };
      write(receipt);
      register(receipt);
      console.error(JSON.stringify(receipt));
      if (error.code === "provider blocked" || (error.status >= 400 && error.status < 408)) stopped = true;
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, review));
progress();
if (stopped || source.rows.slice(0, limit).some((_, index) => !complete.has(index + 1))) process.exitCode = 1;
