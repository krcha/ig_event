import crypto from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Frozen from six failed, persisted Sep 29 receipts. All seven saved posts
// with valid, current event-evidence caches are version-fenced, but Teatar
// and Mama Shelter remain held; at most five posts can be processed. The
// uncached ligapub.bg post is excluded. This operator never calls Apify,
// opens a fetch receipt, scans a backlog, or sends content to OpenAI.
export const RUN_ID = "n170c5ea1c5ag0etc57qzc4ry58fa87v";
export const CONVEX_URL = "https://convex-events.ineedtofeedmyrabbit.com";
export const TARGETS = Object.freeze([
  { receiptId: "mx7enb5v3xzd79eanf6tprkp998fbbrw", handle: "teatarodeonofficial", savedPostId: "jn786s2hg3jnpv2dcxddawke6d8fb0g0", sourceRevision: 1, postId: "3996139444304425306", postUrl: "https://www.instagram.com/p/Dd1I6bysTFa/", outcome: "incomplete_occurrence_receipt", updatedAt: 1790670564831 },
  { receiptId: "mx7evvafb7kjmh9cm7wdr4ckk58fbw2f", handle: "mamashelterbelgrade", savedPostId: "jn73f64qpe02zz0vgtgbafb15d8fbay2", sourceRevision: 1, postId: "3996189127224728144", postUrl: "https://www.instagram.com/p/Dd1UNanghpQ/", outcome: "incomplete_occurrence_receipt", updatedAt: 1790673191730 },
  { receiptId: "mx7f783yy33weq4fk5pcgqfd0h8fbkx2", handle: "lozionica", savedPostId: "jn71mp4gk42gh76c9tkgz4ee858fbq5d", sourceRevision: 1, postId: "3996268658686036100", postUrl: "https://www.instagram.com/p/Dd1mSwEAgiE/", outcome: "incomplete_occurrence_receipt", updatedAt: 1790668152212 },
  { receiptId: "mx7f783yy33weq4fk5pcgqfd0h8fbkx2", handle: "lozionica", savedPostId: "jn785zgz3frh7ckm21bmdqqnf98fa1mj", sourceRevision: 1, postId: "3996195865995335963", postUrl: "https://www.instagram.com/p/Dd1VveliVkb/", outcome: "incomplete_occurrence_receipt", updatedAt: 1790672342781 },
  { receiptId: "mx7a5tkmcbdtypb7r4zvq8etdx8fb2w8", handle: "dardanelislavija", savedPostId: "jn74gyvscj6j9frhyafnbp1bd58fb6z1", sourceRevision: 1, postId: "3996214545136811185", postUrl: "https://www.instagram.com/p/Dd1Z_S5IPyx/", outcome: "incomplete_occurrence_receipt", updatedAt: 1790671991290 },
  { receiptId: "mx7bkqrvkw4s971rqmxd0w6a7h8faeqh", handle: "cajgerbar", savedPostId: "jn71pmqjyd9jynk2vxddmrbw4x8fbjys", sourceRevision: 1, postId: "3996180129170920173", postUrl: "https://www.instagram.com/p/Dd1SKehtRLt/", outcome: "incomplete_occurrence_receipt", updatedAt: 1790665874473 },
  { receiptId: "mx7a4nj5q48tmsq37ec34k9nnd8fask9", handle: "bitefteatar", savedPostId: "jn71vbf4qmfqb25hemnfe9bwj98faa9w", sourceRevision: 1, postId: "3996085576805257831", postUrl: "https://www.instagram.com/p/Dd08qjxihJn/", outcome: "processing_failed", updatedAt: 1790665829445 },
]);
export const TEATAR_SAVED_POST_ID = "jn786s2hg3jnpv2dcxddawke6d8fb0g0";
export const MAMA_SAVED_POST_ID = "jn73f64qpe02zz0vgtgbafb15d8fbay2";
export const MAMA_SEMANTIC_CONFLICT =
  "Source-occurrence key is occupied by a different semantic representative; manual repair is required.";

const TERMINAL_OUTCOMES = new Set([
  "terminal_no_event",
  "terminal_permanent_failure",
  "terminal_canonical_duplicate",
  "receipt_complete",
]);
const CACHED_ANALYSIS_PROTOCOL =
  "openai-responses:event-extraction:event_evidence_v2:compact_medium:max_output_tokens_16384:v2";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function blockOpenAiTransport() {
  throw new Error("OpenAI transport is forbidden for cached-only saved-post recovery.");
}

export function disableOpenAiCredential(env) {
  delete env.OPENAI_API_KEY;
}

