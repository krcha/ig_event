import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  extractEventDataFromInstagramPost,
  isOpenAiDefinitiveOutputError,
  isOpenAiPermanentError,
  OPENAI_EXTRACTION_MAX_OUTPUT_TOKENS,
} from "../lib/ai/extract-event-data.ts";
import {
  DEFINITIVE_OUTPUT_RECOVERY_PROTOCOL,
  EVENT_EXTRACTION_ANALYSIS_PROTOCOL,
  LEGACY_EVENT_EXTRACTION_ANALYSIS_PROTOCOL,
} from "../lib/ai/openai-analysis-protocol.ts";
import {
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_ALLOWLIST,
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_CONTENT_SHA256,
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_ENTRIES_SHA256,
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_MANIFEST_FILE_SHA256,
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_MANIFEST_VERSION,
} from "../convex/legacyDefinitiveOutputRecoveryAllowlist.ts";
import {
  claimProcessing,
  recordOpenAiDefinitiveOutputFailure,
} from "../convex/scrapedPosts.ts";
import { requeueDefinitiveOutputFailure } from "../convex/durableIngestionRuns.ts";

const SERVICE_SECRET = "qa-definitive-output-secret";
const previousCronSecret = process.env.CRON_SECRET;
const previousOpenAiKey = process.env.OPENAI_API_KEY;
const previousVisionModel = process.env.OPENAI_VISION_MODEL;
const originalFetch = globalThis.fetch;

process.env.CRON_SECRET = SERVICE_SECRET;
process.env.OPENAI_API_KEY = "qa-openai-key";
process.env.OPENAI_VISION_MODEL = "gpt-5-mini-qa";

function confirmation(text = "") {
  return {
    confidence: text ? 0.99 : 0,
    found_in: text ? ["caption"] : [],
    evidence: text,
    evidence_snippets: text ? [{ source: "caption", text }] : [],
    notes: "",
  };
}

const compactExtraction = {
  extraction_contract_version: "event_evidence_v2",
  is_event: true,
  non_event_reason: "",
  title: "Compact QA Night",
  date: "12.08.2026",
  time: "20:30",
  venue: "Compact QA Venue",
  city: "Belgrade",
  country: "Serbia",
  price: "",
  currency: "",
  artists: ["QA Artist"],
  category: "nightlife",
  description: "QA Artist performs.",
  confidence: 0.99,
  reasoning_notes: "Exact caption evidence.",
  source_caption: "",
  source_url: "",
  date_evidence: {
    exact_text: "12.08.2026",
    source: "caption",
    is_relative: false,
    resolved_date: "2026-08-12",
  },
  time_evidence: {
    status: "start_time_stated",
    exact_text: "20:30",
    source: "caption",
  },
  source_conflicts: [],
  shared_schedule_context: {
    venue: { applies_to_all: false, value: "", evidence: "", source: "unknown" },
    time: { applies_to_all: false, value: "", evidence: "", source: "unknown" },
  },
  schedule_entries: [],
  field_confirmation: {
    title: confirmation("Compact QA Night"),
    location: confirmation("Belgrade"),
    location_name: confirmation("Compact QA Venue"),
    price: confirmation(),
    start_time: confirmation("20:30"),
    short_description: confirmation("QA Artist performs"),
    artists: confirmation("QA Artist"),
  },
};

const compactBohoFourRowFixture = {
  ...structuredClone(compactExtraction),
  title: "",
  date: "",
  time: "",
  artists: [],
  description: "",
  reasoning_notes: "Four exact dated rows; one visibly shared venue.",
  shared_schedule_context: {
    venue: {
      applies_to_all: true,
      value: "Boho Bar",
      evidence: "WEEK AT BOHO BAR",
      source: "poster",
    },
    time: { applies_to_all: false, value: "", evidence: "", source: "unknown" },
  },
  schedule_entries: [
    ["2026-08-12", "WED / @hotncold.bgd", "hotncold.bgd"],
    ["2026-08-14", "FRI / @volimtejos.rs", "volimtejos.rs"],
    ["2026-08-15", "SAT / @danijelcehranov @vuk_vukosavljevic", "danijelcehranov"],
    ["2026-08-16", "SUN / @mandicmandic", "mandicmandic"],
  ].map(([date, sourceText, artist]) => ({
    date,
    time: "",
    venue: "Boho Bar",
    title: artist,
    artists: [artist],
    description: `${artist} performs.`,
    source_text: sourceText,
    date_evidence: {
      exact_text: sourceText.slice(0, 3),
      source: "poster",
      is_relative: false,
      resolved_date: date,
    },
    time_evidence: { status: "not_stated", exact_text: "", source: "unknown" },
  })),
};
assert.ok(
  Buffer.byteLength(JSON.stringify(compactExtraction), "utf8") <= 4_096,
  "A representative compact single event must fit within 4,096 UTF-8 bytes.",
);
assert.ok(
  Buffer.byteLength(JSON.stringify(compactBohoFourRowFixture), "utf8") <= 4_096,
  "A representative compact four-row venue schedule must fit within 4,096 UTF-8 bytes.",
);

const extractionOptions = {
  caption: "Compact QA Night on 12.08.2026 at 20:30.",
  instagramPostUrl: "https://www.instagram.com/p/compact-qa/",
  instagramHandle: "compact_qa",
  instagramPostTimestamp: "2026-08-11T10:00:00.000Z",
};

