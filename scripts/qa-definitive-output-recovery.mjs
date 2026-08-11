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
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_RECEIPT_IDS,
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_SHA256,
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_VERSION,
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_MANIFEST_FILE_SHA256,
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_MANIFEST_VERSION,
  getLegacyDefinitiveOutputRecoveryFailureAt,
} from "../convex/legacyDefinitiveOutputRecoveryAllowlist.ts";
import {
  claimProcessing,
  recordOpenAiDefinitiveOutputFailure,
  upsertManyByHandle,
} from "../convex/scrapedPosts.ts";
import {
  claimLegacyDefinitiveOutputRecoveryReceipt,
  claimNextProcessingReceipt,
  completeProcessingReceipt,
  releaseProcessingReceiptForRetry,
  requeueDefinitiveOutputFailure,
} from "../convex/durableIngestionRuns.ts";

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
      async unique() {
        const rows = query.rows();
        if (rows.length > 1) throw new Error("MemoryDb unique query returned multiple rows.");
        return rows[0] ?? null;
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
assert.equal(attestedPost.analysisDefinitiveOutputRecoveryEvidenceSha256, undefined);
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
  undefined,
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
for (const entry of LEGACY_DEFINITIVE_OUTPUT_RECOVERY_ALLOWLIST) {
  assert.equal(
    getLegacyDefinitiveOutputRecoveryFailureAt(entry),
    Date.parse(entry.failureLogAt),
    "Every legacy failure time must be derived from its SHA-bound log timestamp.",
  );
  assert.match(entry.evidenceSha256, /^[a-f0-9]{64}$/u);
}
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
  assert.equal(postBefore.processingError, undefined);
  assert.equal(postAfter.analysisDefinitiveOutputFailureMessage, undefined);
  assert.equal(
    Object.hasOwn(postAfter, "analysisDefinitiveOutputFailureMessage"),
    false,
    "A missing historical processing error must not create or invent a failure message.",
  );
  assert.equal(
    postAfter.analysisDefinitiveOutputRecoveryEvidenceSha256,
    entry.evidenceSha256,
  );
  assert.equal(
    postAfter.analysisDefinitiveOutputFailureAt,
    Date.parse(entry.failureLogAt),
  );
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
    analysisDefinitiveOutputRecoveryRevision:
      legacyInvalidJsonEntry.sourceRevision,
  }),
  legacyRequeueArgs(legacyInvalidJsonEntry),
  /recovery marker is partial, mismatched, or already consumed/i,
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
  legacyRecoverySeed(legacyInvalidJsonEntry, {
    analysisDefinitiveOutputRecoveryEvidenceSha256:
      legacyInvalidJsonEntry.evidenceSha256,
  }),
  legacyRequeueArgs(legacyInvalidJsonEntry),
  /recovery marker is partial, mismatched, or already consumed/i,
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

// Recovery provenance belongs to one immutable source revision. Any real
// source-content change must clear it with the rest of the analysis/recovery
// generation before the incremented revision can be processed.
{
  const entry = legacyInvalidJsonEntry;
  const db = new MemoryDb(legacyRecoverySeed(entry));
  await requeueDefinitiveOutputFailure._handler(ctx(db), legacyRequeueArgs(entry));
  const before = db.row("scrapedPosts", entry.savedPostId);
  assert.equal(
    before.analysisDefinitiveOutputRecoveryEvidenceSha256,
    entry.evidenceSha256,
  );
  await upsertManyByHandle._handler(ctx(db), {
    handle: before.handle,
    posts: [
      {
        handle: before.handle,
        postId: before.postId,
        caption: "Changed source caption for the next revision.",
        imageUrls: [],
        instagramPostUrl: before.instagramPostUrl,
        username: before.username,
      },
    ],
    serviceSecret: SERVICE_SECRET,
  });
  const after = db.row("scrapedPosts", entry.savedPostId);
  assert.equal(after.sourceRevision, entry.sourceRevision + 1);
  assert.equal(after.analysisDefinitiveOutputRecoveryRevision, undefined);
  assert.equal(after.analysisDefinitiveOutputRecoveryFromProtocol, undefined);
  assert.equal(after.analysisDefinitiveOutputRecoveryProtocol, undefined);
  assert.equal(after.analysisDefinitiveOutputRecoveryEvidenceSha256, undefined);
  assert.equal(after.analysisDefinitiveOutputRecoveredAt, undefined);
}

