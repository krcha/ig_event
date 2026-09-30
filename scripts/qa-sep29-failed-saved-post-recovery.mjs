import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildPlanForPosts,
  parseArgs,
  RUN_ID,
  TARGETS,
} from "./recover-sep29-failed-saved-posts.mjs";

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
  caption: "This must never enter the operator plan.",
}));

assert.equal(TARGETS.length, 8);
assert.equal(new Set(TARGETS.map((target) => target.savedPostId)).size, 8);
assert.equal(new Set(TARGETS.map((target) => target.receiptId)).size, 7);
assert.deepEqual(parseArgs([]), { apply: false, expectedHash: null });
assert.throws(() => parseArgs(["--apply"]), /Preview first/u);
assert.throws(() => parseArgs(["--unexpected"]), /Preview first/u);

const baseline = buildPlanForPosts(run, posts, Date.now());
assert.match(baseline.planSha256, /^[0-9a-f]{64}$/u);
assert.equal(baseline.plan.rows.filter((row) => row.disposition === "process_saved_post").length, 8);
assert.ok(!JSON.stringify(baseline.plan).includes("This must never"));
assert.equal(buildPlanForPosts(run, [...posts].reverse()).planSha256, baseline.planSha256);
assert.deepEqual(
  parseArgs(["--apply", "--expect-plan-sha256", baseline.planSha256]),
  { apply: true, expectedHash: baseline.planSha256 },
);

function changed(index, patch) {
  return posts.map((post, postIndex) => postIndex === index ? { ...post, ...patch } : post);
}

const terminalPlan = buildPlanForPosts(run, changed(0, {
  processingStatus: "completed",
  processingOutcome: "receipt_complete",
  updatedAt: posts[0].updatedAt + 1,
}));
assert.equal(terminalPlan.plan.rows[0].disposition, "already_terminal");
assert.notEqual(terminalPlan.planSha256, baseline.planSha256);

assert.throws(() => buildPlanForPosts(run, changed(0, { sourceRevision: 2 })), /identity or source revision changed/u);
assert.throws(() => buildPlanForPosts(run, changed(0, { postId: "different" })), /identity or source revision changed/u);
assert.throws(() => buildPlanForPosts(run, changed(0, { updatedAt: posts[0].updatedAt + 1 })), /Frozen processing state changed/u);
assert.throws(() => buildPlanForPosts(run, changed(0, { processingStatus: "processing" })), /Frozen processing state changed/u);
assert.throws(() => buildPlanForPosts(run, changed(0, { analysisAttemptRevision: 1 })), /transport is ambiguous/u);
assert.throws(() => buildPlanForPosts(run, changed(0, { processingRetryAt: Date.now() + 60_000 })), /retry cooldown remains active/u);
assert.throws(() => buildPlanForPosts(run, posts.slice(1)), /exact saved-post ID is missing/u);
assert.throws(() => buildPlanForPosts({ ...run, status: "running" }, posts), /not completed and idle/u);

const source = readFileSync(new URL("./recover-sep29-failed-saved-posts.mjs", import.meta.url), "utf8");
assert.match(source, /processSavedScrapedPostForDurableReceipt/u);
assert.match(source, /scrapedPosts:getManyByIds/u);
assert.doesNotMatch(source, /scrapeInstagramAccount|executeNext|markReceiptProviderAttemptStarted|persistScrapedPostsForHandle/u);

console.log("Sep 29 exact saved-post recovery QA passed.");
