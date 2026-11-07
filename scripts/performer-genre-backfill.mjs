import { createHash } from "node:crypto";
import {
  appendFileSync, chmodSync, closeSync, existsSync, lstatSync, openSync, readFileSync, statSync, truncateSync, unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  PERFORMER_GENRE_RESEARCH_BATCH_LIMIT,
  researchPerformerGenresBatch,
} from "../lib/ai/research-performer-genres.ts";
import {
  canPublishPerformerGenreSource,
  PERFORMER_GENRE_RESEARCH_VERSION,
} from "../lib/taxonomy/performer-genre-research.ts";

const { values } = parseArgs({ options: {
  input: { type: "string" }, output: { type: "string" }, limit: { type: "string" }, concurrency: { type: "string" },
  thorough: { type: "boolean" },
} });
if (!values.input || !values.output || resolve(values.input) === resolve(values.output)) {
  throw new Error("Specify distinct --input candidate-array.json and --output private-research.jsonl files.");
}
const inputFile = resolve(values.input);
const journal = resolve(values.output);
const snapshot = readFileSync(inputFile);
const candidates = JSON.parse(snapshot);
const formats = new Set(["dj-set", "concert", "live-performance", "party", "live"]);
const text = (value) => typeof value === "string" && Boolean(value.trim());
function validCandidate(candidate) {
  return candidate && text(candidate.key) && text(candidate.title) && text(candidate.venue) &&
    typeof candidate.date === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(candidate.date) &&
    Number.isSafeInteger(candidate.expectedUpdatedAt) && candidate.expectedUpdatedAt >= 0 &&
    formats.has(candidate.format) && (candidate.city === undefined || text(candidate.city)) &&
    Array.isArray(candidate.acts) && candidate.acts.length >= 1 && candidate.acts.length <= 2 &&
    candidate.acts.every((act) => act && text(act.billedName) &&
      (act.billedHandle === undefined || text(act.billedHandle)) &&
      (act.titleOnly === undefined || typeof act.titleOnly === "boolean"));
}
if (!Array.isArray(candidates) || !candidates.every(validCandidate) ||
    new Set(candidates.map(({ key }) => key)).size !== candidates.length) {
  throw new Error("Input must be a JSON array of distinct, complete event candidates.");
}

function bounded(value, fallback, maximum) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error("Invalid numeric backfill option.");
  return number;
}
const concurrency = bounded(values.concurrency, 2, 4);
const limit = values.limit === undefined ? candidates.length : bounded(values.limit, candidates.length, candidates.length);
const selected = candidates.slice(0, limit);
const revisions = new Map(candidates.map(({ key, expectedUpdatedAt }) => [key, expectedUpdatedAt]));
const header = {
  kind: "source", protocol: `performer-genre-research-v${PERFORMER_GENRE_RESEARCH_VERSION}`,
  sourceHash: createHash("sha256").update(snapshot).digest("hex"), candidates: candidates.length,
  ...(values.thorough ? { thorough: true } : {}),
};
const lockPath = `${journal}.lock`;
const lock = openSync(lockPath, "wx", 0o600);
const completed = new Set();
let next = 0;
let attemptedBatches = 0;
let errors = 0;
let inferred = 0;
let searchCalls = 0;
let stopped = false;
const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const stop = () => { stopped = true; };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

function write(record) {
  appendFileSync(journal, JSON.stringify(record) + "\n", { mode: 0o600 });
}