assert.deepEqual(
  [...LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_RECEIPT_IDS],
  [
    "mx70mzwydg99nrhvyjmxaxzvgd8c9k73",
    "mx71c7p5csrpzfc7x0zv9a66598c9zx7",
    "mx70cnynwsxfrcq21nnvvn16x98c9h6c",
  ],
);
assert.equal(
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_SHA256,
  "f6e588cff5778a0bfd41a7d5238c753274bb83c5e0b908ceba6ed1760a34f1e8",
);

const initialLegacyEntries = LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_RECEIPT_IDS.map(
  (receiptId) => {
    const entry = LEGACY_DEFINITIVE_OUTPUT_RECOVERY_ALLOWLIST.find(
      (candidate) => candidate.receiptId === receiptId,
    );
    assert.ok(entry);
    return entry;
  },
);

function legacyInitialBatchSeed() {
  const seeds = initialLegacyEntries.map((entry) => legacyRecoverySeed(entry));
  const run = {
    ...seeds[0].ingestionRuns[0],
    selectedHandleCount: initialLegacyEntries.length,
    terminalReceiptCount: initialLegacyEntries.length,
    failedReceiptCount: initialLegacyEntries.length,
    queueBuildCompletedAt: now - 30_000,
    dispatchReadyAt: now - 30_000,
  };
  return {
    scrapedPosts: seeds.flatMap((seed) => seed.scrapedPosts),
    ingestionRuns: [run],
    ingestionRunChunks: seeds.flatMap((seed) => seed.ingestionRunChunks),
    ingestionRunHandleReceipts: seeds.flatMap(
      (seed) => seed.ingestionRunHandleReceipts,
    ),
    ingestionProviderLeases: [],
  };
}

async function requeueInitialBatch(db) {
  for (const entry of initialLegacyEntries) {
    assert.deepEqual(
      await requeueDefinitiveOutputFailure._handler(
        ctx(db),
        legacyRequeueArgs(entry),
      ),
      { requeued: true, reason: "requeued" },
    );
  }
}

function exactClaimArgs(receiptId, overrides = {}) {
  return {
    selectedReceiptIds: [...LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_RECEIPT_IDS],
    receiptId,
    workerId: "qa-exact-recovery-worker",
    legacyManifestVersion: LEGACY_DEFINITIVE_OUTPUT_RECOVERY_MANIFEST_VERSION,
    selectionSha256: LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_SHA256,
    selectionVersion: LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_VERSION,
    recoveryProtocol: DEFINITIVE_OUTPUT_RECOVERY_PROTOCOL,
    serviceSecret: SERVICE_SECRET,
    ...overrides,
  };
}

function addOrdinaryProcessingCandidate(db, runId) {
  db.table("ingestionRuns").set(runId, {
    ...db.row("ingestionRuns", runId),
    selectedHandleCount: 4,
  });
  db.table("scrapedPosts").set("post:ordinary", {
    _id: "post:ordinary",
    handle: "ordinary_handle",
    postId: "ordinary-post",
    instagramPostUrl: "https://www.instagram.com/p/ordinary-post/",
    username: "ordinary_handle",
    imageUrls: [],
    sourceRevision: 1,
    processingStatus: "pending",
    blocksPaidFetch: true,
    createdAt: now - 1_000,
    updatedAt: now - 1_000,
  });
  db.table("ingestionRunHandleReceipts").set("zz-receipt-ordinary", {
    _id: "zz-receipt-ordinary",
    runId,
    chunkId: "chunk:ordinary",
    handle: "ordinary_handle",
    status: "processing_pending",
    attemptCount: 1,
    providerAttemptCount: 1,
    providerResultStatus: "persisted",
    persistedPostCount: 1,
    scrapedPostId: "post:ordinary",
    scrapedPostSourceRevision: 1,
    processingAttemptCount: 0,
    retryNotBeforeAt: now - 1,
    createdAt: now - 2_000,
    updatedAt: now - 1_000,
  });
}

{
  const db = new MemoryDb(legacyInitialBatchSeed());
  await requeueInitialBatch(db);
  const target = initialLegacyEntries[0];
  const claimed = await claimLegacyDefinitiveOutputRecoveryReceipt._handler(
    ctx(db),
    exactClaimArgs(target.receiptId),
  );
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.state, "claimed");
  assert.equal(claimed.scrapedPostId, target.savedPostId);
  assert.equal(claimed.scrapedPostSourceRevision, target.sourceRevision);
  assert.equal(claimed.providerAttemptCount, 1);
  assert.equal(
    db.row("ingestionRunHandleReceipts", target.receiptId).outcomeDetail,
    "legacy_definitive_output_recovery_claimed",
  );
}

