import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

import {
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_RECEIPT_IDS,
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_SHA256,
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_VERSION,
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_MANIFEST_VERSION,
} from "../convex/legacyDefinitiveOutputRecoveryAllowlist.ts";

const routePath =
  "app/api/cron/durable-ingestion/recover-definitive-output/route.ts";
const route = readFileSync(routePath, "utf8");

assert.match(route, /export const maxDuration = 1_200/);
assert.match(route, /MAX_OPENAI_TRANSPORT_ATTEMPTS = 3/);
assert.match(route, /claimLegacyDefinitiveOutputRecoveryReceipt/);
assert.match(route, /processSavedScrapedPostForDurableReceipt/);
assert.doesNotMatch(route, /scrapeInstagramAccount|instagram-scraper|executeNext|markReceiptProviderAttemptStarted|persistScrapedPostsForHandle/i);
assert.doesNotMatch(route, /\bapify\b/i);
assert.ok(
  route.indexOf("options.onOpenAiTransportStarted?.()") === -1,
  "Transport accounting is supplied to the existing helper, not bypassed in the route.",
);

const transpiledRoute = ts.transpileModule(route, {
  compilerOptions: {
    esModuleInterop: true,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: routePath,
}).outputText;

const claimReference =
  "durableIngestionRuns:claimLegacyDefinitiveOutputRecoveryReceipt";
const completeReference = "durableIngestionRuns:completeProcessingReceipt";
const releaseReference = "durableIngestionRuns:releaseProcessingReceiptForRetry";
const receiptIds = [...LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_RECEIPT_IDS];

function claimFor(receiptId) {
  const ordinal = receiptIds.indexOf(receiptId);
  return {
    claimed: true,
    state: "claimed",
    runId: "run-initial-three",
    receiptId,
    handle: `handle-${ordinal}`,
    scrapedPostId: `post-${ordinal}`,
    scrapedPostSourceRevision: ordinal + 1,
    processingAttemptCount: 2,
    providerAttemptCount: 1,
  };
}

function loadRouteWithMocks({
  authorized = true,
  mutation,
  processSavedPost,
}) {
  const convex = { mutation };
  const mocks = new Map([
    ["node:crypto", { randomUUID: () => "qa-recovery-batch" }],
    [
      "next/server",
      {
        NextResponse: {
          json(body, init) {
            return new Response(JSON.stringify(body), {
              status: init?.status ?? 200,
              headers: { "content-type": "application/json" },
            });
          },
        },
      },
    ],
    [
      "@/convex/legacyDefinitiveOutputRecoveryAllowlist",
      {
        LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_RECEIPT_IDS,
        LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_SHA256,
        LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_VERSION,
        LEGACY_DEFINITIVE_OUTPUT_RECOVERY_MANIFEST_VERSION,
      },
    ],
    [
      "@/lib/ai/openai-analysis-protocol",
      { DEFINITIVE_OUTPUT_RECOVERY_PROTOCOL: "openai-definitive-output-requeue:v1" },
    ],
    [
      "@/lib/convex/server",
      {
        createConvexHttpClient: () => convex,
        requireServiceSecret: () => "qa-service-secret",
      },
    ],
    [
      "@/lib/pipeline/cron-ingestion-config",
      { isAuthorizedCronRequestHeader: () => authorized },
    ],
    [
      "@/lib/pipeline/durable-ingestion-execute",
      {
        isDurableSavedPostRevisionMismatch: (value) =>
          /source revision changed/i.test(String(value)),
        isTransientSavedPostProcessingError: (value) =>
          /provider execution lease is busy/i.test(String(value)),
      },
    ],
    [
      "@/lib/pipeline/run-instagram-ingestion",
      { processSavedScrapedPostForDurableReceipt: processSavedPost },
    ],
  ]);
  const routeModule = { exports: {} };
  const sandbox = {
    Error,
    Object,
    Set,
    URL,
    Request,
    Response,
    console,
    exports: routeModule.exports,
    module: routeModule,
    require(specifier) {
      const mocked = mocks.get(specifier);
      if (mocked) return mocked;
      throw new Error(`Unexpected recovery-route dependency: ${specifier}`);
    },
  };
  vm.runInNewContext(transpiledRoute, sandbox, { filename: routePath });
  return routeModule.exports.POST;
}

function execute(POST, overrides = {}, authorized = true) {
  return POST(new Request(
    "https://events.example/api/cron/durable-ingestion/recover-definitive-output",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorized ? { authorization: "Bearer qa" } : {}),
      },
      body: JSON.stringify({
        legacyManifestVersion: LEGACY_DEFINITIVE_OUTPUT_RECOVERY_MANIFEST_VERSION,
        selectionSha256: LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_SHA256,
        selectionVersion: LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_VERSION,
        receiptIds,
        ...overrides,
      }),
    },
  ));
}

{
  let mutationCalls = 0;
  const POST = loadRouteWithMocks({
    authorized: false,
    mutation: async () => {
      mutationCalls += 1;
    },
    processSavedPost: async () => {
      throw new Error("unauthorized request reached processing");
    },
  });
  assert.equal((await execute(POST, {}, false)).status, 401);
  assert.equal(mutationCalls, 0);
}

{
  let mutationCalls = 0;
  const POST = loadRouteWithMocks({
    mutation: async () => {
      mutationCalls += 1;
    },
    processSavedPost: async () => {
      throw new Error("invalid selection reached processing");
    },
  });
  assert.equal((await execute(POST, { receiptIds: [] })).status, 400);
  assert.equal(
    (await execute(POST, { receiptIds: [receiptIds[0], receiptIds[0]] })).status,
    400,
  );
  assert.equal(
    (await execute(POST, { receiptIds: ["mx70cnynwsxfrcq21nnvvn16x98c9h6x"] })).status,
    400,
  );
  assert.equal(
    (await execute(POST, { selectionSha256: "0".repeat(64) })).status,
    400,
  );
  assert.equal(
    (await execute(POST, { selectionVersion: "legacy-selection-v2" })).status,
    400,
  );
  assert.equal(mutationCalls, 0);
}