async function captureExtractionError(payload, status = 200) {
  globalThis.fetch = async () =>
    status === 200
      ? Response.json(payload)
      : new Response(JSON.stringify(payload), { status, statusText: "QA error" });
  try {
    await extractEventDataFromInstagramPost(extractionOptions);
  } catch (error) {
    return error;
  }
  throw new Error("Expected extraction to fail.");
}

try {
  assert.equal(OPENAI_EXTRACTION_MAX_OUTPUT_TOKENS, 8_192);
  assert.notEqual(
    EVENT_EXTRACTION_ANALYSIS_PROTOCOL,
    LEGACY_EVENT_EXTRACTION_ANALYSIS_PROTOCOL,
  );
  assert.match(EVENT_EXTRACTION_ANALYSIS_PROTOCOL, /compact_medium.*8192/i);

  const incomplete = await captureExtractionError({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    model: "gpt-5-mini-definitive",
    usage: {
      input_tokens: 700,
      output_tokens: 4_096,
      output_tokens_details: { reasoning_tokens: 3_100 },
      total_tokens: 4_796,
    },
    output_text: "{\"partial\":true",
  });
  assert.equal(isOpenAiDefinitiveOutputError(incomplete), true);
  assert.equal(incomplete.kind, "incomplete_max_output_tokens");
  assert.equal(incomplete.model, "gpt-5-mini-definitive");
  assert.equal(incomplete.outputTokens, 4_096);
  assert.equal(incomplete.reasoningTokens, 3_100);

  const empty = await captureExtractionError({
    status: "completed",
    model: "gpt-5-mini-definitive",
    usage: { input_tokens: 500, output_tokens: 0, total_tokens: 500 },
    output: [],
  });
  assert.equal(isOpenAiDefinitiveOutputError(empty), true);
  assert.equal(empty.kind, "empty_output");

  const invalidJson = await captureExtractionError({
    status: "completed",
    model: "gpt-5-mini-definitive",
    usage: { input_tokens: 500, output_tokens: 5, total_tokens: 505 },
    output_text: "{not-json",
  });
  assert.equal(isOpenAiDefinitiveOutputError(invalidJson), true);
  assert.equal(invalidJson.kind, "invalid_json");

  const invalidSchema = await captureExtractionError({
    status: "completed",
    model: "gpt-5-mini-definitive",
    usage: { input_tokens: 500, output_tokens: 5, total_tokens: 505 },
    output_text: "{}",
  });
  assert.equal(isOpenAiDefinitiveOutputError(invalidSchema), true);
  assert.equal(invalidSchema.kind, "invalid_schema");

  const verboseFreshOutput = structuredClone(compactExtraction);
  verboseFreshOutput.reasoning_notes = "x".repeat(161);
  globalThis.fetch = async () =>
    Response.json({
      status: "completed",
      model: "gpt-5-mini-definitive",
      output_text: JSON.stringify(verboseFreshOutput),
    });
  const parserPreservedVerboseOutput = await extractEventDataFromInstagramPost(
    extractionOptions,
  );
  assert.equal(
    parserPreservedVerboseOutput.reasoning_notes,
    verboseFreshOutput.reasoning_notes,
    "Transport parsing must not truncate exact returned strings; the provider pattern owns fresh bounds.",
  );

  globalThis.fetch = async () => {
    throw new TypeError("network disconnected before a response");
  };
  const ambiguousNetwork = await (async () => {
    try {
      await extractEventDataFromInstagramPost(extractionOptions);
    } catch (error) {
      return error;
    }
    throw new Error("Expected network failure.");
  })();
  assert.equal(isOpenAiDefinitiveOutputError(ambiguousNetwork), false);

  const permanent4xx = await captureExtractionError(
    { error: { message: "bad request" } },
    400,
  );
  assert.equal(isOpenAiPermanentError(permanent4xx), true);
  assert.equal(isOpenAiDefinitiveOutputError(permanent4xx), false);

  let compactRequest;
  globalThis.fetch = async (_input, init) => {
    compactRequest = JSON.parse(String(init?.body));
    return Response.json({
      status: "completed",
      model: "gpt-5-mini-definitive",
      usage: { input_tokens: 600, output_tokens: 350, total_tokens: 950 },
      output_text: JSON.stringify(compactExtraction),
    });
  };
  const compactResult = await extractEventDataFromInstagramPost(extractionOptions);
  assert.equal(compactResult.source_caption, extractionOptions.caption);
  assert.equal(compactResult.source_url, extractionOptions.instagramPostUrl);
  assert.equal(compactRequest.max_output_tokens, 8_192);
  assert.equal(compactRequest.reasoning.effort, "medium");
  assert.equal(compactRequest.text.verbosity, "low");
  const compactSchema = compactRequest.text.format.schema;
  assert.equal(compactSchema.properties.schedule_entries.maxItems, 64);
  assert.equal(compactSchema.properties.source_conflicts.maxItems, 32);
  assert.equal(
    compactSchema.properties.field_confirmation.properties.title.properties.evidence_snippets
      .maxItems,
    1,
  );
  assert.equal(
    JSON.stringify(compactSchema).includes("maxLength"),
    false,
    "Strict provider schema must avoid unsupported maxLength keywords.",
  );
  assert.equal(compactSchema.properties.source_caption.pattern, "^$");
  assert.equal(compactSchema.properties.source_url.pattern, "^$");
  assert.equal(
    new RegExp(compactSchema.properties.reasoning_notes.pattern).test("x".repeat(160)),
    true,
  );
  assert.equal(
    new RegExp(compactSchema.properties.reasoning_notes.pattern).test("x".repeat(161)),
    false,
  );
  const auditStrictSchema = (node, path = "$") => {
    assert.equal("maxLength" in node, false, `${path} must not use maxLength`);
    assert.equal("minLength" in node, false, `${path} must not use minLength`);
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false, `${path} must reject extra properties`);
      assert.deepEqual(
        [...node.required].sort(),
        Object.keys(node.properties).sort(),
        `${path} must require every declared property`,
      );
      for (const [key, child] of Object.entries(node.properties)) {
        auditStrictSchema(child, `${path}.${key}`);
      }
    }
    if (node.type === "array") auditStrictSchema(node.items, `${path}[]`);
  };
  auditStrictSchema(compactSchema);
} finally {
  globalThis.fetch = originalFetch;
}