// A later current-protocol definitive failure replaces the failure tuple but
// must retain the legacy recovery provenance. This keeps a lost completion ACK
// readable without allowing the one-shot recovery to enqueue a second attempt.
{
  const db = new MemoryDb(legacyInitialBatchSeed());
  await requeueInitialBatch(db);
  const target = initialLegacyEntries[0];
  const workerId = "qa-current-failure-readback-worker";
  const claimed = await claimLegacyDefinitiveOutputRecoveryReceipt._handler(
    ctx(db),
    exactClaimArgs(target.receiptId, { workerId }),
  );
  assert.equal(claimed.claimed, true);
  await db.patch(target.savedPostId, {
    processingStatus: "completed",
    processingOutcome: "terminal_permanent_failure",
    processingError: "Current protocol returned a definitive invalid schema.",
    processingLeaseOwner: undefined,
    processingLeaseExpiresAt: undefined,
    processingRetryAt: undefined,
    blocksPaidFetch: false,
    analysisAttemptRevision: target.sourceRevision,
    analysisAttemptStartedAt: now,
    analysisAttemptOwner: workerId,
    analysisAttemptProtocol: EVENT_EXTRACTION_ANALYSIS_PROTOCOL,
    analysisDefinitiveOutputFailureRevision: target.sourceRevision,
    analysisDefinitiveOutputFailureProtocol:
      EVENT_EXTRACTION_ANALYSIS_PROTOCOL,
    analysisDefinitiveOutputFailureAttemptStartedAt: now,
    analysisDefinitiveOutputFailureOwner: workerId,
    analysisDefinitiveOutputFailureKind: "invalid_schema",
    analysisDefinitiveOutputFailureMessage:
      "Current protocol returned a definitive invalid schema.",
    analysisDefinitiveOutputFailureAt: now,
    analysisDefinitiveOutputFailureModel: "gpt-5-mini-qa",
  });
  assert.equal(
    db.row("scrapedPosts", target.savedPostId)
      .analysisDefinitiveOutputRecoveryEvidenceSha256,
    target.evidenceSha256,
  );
  const completion = await completeProcessingReceipt._handler(ctx(db), {
    runId: target.runId,
    receiptId: target.receiptId,
    workerId,
    serviceSecret: SERVICE_SECRET,
  });
  assert.equal(completion.status, "failed");
  const readback = await claimLegacyDefinitiveOutputRecoveryReceipt._handler(
    ctx(db),
    exactClaimArgs(target.receiptId, {
      workerId: "qa-current-failure-readback-retry",
    }),
  );
  assert.equal(readback.claimed, false);
  assert.equal(readback.state, "already_terminal");
  await expectRecoveryRejected(
    {
      scrapedPosts: [db.row("scrapedPosts", target.savedPostId)],
      ingestionRuns: [db.row("ingestionRuns", target.runId)],
      ingestionRunChunks: [
        db.row("ingestionRunChunks", `chunk:${target.receiptId}`),
      ],
      ingestionRunHandleReceipts: [
        db.row("ingestionRunHandleReceipts", target.receiptId),
      ],
    },
    {
      ...legacyRequeueArgs(target),
      failedAttemptProtocol: EVENT_EXTRACTION_ANALYSIS_PROTOCOL,
      legacyManifestVersion: undefined,
    },
    /recovery marker is partial, mismatched, or already consumed/i,
  );
}

// Corrupted or missing recovery evidence blocks the exact executor while the
// broad reservation marker keeps every such row out of the generic AI lane.
for (const recoveryEvidenceSha256 of [undefined, "0".repeat(64)]) {
  const db = new MemoryDb(legacyInitialBatchSeed());
  await requeueInitialBatch(db);
  const target = initialLegacyEntries[0];
  await db.patch(target.savedPostId, {
    analysisDefinitiveOutputRecoveryEvidenceSha256: recoveryEvidenceSha256,
  });
  await assert.rejects(
    claimLegacyDefinitiveOutputRecoveryReceipt._handler(
      ctx(db),
      exactClaimArgs(target.receiptId),
    ),
    /exact persisted recovery fence/i,
  );
  await assert.rejects(
    requeueDefinitiveOutputFailure._handler(
      ctx(db),
      legacyRequeueArgs(target),
    ),
    /recovery marker is partial, mismatched, or already consumed/i,
  );
  addOrdinaryProcessingCandidate(db, target.runId);
  const genericClaim = await claimNextProcessingReceipt._handler(ctx(db), {
    runId: target.runId,
    workerId: "qa-generic-evidence-drift-worker",
    serviceSecret: SERVICE_SECRET,
  });
  assert.equal(genericClaim?.receiptId, "zz-receipt-ordinary");
}

