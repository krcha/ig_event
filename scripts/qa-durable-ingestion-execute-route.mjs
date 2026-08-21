import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

process.env.CRON_SECRET = "qa-durable-execute-route-secret";

const {
  isDurableSavedPostRevisionMismatch,
  isTransientSavedPostProcessingError,
} = await import(
  "../lib/pipeline/durable-ingestion-execute.ts"
);

assert.equal(
  isDurableSavedPostRevisionMismatch(
    new Error("Cannot complete a receipt after its saved-post source revision changed."),
  ),
  true,
);

for (const leaseContention of [
  "OpenAI provider execution lease is busy.",
  "OpenAI provider execution lease could not be acquired.",
  "Saved post processing is busy; retry this saved post later.",
  "Saved post processing is deferred.",
  "normalization warning; OpenAI provider execution lease is busy; retry this saved post later.",
  new Error("outer executor error", {
    cause: new Error("OpenAI provider execution lease could not be acquired."),
  }),
]) {
  assert.equal(
    isTransientSavedPostProcessingError(leaseContention),
    true,
    `lease contention must preserve the provider attempt: ${leaseContention}`,
  );
}

assert.equal(
  isTransientSavedPostProcessingError("Apify request failed with status 500."),
  false,
  "a real provider failure must remain an explicit retryable failure",
);