export function assertCachedReplayTerminal(result, blockedOpenAiTransport, savedPostId) {
  assert(!blockedOpenAiTransport && result.transportAttempted === false,
    `A cached-only replay attempted OpenAI transport for ${savedPostId}.`);
  assert(result.state === "terminal",
    `Cached-only replay did not reach a terminal outcome for ${savedPostId}: ${result.reason ?? result.state}.`);
}

export function parseArgs(args) {
  const apply = args.includes("--apply");
  const hashIndex = args.indexOf("--expect-plan-sha256");
  const expectedHash = hashIndex < 0 ? null : args[hashIndex + 1];
  assert(
    args.every((arg, index) =>
      arg === "--apply" ||
      arg === "--expect-plan-sha256" ||
      (index > 0 && args[index - 1] === "--expect-plan-sha256")) &&
      args.filter((arg) => arg === "--expect-plan-sha256").length <= 1 &&
      (apply ? /^[0-9a-f]{64}$/u.test(expectedHash ?? "") : expectedHash === null),
    "Preview first; apply with --apply --expect-plan-sha256 <preview hash>.",
  );
  return { apply, expectedHash };
}

function compactPost(post) {
  return {
    savedPostId: post._id,
    handle: post.handle,
    sourceRevision: post.sourceRevision ?? 1,
    postId: post.postId,
    postUrl: post.instagramPostUrl,
    processingStatus: post.processingStatus ?? null,
    processingOutcome: post.processingOutcome ?? null,
    processingErrorSha256: typeof post.processingError === "string"
      ? crypto.createHash("sha256").update(post.processingError).digest("hex")
      : null,
    updatedAt: post.updatedAt ?? null,
    processingRetryAt: post.processingRetryAt ?? null,
    processingLeaseExpiresAt: post.processingLeaseExpiresAt ?? null,
    analysisAttemptRevision: post.analysisAttemptRevision ?? null,
    analysisRevision: post.analysisRevision ?? null,
    analysisAttemptProtocol: post.analysisAttemptProtocol ?? null,
    analysisContractVersion: post.analysisContractVersion ?? null,
    analysisAttemptStartedAt: post.analysisAttemptStartedAt ?? null,
    analysisCompletedAt: post.analysisCompletedAt ?? null,
    analysisAttemptOwnerPresent: Boolean(post.analysisAttemptOwner),
    analysisModel: post.analysisModel ?? null,
    analysisIsEvent: post.analysisIsEvent ?? null,
    analysisResultSha256: typeof post.analysisResultJson === "string"
      ? crypto.createHash("sha256").update(post.analysisResultJson).digest("hex")
      : null,
    analysisImageSourceUrlSha256: typeof post.analysisImageSourceUrl === "string"
      ? crypto.createHash("sha256").update(post.analysisImageSourceUrl).digest("hex")
      : null,
    analysisImageChecksumSha256: post.analysisImageChecksumSha256 ?? null,
  };
}

function validateCachedAnalysis(post, target, parseExtractedEventData) {
  assert(typeof parseExtractedEventData === "function", "The production event-evidence parser is required.");
  assert(
    post.analysisAttemptRevision === target.sourceRevision &&
    post.analysisRevision === target.sourceRevision &&
    post.analysisAttemptProtocol === CACHED_ANALYSIS_PROTOCOL &&
    post.analysisContractVersion === "event_evidence_v2" &&
    Number.isFinite(post.analysisAttemptStartedAt) &&
    Number.isFinite(post.analysisCompletedAt) &&
    post.analysisCompletedAt >= post.analysisAttemptStartedAt &&
    typeof post.analysisAttemptOwner === "string" && post.analysisAttemptOwner.length > 0 &&
    typeof post.analysisModel === "string" && post.analysisModel.length > 0 &&
    post.analysisIsEvent === true &&
    typeof post.analysisResultJson === "string" && post.analysisResultJson.length > 0 &&
    typeof post.analysisImageSourceUrl === "string" && post.analysisImageSourceUrl.length > 0 &&
    /^[0-9a-f]{64}$/iu.test(post.analysisImageChecksumSha256 ?? ""),
    `Saved post lacks valid current cached analysis: ${target.savedPostId}.`,
  );
  let parsed;
  try {
    parsed = parseExtractedEventData(JSON.parse(post.analysisResultJson));
  } catch {
    throw new Error(`Cached analysis fails the production event-evidence parser: ${target.savedPostId}.`);
  }
  assert(parsed?.extraction_contract_version === "event_evidence_v2" && parsed.is_event === true,
    `Cached analysis is not an event-evidence-v2 event: ${target.savedPostId}.`);
}