// Normal exact completions restore the one-row chunk accounting that each
// requeue decremented. A lost completion acknowledgement is read back through
// the idempotent release boundary without incrementing the chunk twice.
{
  const db = new MemoryDb(legacyInitialBatchSeed());
  await requeueInitialBatch(db);
  for (let index = 0; index < initialLegacyEntries.length; index += 1) {
    const target = initialLegacyEntries[index];
    const workerId = `qa-completion-worker-${index}`;
    const claimed = await claimLegacyDefinitiveOutputRecoveryReceipt._handler(
      ctx(db),
      exactClaimArgs(target.receiptId, { workerId }),
    );
    assert.equal(claimed.claimed, true);
    await db.patch(target.savedPostId, {
      processingStatus: "completed",
      processingOutcome: "receipt_complete",
      processingError: undefined,
      processingLeaseOwner: undefined,
      processingLeaseExpiresAt: undefined,
      processingRetryAt: undefined,
      blocksPaidFetch: false,
    });
    const completion = await completeProcessingReceipt._handler(ctx(db), {
      runId: target.runId,
      receiptId: target.receiptId,
      workerId,
      serviceSecret: SERVICE_SECRET,
    });
    assert.equal(completion.status, "fetched");
    const chunk = db.row(
      "ingestionRunChunks",
      `chunk:${target.receiptId}`,
    );
    assert.equal(chunk.terminalReceiptCount, 1);
    assert.equal(chunk.status, "completed");

    if (index === 0) {
      const completionReadback =
        await releaseProcessingReceiptForRetry._handler(ctx(db), {
          runId: target.runId,
          receiptId: target.receiptId,
          workerId,
          reason: "completion acknowledgement unavailable",
          serviceSecret: SERVICE_SECRET,
        });
      assert.deepEqual(completionReadback, {
        terminal: true,
        status: "fetched",
      });
      assert.equal(
        db.row("ingestionRunChunks", `chunk:${target.receiptId}`)
          .terminalReceiptCount,
        1,
        "Completion readback must not double-increment the chunk.",
      );
    }
  }
  const run = db.row("ingestionRuns", initialLegacyEntries[0].runId);
  assert.equal(run.status, "completed");
  assert.equal(run.terminalReceiptCount, 3);
  assert.equal(run.failedReceiptCount, 0);
  assert.ok(run.finishedAt);
}

{
  const db = new MemoryDb(legacyInitialBatchSeed());
  await requeueInitialBatch(db);
  const unselected = LEGACY_DEFINITIVE_OUTPUT_RECOVERY_ALLOWLIST.find(
    (entry) =>
      !LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_RECEIPT_IDS.includes(
        entry.receiptId,
      ),
  );
  assert.ok(unselected);
  await assert.rejects(
    claimLegacyDefinitiveOutputRecoveryReceipt._handler(
      ctx(db),
      exactClaimArgs(initialLegacyEntries[0].receiptId, {
        selectedReceiptIds: [initialLegacyEntries[0].receiptId, unselected.receiptId],
      }),
    ),
    /one to three unique selected receipt IDs|initial selection/i,
  );
  await assert.rejects(
    claimLegacyDefinitiveOutputRecoveryReceipt._handler(
      ctx(db),
      exactClaimArgs(initialLegacyEntries[0].receiptId, {
        selectionSha256: "0".repeat(64),
      }),
    ),
    /protocol or manifest fence mismatch/i,
  );
}

