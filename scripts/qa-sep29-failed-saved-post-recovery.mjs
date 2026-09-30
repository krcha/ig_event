import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assertCachedReplayTerminal,
  blockOpenAiTransport,
  buildPlanForPosts,
  disableOpenAiCredential,
  parseArgs,
  RUN_ID,
  TARGETS,
  TEATAR_SAVED_POST_ID,
  MAMA_SAVED_POST_ID,
  MAMA_SEMANTIC_CONFLICT,
} from "./recover-sep29-failed-saved-posts.mjs";

const NOW = 1790740000000;
const run = {
  runId: RUN_ID,
  mode: "daily",
  status: "completed",
  complete: true,
  inFlightCount: 0,
};
const posts = TARGETS.map((target) => ({
  _id: target.savedPostId,
  handle: target.handle,
  sourceRevision: target.sourceRevision,
  postId: target.postId,
  instagramPostUrl: target.postUrl,
  processingStatus: "retryable_failure",
  processingOutcome: target.outcome,
  updatedAt: target.updatedAt,
  analysisAttemptRevision: target.sourceRevision,
  analysisRevision: target.sourceRevision,
  analysisAttemptProtocol: "openai-responses:event-extraction:event_evidence_v2:compact_medium:max_output_tokens_16384:v2",
  analysisContractVersion: "event_evidence_v2",
  analysisAttemptStartedAt: 1790665000000,
  analysisCompletedAt: 1790665001000,
  analysisAttemptOwner: "qa-worker",
  analysisModel: "gpt-5-mini-2025-08-07",
  analysisIsEvent: true,
  analysisResultJson: JSON.stringify({ extraction_contract_version: "event_evidence_v2", is_event: true }),
  analysisImageSourceUrl: "https://example.com/poster.jpg",
  analysisImageChecksumSha256: "a".repeat(64),
  caption: "This must never enter the operator plan.",
  ...(target.savedPostId === TEATAR_SAVED_POST_ID
    ? { processingRetryAt: NOW + 6_000_000 }
    : {}),
  ...(target.savedPostId === MAMA_SAVED_POST_ID
    ? { processingRetryAt: 1790744480744, processingError: MAMA_SEMANTIC_CONFLICT }
    : {}),
}));
const parseCachedAnalysis = (value) => {
  assert.equal(value.extraction_contract_version, "event_evidence_v2");
  assert.equal(value.is_event, true);
  return value;
};
const planFor = (runState, postRows, now = NOW) =>
  buildPlanForPosts(runState, postRows, parseCachedAnalysis, now);

assert.equal(TARGETS.length, 7);
assert.equal(new Set(TARGETS.map((target) => target.savedPostId)).size, 7);
assert.equal(new Set(TARGETS.map((target) => target.receiptId)).size, 6);
assert.ok(TARGETS.every((target) => target.handle !== "ligapub.bg"));
assert.equal(TARGETS[0].savedPostId, TEATAR_SAVED_POST_ID);
assert.equal(TARGETS[1].savedPostId, MAMA_SAVED_POST_ID);
assert.deepEqual(parseArgs([]), { apply: false, expectedHash: null });
assert.throws(() => parseArgs(["--apply"]), /Preview first/u);
assert.throws(() => parseArgs(["--unexpected"]), /Preview first/u);
assert.throws(() => parseArgs(["--hold-teatar-cooldown"]), /Preview first/u);
assert.throws(blockOpenAiTransport, /transport is forbidden/u);
assert.doesNotThrow(() => assertCachedReplayTerminal({ state: "terminal", transportAttempted: false }, false, "post"));
assert.throws(() => assertCachedReplayTerminal({ state: "terminal", transportAttempted: false }, true, "post"), /attempted OpenAI transport/u);
assert.throws(() => assertCachedReplayTerminal({ state: "pending", transportAttempted: false, reason: "cache miss" }, false, "post"), /did not reach a terminal outcome/u);
const envWithKey = { OPENAI_API_KEY: "should-be-removed" };
disableOpenAiCredential(envWithKey);
assert.equal(envWithKey.OPENAI_API_KEY, undefined);
const envWithoutKey = {};
disableOpenAiCredential(envWithoutKey);
assert.equal(envWithoutKey.OPENAI_API_KEY, undefined);

