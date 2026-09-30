import crypto from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Frozen from the seven failed, persisted Sep 29 receipts. Only eight
// retryable saved posts are selected; the two terminal posts are omitted.
// This operator never calls Apify, opens a fetch receipt, or scans a backlog.
export const RUN_ID = "n170c5ea1c5ag0etc57qzc4ry58fa87v";
export const CONVEX_URL = "https://convex-events.ineedtofeedmyrabbit.com";
export const TARGETS = Object.freeze([
  { receiptId: "mx7enb5v3xzd79eanf6tprkp998fbbrw", handle: "teatarodeonofficial", savedPostId: "jn786s2hg3jnpv2dcxddawke6d8fb0g0", sourceRevision: 1, postId: "3996139444304425306", postUrl: "https://www.instagram.com/p/Dd1I6bysTFa/", outcome: "incomplete_occurrence_receipt", updatedAt: 1790670564831 },
  { receiptId: "mx7evvafb7kjmh9cm7wdr4ckk58fbw2f", handle: "mamashelterbelgrade", savedPostId: "jn73f64qpe02zz0vgtgbafb15d8fbay2", sourceRevision: 1, postId: "3996189127224728144", postUrl: "https://www.instagram.com/p/Dd1UNanghpQ/", outcome: "incomplete_occurrence_receipt", updatedAt: 1790673191730 },
  { receiptId: "mx7f783yy33weq4fk5pcgqfd0h8fbkx2", handle: "lozionica", savedPostId: "jn71mp4gk42gh76c9tkgz4ee858fbq5d", sourceRevision: 1, postId: "3996268658686036100", postUrl: "https://www.instagram.com/p/Dd1mSwEAgiE/", outcome: "incomplete_occurrence_receipt", updatedAt: 1790668152212 },
  { receiptId: "mx7f783yy33weq4fk5pcgqfd0h8fbkx2", handle: "lozionica", savedPostId: "jn785zgz3frh7ckm21bmdqqnf98fa1mj", sourceRevision: 1, postId: "3996195865995335963", postUrl: "https://www.instagram.com/p/Dd1VveliVkb/", outcome: "incomplete_occurrence_receipt", updatedAt: 1790672342781 },
  { receiptId: "mx734pxtsqhx79j0tpebng5sxx8fazdn", handle: "ligapub.bg", savedPostId: "jn7faxh4fa4qr358vev4qpz9498fbb56", sourceRevision: 1, postId: "3996302678504807873", postUrl: "https://www.instagram.com/p/Dd1uBzfOJ3B/", outcome: "processing_failed", updatedAt: 1790666388054 },
  { receiptId: "mx7a5tkmcbdtypb7r4zvq8etdx8fb2w8", handle: "dardanelislavija", savedPostId: "jn74gyvscj6j9frhyafnbp1bd58fb6z1", sourceRevision: 1, postId: "3996214545136811185", postUrl: "https://www.instagram.com/p/Dd1Z_S5IPyx/", outcome: "incomplete_occurrence_receipt", updatedAt: 1790671991290 },
  { receiptId: "mx7bkqrvkw4s971rqmxd0w6a7h8faeqh", handle: "cajgerbar", savedPostId: "jn71pmqjyd9jynk2vxddmrbw4x8fbjys", sourceRevision: 1, postId: "3996180129170920173", postUrl: "https://www.instagram.com/p/Dd1SKehtRLt/", outcome: "incomplete_occurrence_receipt", updatedAt: 1790665874473 },
  { receiptId: "mx7a4nj5q48tmsq37ec34k9nnd8fask9", handle: "bitefteatar", savedPostId: "jn71vbf4qmfqb25hemnfe9bwj98faa9w", sourceRevision: 1, postId: "3996085576805257831", postUrl: "https://www.instagram.com/p/Dd08qjxihJn/", outcome: "processing_failed", updatedAt: 1790665829445 },
]);

const TERMINAL_OUTCOMES = new Set([
  "terminal_no_event",
  "terminal_permanent_failure",
  "terminal_canonical_duplicate",
  "receipt_complete",
]);
const MAX_OPENAI_TRANSPORTS = 3;

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
    updatedAt: post.updatedAt ?? null,
    processingRetryAt: post.processingRetryAt ?? null,
    processingLeaseExpiresAt: post.processingLeaseExpiresAt ?? null,
    analysisAttemptRevision: post.analysisAttemptRevision ?? null,
    analysisRevision: post.analysisRevision ?? null,
    hasAnalysisResult: Boolean(post.analysisResultJson),
  };
}

