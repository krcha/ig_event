import crypto from "node:crypto";
import { ConvexHttpClient } from "convex/browser";

// One saved request was definitely rejected by OpenAI because the standalone
// operator used a model that does not support the extraction request. Preview
// the exact persisted failure before authorizing its one-time requeue.
const CONVEX_URL = "https://convex-events.ineedtofeedmyrabbit.com";
const SAVED_POST_ID = "jn79z8b64q8jkt89a5frcthjg58f0bd8";
const POST_URL = "https://www.instagram.com/p/Ddo4DGsNlYf/";
const OPERATOR_EVIDENCE_SHA256 = "2d9e751127d249ad115c1c18b7ca6c96771b0e963199e607d89a91d1f7292cd2";
const EXPECTED_ATTEMPT_PROTOCOL = "openai-responses:event-extraction:event_evidence_v2:compact_medium:max_output_tokens_16384:v2";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function loadPost(client, serviceSecret) {
  const rows = await client.query("scrapedPosts:getManyByIds", {
    ids: [SAVED_POST_ID],
    serviceSecret,
  });
  assert(rows.length === 1 && rows[0]._id === SAVED_POST_ID, "Reviewed saved post is missing.");
  const post = rows[0];
  assert(
    post.handle === "faks_beograd" &&
      post.username === "faks_beograd" &&
      post.instagramPostUrl === POST_URL &&
      post.canonicalSourceUrl === POST_URL,
    "Reviewed saved post identity changed.",
  );
  return post;
}

function makePlan(post) {
  assert(post.processingStatus === "completed" && post.processingOutcome === "terminal_permanent_failure", "Reviewed post is not terminal.");
  assert(
    post.processingError === undefined,
    "Reviewed saved row unexpectedly has a processing error; inspect it before requeueing.",
  );
  assert(post.analysisRejectedRequestRecoveryAt === undefined, "This saved post has already been requeued once.");
  assert(Number.isSafeInteger(post.sourceRevision ?? 1), "Saved source revision is invalid.");
  assert(Number.isSafeInteger(post.analysisAttemptStartedAt), "Saved analysis attempt is missing.");
  assert(post.analysisAttemptOwner && post.postId, "Saved attempt or provider identity is missing.");
  assert(
    post.processingAttempts === 1 &&
      post.analysisAttemptRevision === (post.sourceRevision ?? 1) &&
      post.analysisAttemptProtocol === EXPECTED_ATTEMPT_PROTOCOL &&
      post.analysisAttemptBudgetDayKey &&
      post.analysisRevision === undefined &&
      post.analysisResultJson === undefined &&
      post.analysisDefinitiveOutputFailureRevision === undefined &&
      post.analysisDefinitiveOutputRecoveryRevision === undefined &&
      post.processingLeaseOwner === undefined,
    "Saved analysis attempt no longer matches the reviewed failure fence.",
  );
  const mutationArgs = {
    scrapedPostId: SAVED_POST_ID,
    expectedSourceRevision: post.sourceRevision ?? 1,
    expectedUpdatedAt: post.updatedAt,
    expectedAnalysisAttemptStartedAt: post.analysisAttemptStartedAt,
    expectedAnalysisAttemptOwner: post.analysisAttemptOwner,
    expectedPostId: post.postId,
    operatorEvidenceSha256: OPERATOR_EVIDENCE_SHA256,
  };
  return {
    mutationArgs,
    planSha256: crypto.createHash("sha256").update(JSON.stringify(mutationArgs)).digest("hex"),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const hashIndex = args.indexOf("--expect-plan-sha256");
  const expectedHash = hashIndex >= 0 ? args[hashIndex + 1] : null;
  assert(
    args.every((arg, index) =>
      arg === "--apply" || arg === "--expect-plan-sha256" ||
      (index > 0 && args[index - 1] === "--expect-plan-sha256")) &&
      (apply ? /^[0-9a-f]{64}$/u.test(expectedHash ?? "") : expectedHash === null),
    "Preview first; apply with --apply --expect-plan-sha256 <preview hash>.",
  );
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim().replace(/\/$/u, "");
  const serviceSecret = process.env.CRON_SECRET?.trim();
  assert(convexUrl === CONVEX_URL && serviceSecret, "Production Convex URL or CRON_SECRET differs from the reviewed target.");
  const client = new ConvexHttpClient(CONVEX_URL);
  const post = await loadPost(client, serviceSecret);
  const { mutationArgs, planSha256 } = makePlan(post);
  if (!apply) {
    console.log(JSON.stringify({
      mode: "preview",
      savedPostId: SAVED_POST_ID,
      postUrl: POST_URL,
      sourceRevision: mutationArgs.expectedSourceRevision,
      processingStatus: post.processingStatus,
      processingOutcome: post.processingOutcome,
      storedProcessingError: null,
      operatorAttestedErrorCode: "unsupported_parameter",
      operatorEvidenceSha256: OPERATOR_EVIDENCE_SHA256,
      chargedOpenAiRequestPreserved: true,
      newApifyCostUsd: 0,
      planSha256,
    }, null, 2));
    return;
  }
  assert(
    process.env.OPENAI_VISION_MODEL?.trim() === "gpt-5-mini",
    "Set OPENAI_VISION_MODEL=gpt-5-mini before requeueing the saved post.",
  );
  assert(planSha256 === expectedHash, "Saved-post state changed after preview.");
  const result = await client.mutation("scrapedPosts:requeueReviewedFabrikaRejectedOpenAiRequest", {
    ...mutationArgs,
    serviceSecret,
  });
  assert(result.requeued === true && result.sourceRevision === mutationArgs.expectedSourceRevision, "Reviewed requeue did not succeed.");
  const after = await loadPost(client, serviceSecret);
  assert(
    after.processingStatus === "pending" &&
      after.analysisRejectedRequestRecoveryEvidenceSha256 === OPERATOR_EVIDENCE_SHA256 &&
      after.analysisRejectedRequestRecoveryError?.includes("unsupported_parameter") &&
      after.sourceRevision === post.sourceRevision &&
      after.analysisRejectedRequestRecoveryAt,
    "Reviewed requeue readback failed.",
  );
  console.log(JSON.stringify({
    mode: "applied",
    savedPostId: SAVED_POST_ID,
    postUrl: POST_URL,
    sourceRevision: after.sourceRevision,
    processingStatus: after.processingStatus,
    chargedOpenAiRequestPreserved: true,
    newApifyCostUsd: 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Reviewed requeue failed.");
  process.exitCode = 1;
});