export function buildPlanForPosts(run, posts, parseExtractedEventData, now = Date.now()) {
  assert(run?.runId === RUN_ID && run.mode === "daily", "The frozen daily run changed.");
  assert(run.status === "completed" && run.complete === true && run.inFlightCount === 0,
    "The frozen daily run is not completed and idle.");
  assert(Array.isArray(posts) && posts.length === TARGETS.length,
    "An exact saved-post ID is missing from the read-only result.");
  const byId = new Map(posts.map((post) => [post._id, post]));
  assert(byId.size === TARGETS.length, "Saved-post IDs are duplicated.");
  const rows = TARGETS.map((target) => {
    const post = byId.get(target.savedPostId);
    assert(post, `Saved post ${target.savedPostId} is missing.`);
    const state = compactPost(post);
    assert(
      state.handle === target.handle &&
      state.sourceRevision === target.sourceRevision &&
      state.postId === target.postId &&
      state.postUrl === target.postUrl,
      `Exact saved-post identity or source revision changed: ${target.savedPostId}.`,
    );
    validateCachedAnalysis(post, target, parseExtractedEventData);
    let disposition;
    if (target.savedPostId === TEATAR_SAVED_POST_ID || target.savedPostId === MAMA_SAVED_POST_ID) {
      assert(
        state.processingStatus === "retryable_failure" &&
        state.processingOutcome === target.outcome &&
        state.updatedAt === target.updatedAt,
        `Frozen held-post processing state changed: ${target.savedPostId}. Review a fresh snapshot.`,
      );
      assert((state.processingLeaseExpiresAt ?? 0) <= now,
        `Held saved-post lease remains active: ${target.savedPostId}.`);
      assert(Number.isFinite(state.processingRetryAt) && state.processingRetryAt > now,
        `Held saved-post retry cooldown is not active: ${target.savedPostId}.`);
      if (target.savedPostId === MAMA_SAVED_POST_ID) {
        assert(post.processingError === MAMA_SEMANTIC_CONFLICT,
          `Mama Shelter semantic conflict changed: ${target.savedPostId}.`);
        disposition = "held_semantic_conflict";
      } else {
        disposition = "held_retry_cooldown";
      }
    } else if (state.processingStatus === "completed" && TERMINAL_OUTCOMES.has(state.processingOutcome)) {
      disposition = "already_terminal";
    } else {
      assert(
        state.processingStatus === "retryable_failure" &&
        state.processingOutcome === target.outcome &&
        state.updatedAt === target.updatedAt,
        `Frozen processing state changed: ${target.savedPostId}. Review a fresh snapshot before retrying.`,
      );
      assert((state.processingLeaseExpiresAt ?? 0) <= now,
        `Saved-post lease remains active: ${target.savedPostId}.`);
      assert((state.processingRetryAt ?? 0) <= now,
        `Saved-post retry cooldown remains active: ${target.savedPostId}.`);
      disposition = "process_saved_post";
    }
    return { receiptId: target.receiptId, disposition, ...state };
  });
  const plan = {
    schemaVersion: 4,
    runId: RUN_ID,
    convexUrl: CONVEX_URL,
    heldPostIds: [TEATAR_SAVED_POST_ID, MAMA_SAVED_POST_ID],
    openAiTransportAllowed: false,
    rows,
  };
  return {
    plan,
    planSha256: crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
  };
}

async function loadPlan(client, serviceSecret, parseExtractedEventData) {
  const [run, posts] = await Promise.all([
    client.query("durableIngestionRuns:probeRun", { runId: RUN_ID, serviceSecret }),
    client.query("scrapedPosts:getManyByIds", {
      ids: TARGETS.map((target) => target.savedPostId),
      serviceSecret,
    }),
  ]);
  return buildPlanForPosts(run, posts, parseExtractedEventData);
}