// Exact recovery markers reserve only those rows. The generic consumer skips
// all three without starvation and claims the later ordinary candidate.
{
  const seed = legacyInitialBatchSeed();
  const db = new MemoryDb(seed);
  await requeueInitialBatch(db);
  const runId = initialLegacyEntries[0].runId;
  addOrdinaryProcessingCandidate(db, runId);
  const genericClaim = await claimNextProcessingReceipt._handler(ctx(db), {
    runId,
    workerId: "qa-generic-worker",
    serviceSecret: SERVICE_SECRET,
  });
  assert.equal(genericClaim?.receiptId, "zz-receipt-ordinary");
}

// Merely being one of the 47 historical allowlist rows does not reserve an
// untouched receipt; the durable recovery marker is mandatory.
{
  const entry = initialLegacyEntries[0];
  const seed = legacyRecoverySeed(
    entry,
    {
      processingStatus: "pending",
      processingOutcome: "saved_post_processing_pending",
      processingError: undefined,
      analysisAttemptRevision: undefined,
      analysisAttemptStartedAt: undefined,
      analysisAttemptOwner: undefined,
      analysisAttemptProtocol: undefined,
      blocksPaidFetch: true,
    },
    {
      status: "processing_pending",
      terminalAt: undefined,
      retryNotBeforeAt: now - 1,
      outcomeDetail: "saved_post_processing_pending",
    },
    {
      status: "queued",
      queueBuildCompletedAt: now - 10_000,
      dispatchReadyAt: now - 10_000,
      terminalReceiptCount: 0,
      failedReceiptCount: 0,
      finishedAt: undefined,
    },
  );
  seed.ingestionProviderLeases = [];
  const db = new MemoryDb(seed);
  const genericClaim = await claimNextProcessingReceipt._handler(ctx(db), {
    runId: entry.runId,
    workerId: "qa-untouched-worker",
    serviceSecret: SERVICE_SECRET,
  });
  assert.equal(genericClaim?.receiptId, entry.receiptId);
}

async function assertDedicatedRecoveryDoesNotStarveStatus(status) {
  const db = new MemoryDb(legacyInitialBatchSeed());
  await requeueInitialBatch(db);
  const runId = initialLegacyEntries[0].runId;
  for (const entry of initialLegacyEntries) {
    await db.patch(entry.receiptId, {
      status,
      outcomeDetail:
        status === "deferred"
          ? "OpenAI provider execution lease is busy."
          : "saved_post_definitive_output_requeued",
      terminalAt: status === "deferred" ? now - 1_000 : undefined,
      retryNotBeforeAt: now - 1,
    });
  }
  await db.patch(runId, {
    status: "queued",
    selectedHandleCount: 4,
    queueBuildCompletedAt: now - 20_000,
    dispatchReadyAt: now - 20_000,
    finishedAt: undefined,
  });
  db.table("scrapedPosts").set(`post:ordinary:${status}`, {
    _id: `post:ordinary:${status}`,
    handle: `ordinary_${status}`,
    postId: `ordinary-${status}`,
    instagramPostUrl: `https://www.instagram.com/p/ordinary-${status}/`,
    username: `ordinary_${status}`,
    imageUrls: [],
    sourceRevision: 1,
    processingStatus: "pending",
    blocksPaidFetch: true,
    createdAt: now - 2_000,
    updatedAt: now - 1_000,
  });
  db.table("ingestionRunChunks").set(`chunk:ordinary:${status}`, {
    _id: `chunk:ordinary:${status}`,
    runId,
    status: status === "deferred" ? "completed" : "running",
    handleCount: 1,
    terminalReceiptCount: status === "deferred" ? 1 : 0,
    createdAt: now - 2_000,
    updatedAt: now - 1_000,
  });
  db.table("ingestionRunHandleReceipts").set(`zz-receipt-ordinary-${status}`, {
    _id: `zz-receipt-ordinary-${status}`,
    runId,
    chunkId: `chunk:ordinary:${status}`,
    handle: `ordinary_${status}`,
    status,
    attemptCount: 1,
    providerAttemptCount: 1,
    providerResultStatus: "persisted",
    persistedPostCount: 1,
    scrapedPostId: `post:ordinary:${status}`,
    scrapedPostSourceRevision: 1,
    processingAttemptCount: 0,
    retryNotBeforeAt: now - 1,
    outcomeDetail:
      status === "deferred"
        ? "OpenAI provider execution lease is busy."
        : "saved_post_processing_pending",
    terminalAt: status === "deferred" ? now - 1_000 : undefined,
    createdAt: now - 2_000,
    updatedAt: now - 1_000,
  });
  const claim = await claimNextProcessingReceipt._handler(ctx(db), {
    runId,
    workerId: `qa-${status}-worker`,
    serviceSecret: SERVICE_SECRET,
  });
  assert.equal(claim?.receiptId, `zz-receipt-ordinary-${status}`);
}