class MemoryDb {
  constructor(seed) {
    this.tables = new Map();
    for (const [table, rows] of Object.entries(seed)) {
      this.tables.set(
        table,
        new Map(rows.map((row) => [row._id, structuredClone(row)])),
      );
    }
  }

  table(name) {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    return this.tables.get(name);
  }

  async get(id) {
    for (const table of this.tables.values()) {
      if (table.has(id)) return structuredClone(table.get(id));
    }
    return null;
  }

  async patch(id, patch) {
    for (const table of this.tables.values()) {
      if (!table.has(id)) continue;
      table.set(id, { ...table.get(id), ...structuredClone(patch) });
      return;
    }
    throw new Error(`Unknown row ${id}`);
  }

  query(tableName) {
    const tests = [];
    const query = {
      direction: "asc",
      withIndex(_index, configure) {
        const builder = {
          eq(field, value) {
            tests.push((row) => row[field] === value);
            return builder;
          },
          lte(field, value) {
            tests.push((row) => row[field] !== undefined && row[field] <= value);
            return builder;
          },
        };
        configure(builder);
        return query;
      },
      order(direction) {
        query.direction = direction;
        return query;
      },
      rows: () => {
        const rows = [...this.table(tableName).values()].filter((row) =>
          tests.every((test) => test(row)),
        );
        rows.sort((left, right) =>
          String(left._id).localeCompare(String(right._id)) *
          (query.direction === "desc" ? -1 : 1),
        );
        return rows.map((row) => structuredClone(row));
      },
      async take(limit) {
        return query.rows().slice(0, limit);
      },
      async first() {
        return query.rows()[0] ?? null;
      },
    };
    return query;
  }

  row(table, id) {
    return structuredClone(this.table(table).get(id));
  }
}

function ctx(db) {
  return { db, auth: { getUserIdentity: async () => null } };
}

const now = Date.now();
const livePost = {
  _id: "post:one",
  handle: "venue_one",
  postId: "post-one",
  instagramPostUrl: "https://www.instagram.com/p/post-one/",
  username: "venue_one",
  imageUrls: [],
  sourceRevision: 4,
  processingStatus: "processing",
  processingAttempts: 1,
  processingOutcome: "processing",
  processingLeaseOwner: "analysis-owner",
  processingLeaseExpiresAt: now + 60_000,
  analysisAttemptRevision: 4,
  analysisAttemptStartedAt: now - 1_000,
  analysisAttemptOwner: "analysis-owner",
  analysisAttemptProtocol: EVENT_EXTRACTION_ANALYSIS_PROTOCOL,
  analysisAttemptBudgetDayKey: "2026-08-11",
  blocksPaidFetch: true,
  createdAt: now - 10_000,
  updatedAt: now - 1_000,
};
const recordDb = new MemoryDb({ scrapedPosts: [livePost] });
const recorded = await recordOpenAiDefinitiveOutputFailure._handler(ctx(recordDb), {
  handle: livePost.handle,
  scrapedPostId: livePost._id,
  postId: livePost.postId,
  instagramPostUrl: livePost.instagramPostUrl,
  owner: livePost.analysisAttemptOwner,
  sourceRevision: livePost.sourceRevision,
  attemptProtocol: livePost.analysisAttemptProtocol,
  failureKind: "incomplete_max_output_tokens",
  message: "OpenAI extraction reached the 4096-token output cap.",
  model: "gpt-5-mini-2025-08-07",
  inputTokens: 1_500,
  outputTokens: 4_096,
  reasoningTokens: 3_100,
  totalTokens: 5_596,
  serviceSecret: SERVICE_SECRET,
});
assert.deepEqual(recorded, { recorded: true, reason: "recorded" });
assert.deepEqual(
  await recordOpenAiDefinitiveOutputFailure._handler(ctx(recordDb), {
    handle: livePost.handle,
    scrapedPostId: livePost._id,
    postId: livePost.postId,
    instagramPostUrl: livePost.instagramPostUrl,
    owner: livePost.analysisAttemptOwner,
    sourceRevision: livePost.sourceRevision,
    attemptProtocol: livePost.analysisAttemptProtocol,
    failureKind: "incomplete_max_output_tokens",
    message: "OpenAI extraction reached the 4096-token output cap.",
    model: "gpt-5-mini-2025-08-07",
    inputTokens: 1_500,
    outputTokens: 4_096,
    reasoningTokens: 3_100,
    totalTokens: 5_596,
    serviceSecret: SERVICE_SECRET,
  }),
  { recorded: false, reason: "already_recorded" },
);
const attestedPost = recordDb.row("scrapedPosts", livePost._id);
assert.equal(attestedPost.analysisDefinitiveOutputFailureRevision, 4);
assert.equal(attestedPost.analysisDefinitiveOutputFailureProtocol, livePost.analysisAttemptProtocol);
assert.equal(
  attestedPost.analysisDefinitiveOutputFailureAttemptStartedAt,
  livePost.analysisAttemptStartedAt,
);
assert.equal(
  attestedPost.analysisDefinitiveOutputFailureOwner,
  livePost.analysisAttemptOwner,
);
assert.equal(attestedPost.analysisDefinitiveOutputFailureOutputTokens, 4_096);
assert.equal(attestedPost.analysisDefinitiveOutputFailureReasoningTokens, 3_100);
assert.equal(attestedPost.analysisDefinitiveOutputFailureModel, "gpt-5-mini-2025-08-07");
await assert.rejects(
  recordOpenAiDefinitiveOutputFailure._handler(ctx(recordDb), {
    handle: livePost.handle,
    scrapedPostId: livePost._id,
    owner: "foreign-owner",
    sourceRevision: 4,
    attemptProtocol: livePost.analysisAttemptProtocol,
    failureKind: "empty_output",
    message: "empty",
    model: "gpt-5-mini-2025-08-07",
    serviceSecret: SERVICE_SECRET,
  }),
  /stale analysis fence/i,
);