function readJournal() {
  if (!existsSync(journal)) {
    appendFileSync(journal, JSON.stringify(header) + "\n", { mode: 0o600, flag: "wx" });
    return;
  }
  const outputStat = lstatSync(journal);
  const inputStat = statSync(inputFile);
  if (!outputStat.isFile() || (outputStat.dev === inputStat.dev && outputStat.ino === inputStat.ino)) {
    throw new Error("Output must be a distinct regular file.");
  }
  chmodSync(journal, 0o600);
  const saved = readFileSync(journal);
  const lastNewline = saved.lastIndexOf(10);
  if (lastNewline < 0) throw new Error("Output has no complete source record.");
  const [stored, ...records] = saved.subarray(0, lastNewline + 1).toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  if (stored.kind !== header.kind || stored.protocol !== header.protocol || stored.sourceHash !== header.sourceHash ||
      stored.candidates !== header.candidates || Boolean(stored.thorough) !== Boolean(values.thorough)) {
    throw new Error("Output belongs to a different candidate snapshot or protocol.");
  }
  for (const record of records) {
    if (record.kind === "error") continue;
    if (record.kind !== "result" || !revisions.has(record.eventId) ||
        revisions.get(record.eventId) !== record.expectedUpdatedAt || completed.has(record.eventId) ||
        !Array.isArray(record.matches) || typeof record.model !== "string" || typeof record.auditJson !== "string") {
      throw new Error("Output contains a duplicate or incompatible event record.");
    }
    completed.add(record.eventId);
    if (record.matches.length) inferred++;
  }
  if (lastNewline < saved.length - 1) truncateSync(journal, lastNewline + 1);
}

function recordEvent(candidate, acts, { model, responseId, searchCalls: batchSearchCalls }) {
  const matches = new Map();
  for (const act of acts) {
    const identityUrl = act.identityEvidence?.url;
    if (act.status !== "resolved" || !identityUrl || !canPublishPerformerGenreSource(identityUrl)) continue;
    for (const { genre, url } of act.genreEvidence) {
      const key = JSON.stringify([act.billedName, genre]);
      if (!matches.has(key) && canPublishPerformerGenreSource(url)) {
        matches.set(key, { url, performer: act.billedName, genre, identityUrl });
      }
    }
  }
  write({ kind: "result", eventId: candidate.key, expectedUpdatedAt: candidate.expectedUpdatedAt, model,
    matches: [...matches.values()], auditJson: JSON.stringify({ acts, responseId, searchCalls: batchSearchCalls }) });
  completed.add(candidate.key);
  if (matches.size) inferred++;
}

function progress() {
  console.log(JSON.stringify({ selected: selected.length, completed: selected.filter(({ key }) => completed.has(key)).length,
    journalCompleted: completed.size, inferred, errors, attemptedBatches, searchCalls, usage }));
}

async function run(pending) {
  while (!stopped && next < pending.length) {
    const inputs = [];
    const batch = [];
    while (next < pending.length && inputs.length + pending[next].acts.length <= PERFORMER_GENRE_RESEARCH_BATCH_LIMIT) {
      const candidate = pending[next++];
      const actKeys = candidate.acts.map((act) => {
        const key = inputs.length;
        inputs.push({ key, eventTitle: candidate.title, venue: candidate.venue, date: candidate.date,
          city: candidate.city, trustedFormat: candidate.format, ...act });
        return key;
      });
      batch.push({ candidate, actKeys });
      if (values.thorough) break;
    }
    attemptedBatches++;
    let response;
    try {
      response = await researchPerformerGenresBatch(inputs, { thorough: values.thorough });
    } catch (error) {
      errors += batch.length;
      const code = typeof error?.code === "string" && /^[a-z\d _/-]{1,80}$/iu.test(error.code) ? error.code : "research_failed";
      const status = Number.isInteger(error?.status) ? error.status : undefined;
      write({ kind: "error", eventIds: batch.map(({ candidate }) => candidate.key), code, status });
      if ([400, 401, 403, 404, 422].includes(status) || /blocked|budget/i.test(code)) stopped = true;
      progress();
      continue;
    }
    searchCalls += response.searchCalls;
    for (const kind of Object.keys(usage)) usage[kind] += response.usage[kind];
    for (const { candidate, actKeys } of batch) {
      const acts = actKeys.map((key) => response.results.get(key));
      if (acts.some((act) => !act)) throw new Error("Provider result omitted a validated performer.");
      recordEvent(candidate, acts, response);
    }
    progress();
  }
}

try {
  readJournal();
  const pending = selected.filter(({ key }) => !completed.has(key));
  if (pending.length && !process.env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY for performer genre research.");
  progress();
  const workers = await Promise.allSettled(Array.from({ length: concurrency }, () => run(pending).catch((error) => {
    stopped = true;
    throw error;
  })));
  for (const result of workers) if (result.status === "rejected") throw result.reason;
  if (selected.some(({ key }) => !completed.has(key))) process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  closeSync(lock);
  unlinkSync(lockPath);
}