await assertDedicatedRecoveryDoesNotStarveStatus("queued");
await assertDedicatedRecoveryDoesNotStarveStatus("deferred");

// The generic expired-lease sweep also skips an exact recovery marker before
// handling a later ordinary expired receipt. It must leave the selected row
// byte-for-byte claimable by the exact lane after an acknowledgement loss.
{
  const db = new MemoryDb(legacyInitialBatchSeed());
  await requeueInitialBatch(db);
  const target = initialLegacyEntries[0];
  await claimLegacyDefinitiveOutputRecoveryReceipt._handler(
    ctx(db),
    exactClaimArgs(target.receiptId, {
      selectedReceiptIds: [target.receiptId],
      workerId: "qa-expired-exact-owner",
    }),
  );
  await db.patch(target.receiptId, { leaseExpiresAt: now - 1 });
  await db.patch(target.runId, { selectedHandleCount: 4 });
  db.table("scrapedPosts").set("post:ordinary-expired", {
    _id: "post:ordinary-expired",
    handle: "ordinary_expired",
    postId: "ordinary-expired",
    instagramPostUrl: "https://www.instagram.com/p/ordinary-expired/",
    username: "ordinary_expired",
    imageUrls: [],
    sourceRevision: 1,
    processingStatus: "processing",
    processingAttempts: 1,
    processingOutcome: "processing",
    processingLeaseOwner: "qa-ordinary-expired-owner",
    processingLeaseExpiresAt: now - 1,
    blocksPaidFetch: true,
    createdAt: now - 2_000,
    updatedAt: now - 1_000,
  });
  db.table("ingestionRunChunks").set("chunk:ordinary-expired", {
    _id: "chunk:ordinary-expired",
    runId: target.runId,
    status: "running",
    handleCount: 1,
    terminalReceiptCount: 0,
    createdAt: now - 2_000,
    updatedAt: now - 1_000,
  });
  db.table("ingestionRunHandleReceipts").set("zz-receipt-ordinary-expired", {
    _id: "zz-receipt-ordinary-expired",
    runId: target.runId,
    chunkId: "chunk:ordinary-expired",
    handle: "ordinary_expired",
    status: "processing",
    attemptCount: 1,
    providerAttemptCount: 1,
    providerResultStatus: "persisted",
    persistedPostCount: 1,
    scrapedPostId: "post:ordinary-expired",
    scrapedPostSourceRevision: 1,
    processingAttemptCount: 1,
    leaseOwner: "qa-ordinary-expired-owner",
    leaseExpiresAt: now - 1,
    createdAt: now - 2_000,
    updatedAt: now - 1_000,
  });
  assert.equal(
    await claimNextProcessingReceipt._handler(ctx(db), {
      runId: target.runId,
      workerId: "qa-generic-expired-sweep",
      serviceSecret: SERVICE_SECRET,
    }),
    null,
  );
  assert.equal(
    db.row("ingestionRunHandleReceipts", target.receiptId).status,
    "processing",
    "Generic expiry recovery must not mutate the exact selected receipt.",
  );
  assert.equal(
    db.row("ingestionRunHandleReceipts", "zz-receipt-ordinary-expired").status,
    "processing_pending",
  );
  const ordinaryClaim = await claimNextProcessingReceipt._handler(ctx(db), {
    runId: target.runId,
    workerId: "qa-generic-expired-claim",
    serviceSecret: SERVICE_SECRET,
  });
  assert.equal(ordinaryClaim?.receiptId, "zz-receipt-ordinary-expired");
  await db.patch("post:ordinary-expired", {
    processingStatus: "completed",
    processingOutcome: "receipt_complete",
    processingLeaseOwner: undefined,
    processingLeaseExpiresAt: undefined,
    blocksPaidFetch: false,
  });
  await completeProcessingReceipt._handler(ctx(db), {
    runId: target.runId,
    receiptId: "zz-receipt-ordinary-expired",
    workerId: "qa-generic-expired-claim",
    serviceSecret: SERVICE_SECRET,
  });
  assert.equal(
    db.row("ingestionRunChunks", "chunk:ordinary-expired").status,
    "completed",
  );
  const exactReclaim =
    await claimLegacyDefinitiveOutputRecoveryReceipt._handler(
      ctx(db),
      exactClaimArgs(target.receiptId, {
        selectedReceiptIds: [target.receiptId],
        workerId: "qa-exact-expired-reclaim",
      }),
    );
  assert.equal(exactReclaim.claimed, true);
  assert.equal(exactReclaim.state, "claimed");
}