const staleAttestationPost = {
  ...structuredClone(attestedPost),
  processingStatus: "processing",
  processingOutcome: "processing",
  processingLeaseOwner: undefined,
  processingLeaseExpiresAt: now - 1,
  analysisAttemptStartedAt: now + 1_000,
  analysisAttemptOwner: "next-analysis-owner",
};
const staleAttestationDb = new MemoryDb({ scrapedPosts: [staleAttestationPost] });
assert.deepEqual(
  await claimProcessing._handler(ctx(staleAttestationDb), {
    handle: staleAttestationPost.handle,
    scrapedPostId: staleAttestationPost._id,
    postId: staleAttestationPost.postId,
    instagramPostUrl: staleAttestationPost.instagramPostUrl,
    owner: "next-processing-owner",
    expectedSourceRevision: staleAttestationPost.sourceRevision,
    serviceSecret: SERVICE_SECRET,
  }),
  {
    claimed: false,
    reason: "analysis_attempt_ambiguous",
    sourceRevision: staleAttestationPost.sourceRevision,
    analysisAttemptStartedAt: staleAttestationPost.analysisAttemptStartedAt,
  },
  "a prior recovered failure attestation must not classify a later attempt as definitive",
);
assert.equal(
  staleAttestationDb.row("scrapedPosts", staleAttestationPost._id).processingOutcome,
  "openai_transport_ambiguous",
);

function recoverySeed(postOverrides = {}, receiptOverrides = {}, runOverrides = {}) {
  const post = {
    ...attestedPost,
    processingStatus: "completed",
    processingOutcome: "terminal_permanent_failure",
    processingError: "OpenAI extraction reached the 4096-token output cap.",
    processingLeaseOwner: undefined,
    processingLeaseExpiresAt: undefined,
    blocksPaidFetch: false,
    ...postOverrides,
  };
  const run = {
    _id: "run:one",
    status: "completed",
    selectedHandleCount: 1,
    terminalReceiptCount: 1,
    failedReceiptCount: 1,
    finishedAt: now,
    createdAt: now - 20_000,
    updatedAt: now,
    ...runOverrides,
  };
  const chunk = {
    _id: "chunk:one",
    runId: run._id,
    status: "completed",
    handleCount: 1,
    terminalReceiptCount: 1,
    createdAt: now - 20_000,
    updatedAt: now,
  };
  const receipt = {
    _id: "receipt:one",
    runId: run._id,
    chunkId: chunk._id,
    handle: post.handle,
    status: "failed",
    attemptCount: 1,
    providerAttemptCount: 1,
    providerResultStatus: "persisted",
    persistedPostCount: 1,
    scrapedPostId: post._id,
    scrapedPostSourceRevision: post.sourceRevision,
    processingAttemptCount: 1,
    chargedMicros: 10_000,
    outcomeDetail: `saved_post:${post._id};terminal_permanent_failure`,
    terminalAt: now,
    createdAt: now - 20_000,
    updatedAt: now,
    ...receiptOverrides,
  };
  return {
    scrapedPosts: [post],
    ingestionRuns: [run],
    ingestionRunChunks: [chunk],
    ingestionRunHandleReceipts: [receipt],
    instagramPaidFetchControl: [
      {
        _id: "paid-control:apify",
        key: "apify",
        backlogIndexReady: true,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now,
      },
    ],
    instagramSources: [
      {
        _id: "source:one",
        handle: post.handle,
        lastFetchStatus: "completed",
        lastFetchCompletedAt: now,
        updatedAt: now,
      },
    ],
  };
}

const requeueArgs = {
  runId: "run:one",
  receiptId: "receipt:one",
  scrapedPostId: livePost._id,
  expectedSourceRevision: livePost.sourceRevision,
  failedAttemptProtocol: EVENT_EXTRACTION_ANALYSIS_PROTOCOL,
  recoveryProtocol: DEFINITIVE_OUTPUT_RECOVERY_PROTOCOL,
  serviceSecret: SERVICE_SECRET,
};