async function main() {
  const { apply, expectedHash } = parseArgs(process.argv.slice(2));
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim().replace(/\/$/u, "");
  const serviceSecret = process.env.CRON_SECRET?.trim();
  assert(convexUrl === CONVEX_URL && serviceSecret,
    "Production Convex URL or CRON_SECRET is missing or differs from the frozen target.");
  const { ConvexHttpClient } = await import("convex/browser");
  const { parseExtractedEventData } = await import("../lib/ai/extract-event-data.ts");
  const client = new ConvexHttpClient(CONVEX_URL);
  const before = await loadPlan(client, serviceSecret, parseExtractedEventData);
  const preview = {
    mode: apply ? "apply_preflight" : "preview",
    runId: RUN_ID,
    selectedPostCount: TARGETS.length,
    heldCount: before.plan.rows.filter((row) => row.disposition.startsWith("held_")).length,
    heldSavedPostIds: before.plan.rows.filter((row) => row.disposition.startsWith("held_")).map((row) => row.savedPostId),
    processCount: before.plan.rows.filter((row) => row.disposition === "process_saved_post").length,
    alreadyTerminalCount: before.plan.rows.filter((row) => row.disposition === "already_terminal").length,
    openAiTransportAllowed: false,
    planSha256: before.planSha256,
    rows: before.plan.rows.map(({ receiptId, savedPostId, handle, postUrl, sourceRevision, processingStatus, processingOutcome, disposition, analysisRevision, analysisAttemptRevision }) => ({
      receiptId, savedPostId, handle, postUrl, sourceRevision, processingStatus,
      processingOutcome, disposition, analysisRevision, analysisAttemptRevision,
    })),
  };
  if (!apply) {
    console.log(JSON.stringify(preview, null, 2));
    return;
  }
  assert(before.planSha256 === expectedHash, "Live plan changed after preview. Run preview again.");
  // The callback below rejects an OpenAI request immediately before fetch.
  // Removing the key in this process independently stops an unexpected cache
  // miss at getRequiredEnv, even if a future call path skips the callback.
  disableOpenAiCredential(process.env);
  const { processSavedScrapedPostForDurableReceipt } = await import(
    "../lib/pipeline/ingestion/durable-saved-posts.ts"
  );
  const results = [];
  for (const row of before.plan.rows) {
    const [current] = await client.query("scrapedPosts:getManyByIds", {
      ids: [row.savedPostId], serviceSecret,
    });
    const expectedState = Object.fromEntries(
      Object.entries(row).filter(([key]) => key !== "receiptId" && key !== "disposition"),
    );
    assert(current && JSON.stringify(compactPost(current)) === JSON.stringify(expectedState),
      `Saved-post version fence changed before processing ${row.savedPostId}.`);
    validateCachedAnalysis(current, row, parseExtractedEventData);
    if (row.disposition === "held_retry_cooldown" || row.disposition === "held_semantic_conflict") {
      assert(
        (row.savedPostId === TEATAR_SAVED_POST_ID && row.disposition === "held_retry_cooldown") ||
        (row.savedPostId === MAMA_SAVED_POST_ID && row.disposition === "held_semantic_conflict" &&
          current.processingError === MAMA_SEMANTIC_CONFLICT),
        "A held saved post changed before apply.",
      );
      assert((current.processingRetryAt ?? 0) > Date.now(),
        `Held saved-post retry cooldown ended: ${row.savedPostId}.`);
      results.push({ savedPostId: row.savedPostId, state: row.disposition });
      continue;
    }
    if (row.disposition === "already_terminal") {
      results.push({ savedPostId: row.savedPostId, state: "already_terminal" });
      continue;
    }
    let blockedOpenAiTransport = false;
    const result = await processSavedScrapedPostForDurableReceipt({
      handle: row.handle,
      scrapedPostId: row.savedPostId,
      expectedSourceRevision: row.sourceRevision,
      workOwner: `sep29-saved-recovery:${crypto.randomUUID()}`,
      serviceSecret,
      onOpenAiTransportStarted: () => {
        blockedOpenAiTransport = true;
        blockOpenAiTransport();
      },
    });
    results.push({
      receiptId: row.receiptId,
      savedPostId: row.savedPostId,
      state: result.state,
      outcome: result.outcome ?? null,
      reason: result.reason ?? null,
      transportAttempted: result.transportAttempted,
    });
    console.log(JSON.stringify({ mode: "progress", result: results.at(-1) }));
    assertCachedReplayTerminal(result, blockedOpenAiTransport, row.savedPostId);
  }
  console.log(JSON.stringify({
    mode: "complete",
    selectedPostCount: TARGETS.length,
    heldCount: results.filter((result) => result.state.startsWith("held_")).length,
    heldSavedPostIds: results.filter((result) => result.state.startsWith("held_")).map((result) => result.savedPostId),
    processedCount: results.filter((result) => result.state === "terminal").length,
    openAiTransportAllowed: false,
    observedOpenAiTransportAttempts: results.filter((result) => result.transportAttempted).length,
    historicalReceiptsUnchanged: true,
    stopped: false,
    results,
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Exact saved-post recovery failed.");
    process.exitCode = 1;
  });
}