// Ordinary expired processing at the retry ceiling terminalizes both receipt
// and chunk exactly once.
{
  const entry = initialLegacyEntries[0];
  const seed = legacyRecoverySeed(
    entry,
    {
      processingStatus: "processing",
      processingOutcome: "processing",
      processingLeaseOwner: "qa-expired-limit-owner",
      processingLeaseExpiresAt: now - 1,
      analysisAttemptRevision: undefined,
      analysisAttemptStartedAt: undefined,
      analysisAttemptOwner: undefined,
      analysisAttemptProtocol: undefined,
      blocksPaidFetch: true,
    },
    {
      status: "processing",
      processingAttemptCount: 3,
      leaseOwner: "qa-expired-limit-owner",
      leaseExpiresAt: now - 1,
      terminalAt: undefined,
      outcomeDetail: "saved_post_processing_claimed",
    },
    {
      status: "queued",
      queueBuildCompletedAt: now - 10_000,
      dispatchReadyAt: now - 10_000,
      terminalReceiptCount: 0,
      failedReceiptCount: 0,
      finishedAt: undefined,
    },
  );
  seed.ingestionRunChunks[0] = {
    ...seed.ingestionRunChunks[0],
    status: "running",
    terminalReceiptCount: 0,
  };
  seed.ingestionProviderLeases = [];
  const db = new MemoryDb(seed);
  assert.equal(
    await claimNextProcessingReceipt._handler(ctx(db), {
      runId: entry.runId,
      workerId: "qa-expired-limit-sweep",
      serviceSecret: SERVICE_SECRET,
    }),
    null,
  );
  assert.equal(
    db.row("ingestionRunHandleReceipts", entry.receiptId).status,
    "failed",
  );
  assert.equal(
    db.row("ingestionRunChunks", `chunk:${entry.receiptId}`)
      .terminalReceiptCount,
    1,
  );
  assert.equal(
    db.row("ingestionRunChunks", `chunk:${entry.receiptId}`).status,
    "completed",
  );
}

// A lost exact-claim acknowledgement can be reconciled after lease expiry if
// no provider attempt marker exists; it never needs another generic claim.
{
  const db = new MemoryDb(legacyInitialBatchSeed());
  await requeueInitialBatch(db);
  const target = initialLegacyEntries[0];
  await claimLegacyDefinitiveOutputRecoveryReceipt._handler(
    ctx(db),
    exactClaimArgs(target.receiptId),
  );
  await db.patch(target.receiptId, { leaseExpiresAt: now - 1 });
  const reclaimed = await claimLegacyDefinitiveOutputRecoveryReceipt._handler(
    ctx(db),
    exactClaimArgs(target.receiptId, { workerId: "qa-recovery-readback-worker" }),
  );
  assert.equal(reclaimed.claimed, true);
  assert.equal(reclaimed.processingAttemptCount, 3);
}

// A route death after transport start is one-shot: the exact claimant
// terminalizes the ambiguous generation, and a lost acknowledgement is
// replay-readable without another claim or transport.
{
  const db = new MemoryDb(legacyInitialBatchSeed());
  await requeueInitialBatch(db);
  const target = initialLegacyEntries[0];
  await claimLegacyDefinitiveOutputRecoveryReceipt._handler(
    ctx(db),
    exactClaimArgs(target.receiptId),
  );
  await db.patch(target.receiptId, { leaseExpiresAt: now - 1 });
  await db.patch(target.savedPostId, {
    processingStatus: "retryable_failure",
    processingOutcome: "openai_transport_ambiguous",
    processingLeaseOwner: undefined,
    processingLeaseExpiresAt: undefined,
    analysisAttemptRevision: target.sourceRevision,
    analysisAttemptStartedAt: now - 5_000,
    analysisAttemptOwner: "qa-recovery-transport-owner",
    analysisAttemptProtocol: EVENT_EXTRACTION_ANALYSIS_PROTOCOL,
    analysisRevision: undefined,
    analysisResultJson: undefined,
  });
  const ambiguous = await claimLegacyDefinitiveOutputRecoveryReceipt._handler(
    ctx(db),
    exactClaimArgs(target.receiptId),
  );
  assert.equal(ambiguous.claimed, false);
  assert.equal(ambiguous.state, "transport_ambiguous");
  const replay = await claimLegacyDefinitiveOutputRecoveryReceipt._handler(
    ctx(db),
    exactClaimArgs(target.receiptId),
  );
  assert.equal(replay.claimed, false);
  assert.equal(replay.state, "transport_ambiguous");
  assert.equal(
    db.row("ingestionRunHandleReceipts", target.receiptId).status,
    "failed",
  );
}