const recoveryDb = new MemoryDb(recoverySeed());
const apifyControlBefore = recoveryDb.row("instagramPaidFetchControl", "paid-control:apify");
const sourceBefore = recoveryDb.row("instagramSources", "source:one");
const receiptBefore = recoveryDb.row("ingestionRunHandleReceipts", "receipt:one");
assert.deepEqual(
  await requeueDefinitiveOutputFailure._handler(ctx(recoveryDb), requeueArgs),
  { requeued: true, reason: "requeued" },
);
const recoveredPost = recoveryDb.row("scrapedPosts", livePost._id);
const recoveredReceipt = recoveryDb.row("ingestionRunHandleReceipts", "receipt:one");
assert.equal(recoveredPost.processingStatus, "pending");
assert.equal(recoveredPost.blocksPaidFetch, true);
assert.equal(recoveredPost.analysisAttemptRevision, undefined);
assert.equal(recoveredPost.analysisAttemptProtocol, undefined);
assert.equal(recoveredPost.analysisDefinitiveOutputFailureOutputTokens, 4_096);
assert.equal(recoveredPost.analysisDefinitiveOutputRecoveryRevision, 4);
assert.equal(recoveredReceipt.status, "processing_pending");
assert.equal(recoveredReceipt.providerAttemptCount, receiptBefore.providerAttemptCount);
assert.equal(recoveredReceipt.providerResultStatus, receiptBefore.providerResultStatus);
assert.equal(recoveredReceipt.scrapedPostId, receiptBefore.scrapedPostId);
assert.equal(recoveredReceipt.scrapedPostSourceRevision, receiptBefore.scrapedPostSourceRevision);
assert.equal(recoveredReceipt.chargedMicros, receiptBefore.chargedMicros);
assert.deepEqual(
  recoveryDb.row("instagramPaidFetchControl", "paid-control:apify"),
  apifyControlBefore,
  "Definitive-output requeue must not reset the Apify paid-fetch control.",
);
assert.deepEqual(
  recoveryDb.row("instagramSources", "source:one"),
  sourceBefore,
  "Definitive-output requeue must not alter source fetch checkpoints.",
);
assert.equal(recoveryDb.row("ingestionRuns", "run:one").status, "queued");
assert.equal(recoveryDb.row("ingestionRuns", "run:one").terminalReceiptCount, 0);
assert.equal(recoveryDb.row("ingestionRuns", "run:one").failedReceiptCount, 0);
assert.equal(recoveryDb.row("ingestionRunChunks", "chunk:one").terminalReceiptCount, 0);

const stateAfterFirstRequeue = structuredClone({
  post: recoveredPost,
  receipt: recoveredReceipt,
  run: recoveryDb.row("ingestionRuns", "run:one"),
  chunk: recoveryDb.row("ingestionRunChunks", "chunk:one"),
});
assert.deepEqual(
  await requeueDefinitiveOutputFailure._handler(ctx(recoveryDb), requeueArgs),
  { requeued: false, reason: "already_requeued" },
);
assert.deepEqual(
  {
    post: recoveryDb.row("scrapedPosts", livePost._id),
    receipt: recoveryDb.row("ingestionRunHandleReceipts", "receipt:one"),
    run: recoveryDb.row("ingestionRuns", "run:one"),
    chunk: recoveryDb.row("ingestionRunChunks", "chunk:one"),
  },
  stateAfterFirstRequeue,
  "A replay of the same recovery generation must be read-only.",
);

const failedRunSeed = recoverySeed({}, {}, {
  status: "failed",
  selectedHandleCount: 2,
  error: "Morning controller was stopped after saved-post processing failures.",
});
failedRunSeed.scrapedPosts.push({
  ...structuredClone(failedRunSeed.scrapedPosts[0]),
  _id: "post:already-pending",
  handle: "venue_already_pending",
  postId: "already-pending",
  instagramPostUrl: "https://www.instagram.com/p/already-pending/",
  username: "venue_already_pending",
  sourceRevision: 1,
  processingStatus: "pending",
  processingOutcome: "saved_post_processing_pending",
  analysisAttemptRevision: undefined,
  analysisAttemptStartedAt: undefined,
  analysisAttemptOwner: undefined,
  analysisAttemptProtocol: undefined,
  analysisDefinitiveOutputFailureRevision: undefined,
  analysisDefinitiveOutputFailureProtocol: undefined,
  analysisDefinitiveOutputFailureKind: undefined,
  analysisDefinitiveOutputFailureAt: undefined,
  analysisDefinitiveOutputFailureModel: undefined,
});
failedRunSeed.ingestionRunHandleReceipts.push({
  ...structuredClone(failedRunSeed.ingestionRunHandleReceipts[0]),
  _id: "receipt:already-pending",
  handle: "venue_already_pending",
  status: "processing_pending",
  scrapedPostId: "post:already-pending",
  scrapedPostSourceRevision: 1,
  processingAttemptCount: 0,
  outcomeDetail: "saved_post_processing_pending",
  terminalAt: undefined,
});
const failedRunDb = new MemoryDb(failedRunSeed);
assert.deepEqual(
  await requeueDefinitiveOutputFailure._handler(ctx(failedRunDb), requeueArgs),
  { requeued: true, reason: "requeued" },
  "An otherwise inert failed run must be safely reopened for exact saved-post recovery.",
);
assert.equal(failedRunDb.row("ingestionRuns", "run:one").status, "queued");
assert.equal(
  failedRunDb.row("ingestionRunHandleReceipts", "receipt:one").providerAttemptCount,
  1,
);

const unsafeFailedRunSeed = recoverySeed({}, {}, {
  status: "failed",
  selectedHandleCount: 2,
});
unsafeFailedRunSeed.ingestionRunHandleReceipts.push({
  ...structuredClone(unsafeFailedRunSeed.ingestionRunHandleReceipts[0]),
  _id: "receipt:unfetched",
  handle: "venue_unfetched",
  status: "queued",
  providerAttemptCount: 0,
  providerResultStatus: undefined,
  persistedPostCount: undefined,
  scrapedPostId: undefined,
  scrapedPostSourceRevision: undefined,
  terminalAt: undefined,
});
await assert.rejects(
  requeueDefinitiveOutputFailure._handler(
    ctx(new MemoryDb(unsafeFailedRunSeed)),
    requeueArgs,
  ),
  /could re-enter paid fetch/i,
  "Reopening a failed run must reject any receipt that could trigger a new Apify call.",
);