// Exactly three selected rows can start exactly one transport each. Every
// claim receives the full immutable selection and the server-side SHA fence.
{
  let processCalls = 0;
  const POST = loadRouteWithMocks({
    mutation: async (reference, args) => {
      if (reference === claimReference) {
        assert.deepEqual([...args.selectedReceiptIds], receiptIds);
        assert.equal(args.selectionSha256, LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_SHA256);
        return claimFor(args.receiptId);
      }
      if (reference === completeReference) {
        return { status: "fetched", processingOutcome: "receipt_complete" };
      }
      throw new Error(`Unexpected three-row mutation: ${reference}`);
    },
    processSavedPost: async (options) => {
      processCalls += 1;
      options.onOpenAiTransportStarted();
      return { state: "terminal", outcome: "receipt_complete", transportAttempted: true };
    },
  });
  const response = await execute(POST);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.transportAttemptCount, 3);
  assert.equal(body.maxTransportAttemptCount, 3);
  assert.equal(body.processedCount, 3);
  assert.equal(body.stopped, false);
  assert.equal(processCalls, 3);
}

// A helper regression attempting a second transport for one target is stopped
// before that transport and before any later target is claimed.
{
  let claimCalls = 0;
  let releaseCalls = 0;
  const POST = loadRouteWithMocks({
    mutation: async (reference, args) => {
      if (reference === claimReference) {
        claimCalls += 1;
        return claimFor(args.receiptId);
      }
      if (reference === releaseReference) {
        releaseCalls += 1;
        return { terminal: false, status: "processing_pending" };
      }
      throw new Error(`Unexpected double-transport mutation: ${reference}`);
    },
    processSavedPost: async (options) => {
      options.onOpenAiTransportStarted();
      options.onOpenAiTransportStarted();
      throw new Error("unreachable");
    },
  });
  const response = await execute(POST);
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.transportAttemptCount, 1);
  assert.equal(body.stopReason, "processing_error");
  assert.equal(claimCalls, 1);
  assert.equal(releaseCalls, 1);
}

// Claim acknowledgement uncertainty is fail-closed: no processing or later
// exact claim occurs in this invocation.
{
  let claimCalls = 0;
  let processCalls = 0;
  const POST = loadRouteWithMocks({
    mutation: async (reference) => {
      assert.equal(reference, claimReference);
      claimCalls += 1;
      throw new Error("claim acknowledgement unavailable");
    },
    processSavedPost: async () => {
      processCalls += 1;
      throw new Error("unknown claim must not process");
    },
  });
  const response = await execute(POST);
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.stopReason, "durable_state_unknown");
  assert.equal(body.stage, "claim");
  assert.equal(claimCalls, 1);
  assert.equal(processCalls, 0);
}

// A terminal completion that committed but lost its acknowledgement is proven
// through the idempotent release readback and does not repeat transport.
{
  let completionCalls = 0;
  let releaseCalls = 0;
  const POST = loadRouteWithMocks({
    mutation: async (reference, args) => {
      if (reference === claimReference) return claimFor(args.receiptId);
      if (reference === completeReference) {
        completionCalls += 1;
        throw new Error("completion acknowledgement unavailable");
      }
      if (reference === releaseReference) {
        releaseCalls += 1;
        return { terminal: true, status: "fetched" };
      }
      throw new Error(`Unexpected completion-readback mutation: ${reference}`);
    },
    processSavedPost: async (options) => {
      options.onOpenAiTransportStarted();
      return { state: "terminal", outcome: "receipt_complete", transportAttempted: true };
    },
  });
  const response = await execute(POST, { receiptIds: [receiptIds[0]] });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.transportAttemptCount, 1);
  assert.equal(body.results[0].state, "terminal_readback");
  assert.equal(completionCalls, 1);
  assert.equal(releaseCalls, 1);
}

// A claimed row with exact cached v2 analysis runs materialization but starts
// zero transports.
{
  let processCalls = 0;
  const POST = loadRouteWithMocks({
    mutation: async (reference, args) => {
      if (reference === claimReference) return claimFor(args.receiptId);
      if (reference === completeReference) {
        return { status: "fetched", processingOutcome: "receipt_complete" };
      }
      throw new Error(`Unexpected cached-materialization mutation: ${reference}`);
    },
    processSavedPost: async () => {
      processCalls += 1;
      return {
        state: "terminal",
        outcome: "receipt_complete",
        transportAttempted: false,
      };
    },
  });
  const response = await execute(POST, { receiptIds: [receiptIds[0]] });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.transportAttemptCount, 0);
  assert.equal(body.results[0].state, "terminal");
  assert.equal(body.results[0].transportAttempted, false);
  assert.equal(processCalls, 1, "Cached v2 materialization still runs the exact helper once.");
}

// Already-terminal readback is zero-transport and zero-processing.
{
  let processCalls = 0;
  const POST = loadRouteWithMocks({
    mutation: async (reference, args) => {
      assert.equal(reference, claimReference);
      return { ...claimFor(args.receiptId), claimed: false, state: "already_terminal" };
    },
    processSavedPost: async () => {
      processCalls += 1;
      throw new Error("terminal readback must not process");
    },
  });
  const response = await execute(POST, { receiptIds: [receiptIds[0]] });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.transportAttemptCount, 0);
  assert.equal(processCalls, 0);
}

console.log("Definitive-output recovery executor QA passed.");