// A committed, exact v2 analysis survives route death and is reclaimed only
// for cached materialization. The next helper invocation cannot start OpenAI.
{
  const db = new MemoryDb(legacyInitialBatchSeed());
  await requeueInitialBatch(db);
  const target = initialLegacyEntries[0];
  await claimLegacyDefinitiveOutputRecoveryReceipt._handler(
    ctx(db),
    exactClaimArgs(target.receiptId, {
      selectedReceiptIds: [target.receiptId],
      workerId: "qa-cached-analysis-first-owner",
    }),
  );
  await db.patch(target.receiptId, { leaseExpiresAt: now - 1 });
  await db.patch(target.savedPostId, {
    processingStatus: "retryable_failure",
    processingOutcome: "processing_exception",
    processingLeaseOwner: undefined,
    processingLeaseExpiresAt: undefined,
    analysisAttemptRevision: target.sourceRevision,
    analysisAttemptStartedAt: now - 5_000,
    analysisAttemptOwner: "qa-cached-analysis-first-owner",
    analysisAttemptProtocol: EVENT_EXTRACTION_ANALYSIS_PROTOCOL,
    analysisRevision: target.sourceRevision,
    analysisResultJson: JSON.stringify(compactExtraction),
    analysisCompletedAt: now - 1_000,
    analysisModel: "gpt-5-mini",
    analysisContractVersion: "event_evidence_v2",
    analysisIsEvent: true,
  });
  const cachedReclaim =
    await claimLegacyDefinitiveOutputRecoveryReceipt._handler(
      ctx(db),
      exactClaimArgs(target.receiptId, {
        selectedReceiptIds: [target.receiptId],
        workerId: "qa-cached-analysis-resume-owner",
      }),
    );
  assert.equal(cachedReclaim.claimed, true);
  assert.equal(
    db.row("scrapedPosts", target.savedPostId).processingOutcome,
    "definitive_output_recovery_materialization_resume",
  );
}

// Active provider or non-target selected leases block the whole exact batch
// before any selected target is mutated.
{
  const db = new MemoryDb(legacyInitialBatchSeed());
  await requeueInitialBatch(db);
  db.table("ingestionProviderLeases").set("provider:openai", {
    _id: "provider:openai",
    provider: "openai",
    owner: "qa-existing-openai-owner",
    leaseExpiresAt: Date.now() + 60_000,
    createdAt: now - 1_000,
    updatedAt: now - 1_000,
  });
  await assert.rejects(
    claimLegacyDefinitiveOutputRecoveryReceipt._handler(
      ctx(db),
      exactClaimArgs(initialLegacyEntries[0].receiptId, {
        selectedReceiptIds: [initialLegacyEntries[0].receiptId],
      }),
    ),
    /active OpenAI provider lease/i,
  );
}

{
  const db = new MemoryDb(legacyInitialBatchSeed());
  await requeueInitialBatch(db);
  await db.patch(initialLegacyEntries[1].receiptId, {
    status: "processing",
    leaseOwner: "qa-other-selected-owner",
    leaseExpiresAt: Date.now() + 60_000,
  });
  await assert.rejects(
    claimLegacyDefinitiveOutputRecoveryReceipt._handler(
      ctx(db),
      exactClaimArgs(initialLegacyEntries[0].receiptId),
    ),
    /active lease anywhere in the selected batch/i,
  );
}

if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
else process.env.CRON_SECRET = previousCronSecret;
if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
else process.env.OPENAI_API_KEY = previousOpenAiKey;
if (previousVisionModel === undefined) delete process.env.OPENAI_VISION_MODEL;
else process.env.OPENAI_VISION_MODEL = previousVisionModel;

console.log("Definitive OpenAI output recovery QA passed.");