const unsafeCompletedRunSeed = recoverySeed({}, {}, {
  status: "completed",
  selectedHandleCount: 2,
});
unsafeCompletedRunSeed.ingestionRunHandleReceipts.push({
  ...structuredClone(unsafeCompletedRunSeed.ingestionRunHandleReceipts[0]),
  _id: "receipt:completed-unfetched",
  handle: "venue_completed_unfetched",
  status: "queued",
  providerAttemptCount: 0,
  providerResultStatus: undefined,
  persistedPostCount: undefined,
  scrapedPostId: undefined,
  scrapedPostSourceRevision: undefined,
  terminalAt: undefined,
});
await assert.rejects(
  requeueDefinitiveOutputFailure._handler(
    ctx(new MemoryDb(unsafeCompletedRunSeed)),
    requeueArgs,
  ),
  /could re-enter paid fetch/i,
  "Reopening a completed run must reject any receipt that could trigger a new Apify call.",
);

async function expectRecoveryRejected(seed, args, pattern) {
  const db = new MemoryDb(seed);
  await assert.rejects(
    requeueDefinitiveOutputFailure._handler(ctx(db), args),
    pattern,
  );
}

await expectRecoveryRejected(
  recoverySeed({ sourceRevision: 5 }),
  requeueArgs,
  /revision has drifted/i,
);
await expectRecoveryRejected(
  recoverySeed({}, { providerAttemptCount: 2 }),
  requeueArgs,
  /exactly one persisted/i,
);
await expectRecoveryRejected(
  recoverySeed({ analysisRevision: 4, analysisResultJson: "{}" }),
  requeueArgs,
  /current analysis/i,
);
await expectRecoveryRejected(
  recoverySeed({}, { leaseOwner: "active-owner", leaseExpiresAt: now + 60_000 }),
  requeueArgs,
  /active or uncleared lease/i,
);
for (const processingError of [
  "network disconnected before a response",
  "OpenAI transport outcome is ambiguous",
  "OpenAI extraction failed: 400 Bad Request",
]) {
  await expectRecoveryRejected(
    recoverySeed({
      processingError,
      analysisDefinitiveOutputFailureRevision: undefined,
      analysisDefinitiveOutputFailureProtocol: undefined,
      analysisDefinitiveOutputFailureKind: undefined,
      analysisDefinitiveOutputFailureAt: undefined,
      analysisDefinitiveOutputFailureModel: undefined,
    }),
    requeueArgs,
    /does not carry an exact definitive-output failure attestation/i,
  );
}
await expectRecoveryRejected(
  {
    ...recoverySeed(),
    scrapedPosts: [
      recoverySeed().scrapedPosts[0],
      { ...recoverySeed().scrapedPosts[0], _id: "post:foreign" },
    ],
  },
  { ...requeueArgs, scrapedPostId: "post:foreign" },
  /exact linked saved post/i,
);
await expectRecoveryRejected(
  recoverySeed(),
  { ...requeueArgs, recoveryProtocol: "openai-definitive-output-requeue:v2" },
  /protocol fence mismatch/i,
);
await expectRecoveryRejected(
  recoverySeed(),
  { ...requeueArgs, serviceSecret: "wrong-secret" },
  /authentication required/i,
);

assert.equal(LEGACY_DEFINITIVE_OUTPUT_RECOVERY_ALLOWLIST.length, 47);
assert.equal(
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_ALLOWLIST.filter(
    (entry) => entry.failureKind === "invalid_json",
  ).length,
  45,
);
assert.equal(
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_ALLOWLIST.filter(
    (entry) => entry.failureKind === "empty_output",
  ).length,
  2,
);
assert.equal(
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_MANIFEST_FILE_SHA256,
  "ccdc9258678a8438fda0eae8d0777148bdd2ff5d5a8f6fd4984dee2e453ff5ac",
);
assert.equal(
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_ENTRIES_SHA256,
  "76509b4c65c9fdb9d05b1cb4452785365fb6b0a2b47637e22162f18a28a8761f",
);
assert.equal(
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_CONTENT_SHA256,
  "44982f8fc48d0fab287a9bc0463dbf4e606e65c4fabd8eee037bb446d82d5bed",
);
const compiledLegacyRows = LEGACY_DEFINITIVE_OUTPUT_RECOVERY_ALLOWLIST.map(
  (entry) => [
    entry.runId,
    entry.receiptId,
    entry.savedPostId,
    entry.sourceRevision,
    entry.sourceUpdatedAt,
    entry.receiptUpdatedAt,
    entry.analysisAttemptStartedAt,
    entry.receiptTerminalAt,
    entry.failureLogAt,
    entry.failureKind,
    entry.evidenceSha256,
  ],
);
assert.equal(
  createHash("sha256")
    .update(JSON.stringify(compiledLegacyRows))
    .digest("hex"),
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_ENTRIES_SHA256,
  "The compiled 47-row allowlist must remain byte-for-byte bound to the audited manifest entries.",
);