const baseline = planFor(run, posts);
assert.match(baseline.planSha256, /^[0-9a-f]{64}$/u);
assert.equal(baseline.plan.rows.filter((row) => row.disposition === "process_saved_post").length, 5);
assert.equal(baseline.plan.rows[0].disposition, "held_retry_cooldown");
assert.equal(baseline.plan.rows[1].disposition, "held_semantic_conflict");
assert.deepEqual(baseline.plan.heldPostIds, [TEATAR_SAVED_POST_ID, MAMA_SAVED_POST_ID]);
assert.equal(baseline.plan.openAiTransportAllowed, false);
assert.ok(!JSON.stringify(baseline.plan).includes("This must never"));
assert.ok(!JSON.stringify(baseline.plan).includes("https://example.com/poster.jpg"));
assert.ok(!JSON.stringify(baseline.plan).includes(MAMA_SEMANTIC_CONFLICT));
assert.equal(planFor(run, [...posts].reverse()).planSha256, baseline.planSha256);
assert.deepEqual(
  parseArgs(["--apply", "--expect-plan-sha256", baseline.planSha256]),
  { apply: true, expectedHash: baseline.planSha256 },
);

assert.throws(() => planFor(run, posts, NOW + 6_000_000), /retry cooldown is not active/u);
assert.throws(() => planFor(run, posts.slice(1)), /exact saved-post ID is missing/u);

function changed(index, patch) {
  return posts.map((post, postIndex) => postIndex === index ? { ...post, ...patch } : post);
}

const terminalPlan = planFor(run, changed(2, {
  processingStatus: "completed",
  processingOutcome: "receipt_complete",
  updatedAt: posts[2].updatedAt + 1,
}));
assert.equal(terminalPlan.plan.rows[2].disposition, "already_terminal");
assert.notEqual(terminalPlan.planSha256, baseline.planSha256);

assert.throws(() => planFor(run, changed(0, { sourceRevision: 2 })), /identity or source revision changed/u);
assert.throws(() => planFor(run, changed(0, { postId: "different" })), /identity or source revision changed/u);
assert.throws(() => planFor(run, changed(0, { updatedAt: posts[0].updatedAt + 1 })), /Frozen held-post processing state changed/u);
assert.throws(() => planFor(run, changed(0, { processingStatus: "processing" })), /Frozen held-post processing state changed/u);
assert.throws(() => planFor(run, changed(1, { processingStatus: "completed" })), /Frozen held-post processing state changed/u);
assert.throws(() => planFor(run, changed(1, { processingOutcome: "processing_failed" })), /Frozen held-post processing state changed/u);
assert.throws(() => planFor(run, changed(1, { updatedAt: posts[1].updatedAt + 1 })), /Frozen held-post processing state changed/u);
assert.throws(() => planFor(run, changed(1, { processingError: "different error" })), /Mama Shelter semantic conflict changed/u);
assert.throws(() => planFor(run, changed(1, { processingError: undefined })), /Mama Shelter semantic conflict changed/u);
assert.throws(() => planFor(run, changed(1, { processingRetryAt: NOW - 1 })), /retry cooldown is not active/u);
assert.throws(() => planFor(run, changed(0, { processingRetryAt: NOW - 1 })), /retry cooldown is not active/u);
assert.notEqual(planFor(run, changed(1, { processingRetryAt: posts[1].processingRetryAt + 1 })).planSha256, baseline.planSha256);
assert.notEqual(planFor(run, changed(0, { processingError: "Teatar held for cooldown." })).planSha256, baseline.planSha256);
assert.throws(() => planFor(run, changed(0, { analysisAttemptRevision: null })), /lacks valid current cached analysis/u);
assert.throws(() => planFor(run, changed(0, { analysisResultJson: "not-json" })), /fails the production event-evidence parser/u);
assert.throws(() => planFor(run, changed(0, { analysisResultJson: JSON.stringify({ extraction_contract_version: "event_evidence_v2", is_event: false }) })), /fails the production event-evidence parser/u);
assert.throws(() => buildPlanForPosts(run, changed(0, { analysisResultJson: JSON.stringify({ extraction_contract_version: "event_evidence_v2", is_event: false }) }), (value) => value), /not an event-evidence-v2 event/u);
assert.throws(() => planFor(run, changed(0, { analysisImageChecksumSha256: null })), /lacks valid current cached analysis/u);
assert.throws(() => planFor(run, changed(2, { processingRetryAt: NOW + 60_000 })), /retry cooldown remains active/u);
assert.throws(() => planFor(run, posts.slice(1)), /exact saved-post ID is missing/u);
assert.throws(() => planFor({ ...run, status: "running" }, posts), /not completed and idle/u);

const source = readFileSync(new URL("./recover-sep29-failed-saved-posts.mjs", import.meta.url), "utf8");
assert.match(source, /processSavedScrapedPostForDurableReceipt/u);
assert.match(source, /scrapedPosts:getManyByIds/u);
assert.match(source, /onOpenAiTransportStarted: \(\) => \{[\s\S]*blockOpenAiTransport\(\)/u);
assert.match(source, /disableOpenAiCredential\(process\.env\)/u);
assert.doesNotMatch(source, /scrapeInstagramAccount|executeNext|markReceiptProviderAttemptStarted|persistScrapedPostsForHandle/u);

console.log("Sep 29 cached-only saved-post recovery QA passed.");