export function buildPlanForPosts(run, posts, now = Date.now()) {
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
    let disposition;
    if (state.processingStatus === "completed" && TERMINAL_OUTCOMES.has(state.processingOutcome)) {
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
      assert(
        state.analysisAttemptRevision !== target.sourceRevision ||
        (state.analysisRevision === target.sourceRevision && state.hasAnalysisResult),
        `OpenAI transport is ambiguous for ${target.savedPostId}; automatic replay is blocked.`,
      );
      disposition = "process_saved_post";
    }
    return { receiptId: target.receiptId, disposition, ...state };
  });
  const plan = { schemaVersion: 1, runId: RUN_ID, convexUrl: CONVEX_URL, maxOpenAiTransports: MAX_OPENAI_TRANSPORTS, rows };
  return {
    plan,
    planSha256: crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
  };
}

async function loadPlan(client, serviceSecret) {
  const [run, posts] = await Promise.all([
    client.query("durableIngestionRuns:probeRun", { runId: RUN_ID, serviceSecret }),
    client.query("scrapedPosts:getManyByIds", {
      ids: TARGETS.map((target) => target.savedPostId),
      serviceSecret,
    }),
  ]);
  return buildPlanForPosts(run, posts);
}

async function main() {
  const { apply, expectedHash } = parseArgs(process.argv.slice(2));
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim().replace(/\/$/u, "");
  const serviceSecret = process.env.CRON_SECRET?.trim();
  assert(convexUrl === CONVEX_URL && serviceSecret,
    "Production Convex URL or CRON_SECRET is missing or differs from the frozen target.");
  const { ConvexHttpClient } = await import("convex/browser");
  const client = new ConvexHttpClient(CONVEX_URL);
  const before = await loadPlan(client, serviceSecret);
  const preview = {
    mode: apply ? "apply_preflight" : "preview",
    runId: RUN_ID,
    selectedPostCount: TARGETS.length,
    processCount: before.plan.rows.filter((row) => row.disposition === "process_saved_post").length,
    alreadyTerminalCount: before.plan.rows.filter((row) => row.disposition === "already_terminal").length,
    maxOpenAiTransports: MAX_OPENAI_TRANSPORTS,
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
  const { processSavedScrapedPostForDurableReceipt } = await import(
    "../lib/pipeline/ingestion/durable-saved-posts.ts"
  );
  let openAiTransportCount = 0;
  const results = [];
  for (const row of before.plan.rows) {
    if (row.disposition === "already_terminal") {
      results.push({ savedPostId: row.savedPostId, state: "already_terminal" });
      continue;
    }
    if (openAiTransportCount >= MAX_OPENAI_TRANSPORTS) break;
    const [current] = await client.query("scrapedPosts:getManyByIds", {
      ids: [row.savedPostId], serviceSecret,
    });
    const expectedState = Object.fromEntries(
      Object.entries(row).filter(([key]) => key !== "receiptId" && key !== "disposition"),
    );
    assert(current && JSON.stringify(compactPost(current)) === JSON.stringify(expectedState),
      `Saved-post version fence changed before processing ${row.savedPostId}.`);
    let thisPostTransportCount = 0;
    const result = await processSavedScrapedPostForDurableReceipt({
      handle: row.handle,
      scrapedPostId: row.savedPostId,
      expectedSourceRevision: row.sourceRevision,
      workOwner: `sep29-saved-recovery:${crypto.randomUUID()}`,
      serviceSecret,
      onOpenAiTransportStarted: () => {
        assert(thisPostTransportCount === 0, "A saved post attempted a second OpenAI transport.");
        assert(openAiTransportCount < MAX_OPENAI_TRANSPORTS, "OpenAI transport cap reached.");
        thisPostTransportCount += 1;
        openAiTransportCount += 1;
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
    if (result.state !== "terminal") break;
  }
  console.log(JSON.stringify({
    mode: "complete",
    selectedPostCount: TARGETS.length,
    processedCount: results.length,
    openAiTransportCount,
    historicalReceiptsUnchanged: true,
    stopped: results.length < TARGETS.length,
    results,
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Exact saved-post recovery failed.");
    process.exitCode = 1;
  });
}