function legacyRecoverySeed(
  entry,
  postOverrides = {},
  receiptOverrides = {},
  runOverrides = {},
) {
  const handle = `legacy_${entry.receiptId.slice(-8)}`;
  const post = {
    _id: entry.savedPostId,
    handle,
    postId: `post-${entry.savedPostId}`,
    instagramPostUrl: `https://www.instagram.com/p/${entry.savedPostId}/`,
    username: handle,
    imageUrls: [],
    sourceRevision: entry.sourceRevision,
    processingStatus: "completed",
    processingAttempts: 1,
    processingOutcome: "terminal_permanent_failure",
    processingError:
      entry.failureKind === "empty_output"
        ? "OpenAI response did not contain output text."
        : "OpenAI response did not contain valid JSON.",
    processingLeaseOwner: undefined,
    processingLeaseExpiresAt: undefined,
    processingRetryAt: undefined,
    analysisAttemptRevision: entry.sourceRevision,
    analysisAttemptStartedAt: entry.analysisAttemptStartedAt,
    analysisAttemptOwner: `legacy-owner-${entry.receiptId}`,
    analysisAttemptProtocol: LEGACY_EVENT_EXTRACTION_ANALYSIS_PROTOCOL,
    blocksPaidFetch: false,
    createdAt: entry.sourceUpdatedAt - 10_000,
    updatedAt: entry.sourceUpdatedAt,
    ...postOverrides,
  };
  const run = {
    _id: entry.runId,
    status: "completed",
    selectedHandleCount: 1,
    terminalReceiptCount: 1,
    failedReceiptCount: 1,
    finishedAt: entry.receiptTerminalAt,
    createdAt: entry.analysisAttemptStartedAt - 20_000,
    updatedAt: entry.receiptTerminalAt,
    ...runOverrides,
  };
  const chunk = {
    _id: `chunk:${entry.receiptId}`,
    runId: run._id,
    status: "completed",
    handleCount: 1,
    terminalReceiptCount: 1,
    createdAt: entry.analysisAttemptStartedAt - 20_000,
    updatedAt: entry.receiptTerminalAt,
  };
  const receipt = {
    _id: entry.receiptId,
    runId: run._id,
    chunkId: chunk._id,
    handle,
    status: "failed",
    attemptCount: 1,
    providerAttemptCount: 1,
    providerResultStatus: "persisted",
    persistedPostCount: 1,
    scrapedPostId: post._id,
    scrapedPostSourceRevision: entry.sourceRevision,
    processingAttemptCount: 1,
    chargedMicros: 10_000,
    outcomeDetail: `saved_post:${entry.savedPostId};terminal_permanent_failure`,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    terminalAt: entry.receiptTerminalAt,
    createdAt: entry.analysisAttemptStartedAt - 20_000,
    updatedAt: entry.receiptUpdatedAt,
    ...receiptOverrides,
  };
  return {
    scrapedPosts: [post],
    ingestionRuns: [run],
    ingestionRunChunks: [chunk],
    ingestionRunHandleReceipts: [receipt],
    instagramPaidFetchControl: [
      {
        _id: "paid-control:legacy-apify",
        key: "apify",
        backlogIndexReady: true,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        updatedAt: entry.receiptTerminalAt,
      },
    ],
  };
}

function legacyRequeueArgs(entry, overrides = {}) {
  return {
    runId: entry.runId,
    receiptId: entry.receiptId,
    scrapedPostId: entry.savedPostId,
    expectedSourceRevision: entry.sourceRevision,
    failedAttemptProtocol: LEGACY_EVENT_EXTRACTION_ANALYSIS_PROTOCOL,
    recoveryProtocol: DEFINITIVE_OUTPUT_RECOVERY_PROTOCOL,
    legacyManifestVersion:
      LEGACY_DEFINITIVE_OUTPUT_RECOVERY_MANIFEST_VERSION,
    serviceSecret: SERVICE_SECRET,
    ...overrides,
  };
}

const legacyPositiveEntries = LEGACY_DEFINITIVE_OUTPUT_RECOVERY_ALLOWLIST;

