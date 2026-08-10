import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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

console.log("durable execute-route lease classification QA passed");