const route = await readFile("app/api/cron/durable-ingestion/execute/route.ts", "utf8");
const ingestionPipeline = await readFile("lib/pipeline/run-instagram-ingestion.ts", "utf8");
const processingClaimOffset = route.indexOf("convex.mutation(claimProcessing");
const fetchClaimOffset = route.indexOf("convex.mutation(claim,");
const providerCallOffset = route.indexOf("scrapeInstagramAccount({");
assert.ok(processingClaimOffset >= 0 && processingClaimOffset < fetchClaimOffset);
assert.ok(fetchClaimOffset >= 0 && fetchClaimOffset < providerCallOffset);
assert.match(
  route.slice(processingClaimOffset, fetchClaimOffset),
  /workerSlot,/,
  "the route must identify its fixed slot to the single global AI claimant",
);
assert.match(
  route.slice(processingClaimOffset, fetchClaimOffset),
  /status: released\.terminal \? 200 : 202/,
  "durably released AI contention must return 202 instead of restarting curl/systemd",
);
assert.match(
  route,
  /if \(!alreadyFetched\)[\s\S]*scrapeInstagramAccount/,
  "only a receipt with zero provider attempts may enter Apify",
);
assert.match(
  route,
  /outcome: completion\.status/,
  "the route must report the server-derived permanent-failure or fetched/skip receipt status",
);
assert.doesNotMatch(
  route.slice(processingClaimOffset, fetchClaimOffset),
  /outcome: "fetched"/,
  "the AI route must not flatten permanent failures into fetched",
);
assert.match(
  route,
  /scrapedPostSourceRevision: selectedPersistedPost\.sourceRevision/,
  "the exact upsert revision must be fenced before it is stored on the receipt",
);
assert.match(
  route,
  /scrapedPostId: selectedPersistedPost\.scrapedPostId[\s\S]*postId: posts\[0\]\.postId[\s\S]*instagramPostUrl: posts\[0\]\.instagramPostUrl/,
  "the exact persisted row identity must cross the durable receipt boundary",
);
assert.match(
  route,
  /processingProtocolVersion: 1/,
  "only the new web protocol may hand a running receipt to the AI lane during rolling deployment",
);
assert.doesNotMatch(
  route,
  /runInstagramIngestion\(/,
  "the AI consumer must process the linked post rather than an arbitrary handle page",
);
assert.match(
  ingestionPipeline,
  /processingReasons\.find\(isTransientSavedPostProcessingError\)/,
  "wrapped or non-first AI lease contention must preserve the durable processing attempt",
);
assert.match(
  route,
  /expectedSourceRevision: processingClaim\.scrapedPostSourceRevision/,
  "the receipt revision must reach the exact-post helper",
);
assert.match(
  ingestionPipeline,
  /scrapedPostId: processingFence\.scrapedPostId/g,
  "every scraped-post processing fence write must retain the exact durable ID",
);

const transpiledRoute = ts.transpileModule(route, {
  compilerOptions: {
    esModuleInterop: true,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "app/api/cron/durable-ingestion/execute/route.ts",
}).outputText;

const claimProcessingReference = "durableIngestionRuns:claimNextProcessingReceipt";
const claimFetchReference = "durableIngestionRuns:executeNext";
const releaseProcessingReference = "durableIngestionRuns:releaseProcessingReceiptForRetry";
const markProviderAttemptReference = "durableIngestionRuns:markReceiptProviderAttemptStarted";
const retryFetchReference = "durableIngestionRuns:releaseReceiptForRetry";

const processingClaimFixture = {
  receiptId: "receipt-processing",
  handle: "qa_handle",
  scrapedPostId: "scraped-post-1",
  scrapedPostSourceRevision: 7,
  processingAttemptCount: 1,
  providerAttemptCount: 1,
};

function loadRouteWithMocks({
  authorized = true,
  mutation,
  query = async () => ({ complete: false, status: "running" }),
  processSavedPost = async () => ({
    state: "pending",
    reason: "OpenAI provider execution lease is busy.",
    retryAfterMs: 30_000,
  }),
  scrape = async () => {
    throw new Error("unexpected paid provider call in processing-route QA");
  },
  persist = async () => {
    throw new Error("unexpected persistence call in processing-route QA");
  },
}) {
  const convex = { mutation, query };
  const mocks = new Map([
    ["node:crypto", { randomUUID: () => "qa-worker-id" }],
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
      "@/lib/pipeline/cron-ingestion-config",
      { isAuthorizedCronRequestHeader: () => authorized },
    ],
    [
      "@/lib/convex/server",
      {
        createConvexHttpClient: () => convex,
        requireServiceSecret: () => "qa-service-secret",
      },
    ],
    [
      "@/lib/pipeline/run-instagram-ingestion",
      {
        persistScrapedPostsForHandle: persist,
        processSavedScrapedPostForDurableReceipt: processSavedPost,
      },
    ],
    ["@/lib/scraper/instagram-scraper", { scrapeInstagramAccount: scrape }],
    [
      "@/lib/pipeline/durable-ingestion-execute",
      {
        isDurableSavedPostRevisionMismatch,
        isTransientSavedPostProcessingError,
      },
    ],
  ]);
  const routeModule = { exports: {} };
  const sandbox = {
    Error,
    URL,
    Request,
    Response,
    console,
    exports: routeModule.exports,
    module: routeModule,
    require(specifier) {
      const mocked = mocks.get(specifier);
      if (mocked) return mocked;
      throw new Error(`Unexpected route dependency in QA harness: ${specifier}`);
    },
  };
  vm.runInNewContext(transpiledRoute, sandbox, {
    filename: "app/api/cron/durable-ingestion/execute/route.ts",
  });
  return routeModule.exports.POST;
}

function executeRequest(POST, queryString = "?runId=run-1&workerSlot=0", authorized = true) {
  return POST(new Request(`https://events.example/api/cron/durable-ingestion/execute${queryString}`, {
    method: "POST",
    headers: authorized ? { authorization: "Bearer qa" } : {},
  }));
}

async function assertDeferredExecutorResponse(response, claimState, message) {
  assert.equal(response.status, 202, message);
  assert.deepEqual(await response.json(), {
    ...claimState,
    retryDeferred: true,
    durableStateUnknown: true,
    error: "durable_executor_temporarily_unavailable",
  });
}

{
  let receiptState = "processing";
  let releaseCalls = 0;
  let fetchClaimCalls = 0;
  const POST = loadRouteWithMocks({
    mutation: async (reference) => {
      if (reference === claimProcessingReference) return processingClaimFixture;
      if (reference === releaseProcessingReference) {
        releaseCalls += 1;
        if (releaseCalls === 1) {
          receiptState = "processing_pending";
          throw new Error("release response acknowledgement was lost after commit");
        }
        assert.equal(
          receiptState,
          "processing_pending",
          "the replay must observe the already-committed processing_pending receipt",
        );
        return { terminal: false, status: "processing_pending" };
      }
      if (reference === claimFetchReference) fetchClaimCalls += 1;
      throw new Error(`Unexpected mutation in ACK-loss test: ${reference}`);
    },
  });
  const response = await executeRequest(POST);
  assert.equal(response.status, 202, "a successful release replay after ACK loss must stay retryable");
  assert.equal(releaseCalls, 2, "the route must replay a release whose acknowledgement was lost");
  assert.equal(fetchClaimCalls, 0, "a processing release replay must never fall through to paid fetch work");
}

{
  const POST = loadRouteWithMocks({
    mutation: async (reference) => {
      assert.equal(reference, claimProcessingReference);
      throw new Error("temporary Convex claim transport failure");
    },
  });
  await assertDeferredExecutorResponse(
    await executeRequest(POST),
    { claimState: "unknown" },
    "a thrown Convex processing-claim failure must not escape as HTTP 5xx",
  );
}

{
  let releaseCalls = 0;
  let fetchClaimCalls = 0;
  const POST = loadRouteWithMocks({
    mutation: async (reference) => {
      if (reference === claimProcessingReference) return processingClaimFixture;
      if (reference === releaseProcessingReference) {
        releaseCalls += 1;
        throw new Error("temporary Convex release transport failure");
      }
      if (reference === claimFetchReference) fetchClaimCalls += 1;
      throw new Error(`Unexpected mutation in double-release-outage test: ${reference}`);
    },
  });
  await assertDeferredExecutorResponse(
    await executeRequest(POST),
    { claimed: true },
    "a double release outage must remain behind the outer retry boundary",
  );
  assert.equal(releaseCalls, 2, "the route must try the normal release and one catch-path replay");
  assert.equal(fetchClaimCalls, 0, "release infrastructure failure must never enter the paid fetch lane");
}

{
  const POST = loadRouteWithMocks({
    mutation: async (reference) => {
      if (reference === claimProcessingReference || reference === claimFetchReference) return null;
      throw new Error(`Unexpected mutation in probe-outage test: ${reference}`);
    },
    query: async () => {
      throw new Error("temporary Convex probe transport failure");
    },
  });
  await assertDeferredExecutorResponse(
    await executeRequest(POST),
    { claimed: false },
    "a failed probe after both claims return null must report definitely unclaimed work",
  );
}

{
  let mutationCalls = 0;
  const POST = loadRouteWithMocks({
    authorized: false,
    mutation: async () => {
      mutationCalls += 1;
      throw new Error("unauthorized requests must not reach Convex");
    },
  });
  assert.equal((await executeRequest(POST, "?runId=run-1&workerSlot=0", false)).status, 401);
  assert.equal(mutationCalls, 0);
}

{
  let mutationCalls = 0;
  const POST = loadRouteWithMocks({
    mutation: async () => {
      mutationCalls += 1;
      throw new Error("invalid requests must not reach Convex");
    },
  });
  assert.equal((await executeRequest(POST, "?workerSlot=0")).status, 400);
  assert.equal((await executeRequest(POST, "?runId=run-1&workerSlot=6")).status, 400);
  assert.equal(mutationCalls, 0);
}

{
  const fetchClaim = {
    receiptId: "receipt-fetch",
    handle: "qa_fetch_handle",
    controls: {
      resultsLimit: 1,
      skipPinnedPosts: true,
      ignoreCheckpoint: true,
      ignoreCooldown: true,
      costPerProfileMicros: 10_000,
    },
    providerAttemptCount: 0,
  };
  const POST = loadRouteWithMocks({
    mutation: async (reference) => {
      if (reference === claimProcessingReference) return null;
      if (reference === claimFetchReference) return fetchClaim;
      if (reference === markProviderAttemptReference) return { started: true };
      if (reference === retryFetchReference) return { terminal: false };
      throw new Error(`Unexpected mutation in paid-fetch failure test: ${reference}`);
    },
    scrape: async () => {
      throw new Error("Apify request failed with status 500.");
    },
  });
  const response = await executeRequest(POST);
  assert.equal(response.status, 503, "the outer thrown-error boundary must preserve deliberate paid-fetch 503 responses");
}

console.log("durable execute-route lease classification and resilience QA passed");