for (const entry of legacyPositiveEntries) {
  const legacyDb = new MemoryDb(legacyRecoverySeed(entry));
  const legacyArgs = legacyRequeueArgs(entry);
  const postBefore = legacyDb.row("scrapedPosts", entry.savedPostId);
  const receiptBeforeLegacy = legacyDb.row(
    "ingestionRunHandleReceipts",
    entry.receiptId,
  );
  const paidFetchBefore = legacyDb.row(
    "instagramPaidFetchControl",
    "paid-control:legacy-apify",
  );
  assert.deepEqual(
    await requeueDefinitiveOutputFailure._handler(ctx(legacyDb), legacyArgs),
    { requeued: true, reason: "requeued" },
  );
  const postAfter = legacyDb.row("scrapedPosts", entry.savedPostId);
  const receiptAfter = legacyDb.row(
    "ingestionRunHandleReceipts",
    entry.receiptId,
  );
  assert.equal(postAfter.processingStatus, "pending");
  assert.equal(postAfter.blocksPaidFetch, true);
  assert.equal(
    postAfter.analysisDefinitiveOutputFailureRevision,
    entry.sourceRevision,
  );
  assert.equal(
    postAfter.analysisDefinitiveOutputFailureProtocol,
    LEGACY_EVENT_EXTRACTION_ANALYSIS_PROTOCOL,
  );
  assert.equal(
    postAfter.analysisDefinitiveOutputFailureAttemptStartedAt,
    entry.analysisAttemptStartedAt,
  );
  assert.equal(
    postAfter.analysisDefinitiveOutputFailureOwner,
    postBefore.analysisAttemptOwner,
  );
  assert.equal(postAfter.analysisDefinitiveOutputFailureKind, entry.failureKind);
  assert.equal(
    postAfter.analysisDefinitiveOutputFailureMessage,
    postBefore.processingError,
  );
  assert.equal(postAfter.analysisDefinitiveOutputFailureAt, entry.failureAt);
  assert.equal(postAfter.analysisDefinitiveOutputFailureModel, undefined);
  assert.equal(postAfter.analysisDefinitiveOutputFailureInputTokens, undefined);
  assert.equal(postAfter.analysisDefinitiveOutputFailureOutputTokens, undefined);
  assert.equal(postAfter.analysisDefinitiveOutputFailureReasoningTokens, undefined);
  assert.equal(postAfter.analysisDefinitiveOutputFailureTotalTokens, undefined);
  assert.equal(
    postAfter.analysisDefinitiveOutputRecoveryFromProtocol,
    LEGACY_EVENT_EXTRACTION_ANALYSIS_PROTOCOL,
  );
  assert.equal(receiptAfter.status, "processing_pending");
  for (const field of [
    "providerAttemptCount",
    "providerResultStatus",
    "persistedPostCount",
    "chargedMicros",
    "scrapedPostId",
    "scrapedPostSourceRevision",
  ]) {
    assert.equal(receiptAfter[field], receiptBeforeLegacy[field]);
  }
  assert.deepEqual(
    legacyDb.row("instagramPaidFetchControl", "paid-control:legacy-apify"),
    paidFetchBefore,
    "Legacy recovery must not alter any Apify paid-fetch control field.",
  );
  const stateAfterLegacyRecovery = structuredClone({
    post: postAfter,
    receipt: receiptAfter,
    run: legacyDb.row("ingestionRuns", entry.runId),
    chunk: legacyDb.row("ingestionRunChunks", `chunk:${entry.receiptId}`),
  });
  assert.deepEqual(
    await requeueDefinitiveOutputFailure._handler(ctx(legacyDb), legacyArgs),
    { requeued: false, reason: "already_requeued" },
  );
  assert.deepEqual(
    {
      post: legacyDb.row("scrapedPosts", entry.savedPostId),
      receipt: legacyDb.row("ingestionRunHandleReceipts", entry.receiptId),
      run: legacyDb.row("ingestionRuns", entry.runId),
      chunk: legacyDb.row(
        "ingestionRunChunks",
        `chunk:${entry.receiptId}`,
      ),
    },
    stateAfterLegacyRecovery,
    "The frozen legacy bridge must be one-shot and idempotent.",
  );
}

const legacyInvalidJsonEntry = legacyPositiveEntries.find(
  (entry) => entry.failureKind === "invalid_json",
);
assert.ok(legacyInvalidJsonEntry);
await expectRecoveryRejected(
  legacyRecoverySeed(legacyInvalidJsonEntry),
  legacyRequeueArgs(legacyInvalidJsonEntry, {
    legacyManifestVersion: "legacy-definitive-output-2026-08-11:redacted-v2",
  }),
  /manifest version mismatch/i,
);
await expectRecoveryRejected(
  legacyRecoverySeed(legacyInvalidJsonEntry),
  legacyRequeueArgs(legacyInvalidJsonEntry, {
    receiptId: "receipt:not-in-frozen-allowlist",
  }),
  /not in the frozen allowlist/i,
);
await expectRecoveryRejected(
  legacyRecoverySeed(legacyInvalidJsonEntry, {
    updatedAt: legacyInvalidJsonEntry.sourceUpdatedAt + 1,
  }),
  legacyRequeueArgs(legacyInvalidJsonEntry),
  /state has drifted/i,
);
await expectRecoveryRejected(
  legacyRecoverySeed(legacyInvalidJsonEntry, {
    analysisAttemptProtocol: "openai-responses:transport-ambiguous",
  }),
  legacyRequeueArgs(legacyInvalidJsonEntry),
  /state has drifted/i,
);
await expectRecoveryRejected(
  legacyRecoverySeed(legacyInvalidJsonEntry, {
    processingOutcome: "openai_transport_ambiguous",
  }),
  legacyRequeueArgs(legacyInvalidJsonEntry),
  /not a terminal permanent extraction failure/i,
);
await expectRecoveryRejected(
  legacyRecoverySeed(legacyInvalidJsonEntry, {}, { providerAttemptCount: 2 }),
  legacyRequeueArgs(legacyInvalidJsonEntry),
  /exactly one persisted/i,
);
await expectRecoveryRejected(
  legacyRecoverySeed(
    legacyInvalidJsonEntry,
    {},
    { leaseOwner: "active-owner", leaseExpiresAt: now + 60_000 },
  ),
  legacyRequeueArgs(legacyInvalidJsonEntry),
  /active or uncleared lease/i,
);
await expectRecoveryRejected(
  legacyRecoverySeed(legacyInvalidJsonEntry, {
    analysisRevision: legacyInvalidJsonEntry.sourceRevision,
    analysisResultJson: "{}",
  }),
  legacyRequeueArgs(legacyInvalidJsonEntry),
  /current analysis/i,
);
await expectRecoveryRejected(
  recoverySeed(),
  {
    ...requeueArgs,
    legacyManifestVersion:
      LEGACY_DEFINITIVE_OUTPUT_RECOVERY_MANIFEST_VERSION,
  },
  /refuses a legacy manifest version/i,
);

if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
else process.env.CRON_SECRET = previousCronSecret;
if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
else process.env.OPENAI_API_KEY = previousOpenAiKey;
if (previousVisionModel === undefined) delete process.env.OPENAI_VISION_MODEL;
else process.env.OPENAI_VISION_MODEL = previousVisionModel;

console.log("Definitive OpenAI output recovery QA passed.");
