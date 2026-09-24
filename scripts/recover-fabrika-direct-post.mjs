import crypto from "node:crypto";
import { ConvexHttpClient } from "convex/browser";

// One reviewed, exact-post recovery. Preview first, then pass its plan hash to
// --apply. A retry after persistence processes the saved post without buying
// another Apify result. Run with the production environment already loaded.
const CONVEX_URL = "https://convex-events.ineedtofeedmyrabbit.com";
const HANDLE = "faks_beograd";
const SHORTCODE = "Ddo4DGsNlYf";
const POST_URL = `https://www.instagram.com/p/${SHORTCODE}/`;
const MAX_CHARGE_USD = 0.01;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isExactPostUrl(value) {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    return (
      (url.hostname === "instagram.com" || url.hostname === "www.instagram.com") &&
      segments.length === 2 &&
      segments[0] === "p" &&
      segments[1] === SHORTCODE
    );
  } catch {
    return false;
  }
}

async function findSavedPost(client, serviceSecret) {
  let cursor = null;
  const seenCursors = new Set();
  for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
    const page = await client.query("scrapedPosts:listByHandlePaginated", {
      handle: HANDLE,
      paginationOpts: { cursor, numItems: 100 },
      serviceSecret,
    });
    const matches = page.page.filter((post) => isExactPostUrl(post.instagramPostUrl));
    assert(matches.length <= 1, "Duplicate saved rows have the exact reviewed post URL.");
    if (matches.length === 1) return matches[0];
    if (page.isDone) return null;
    assert(
      typeof page.continueCursor === "string" &&
        page.continueCursor.length > 0 &&
        !seenCursors.has(page.continueCursor),
      "Saved-post pagination did not advance.",
    );
    seenCursors.add(page.continueCursor);
    cursor = page.continueCursor;
  }
  throw new Error("Saved-post lookup exceeded its ten-page review bound.");
}

async function loadPlan(client, serviceSecret) {
  const [source, saved] = await Promise.all([
    client.query("instagramSources:getByHandle", { handle: HANDLE, serviceSecret }),
    findSavedPost(client, serviceSecret),
  ]);
  assert(source?.handle === HANDLE && source.active === true, "The reviewed Instagram source is not active.");
  assert(source.role === "venue", "The reviewed Instagram source is no longer a venue.");
  if (saved) {
    assert(saved.handle === HANDLE && isExactPostUrl(saved.instagramPostUrl), "Saved post identity changed.");
    assert(Number.isSafeInteger(saved.sourceRevision ?? 1), "Saved post source revision is invalid.");
  }
  const plan = {
    version: 1,
    convexUrl: CONVEX_URL,
    handle: HANDLE,
    postUrl: POST_URL,
    sourceId: source._id,
    sourceUpdatedAt: source.updatedAt,
    savedPostId: saved?._id ?? null,
    savedSourceRevision: saved?.sourceRevision ?? null,
    savedProcessingStatus: saved?.processingStatus ?? null,
    maxChargeUsd: saved ? 0 : MAX_CHARGE_USD,
  };
  return {
    source,
    saved,
    planSha256: crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
  };
}

async function fetchExactPost(client, serviceSecret) {
  const {
    getApifyBudgetConfig,
    getBudgetDayKey,
    isPaidIngestionEnabled,
  } = await import("../lib/pipeline/instagram-ingestion-durability.ts");
  const { scrapeInstagramAccount } = await import("../lib/scraper/instagram-scraper.ts");
  const { persistScrapedPostsForHandle } = await import("../lib/pipeline/ingestion/source-documents.ts");

  assert(process.env.APIFY_API_TOKEN?.trim(), "APIFY_API_TOKEN is required for the paid exact-post fetch.");
  assert(isPaidIngestionEnabled(), "Paid Instagram ingestion is disabled.");
  const budget = getApifyBudgetConfig();
  assert(budget.dailyBudgetMicros >= 10_000, "The configured Apify daily budget is below the one-cent cap.");
  const owner = `reviewed-direct-post:${SHORTCODE}:${crypto.randomUUID()}`.slice(0, 200);
  const startedAt = Date.now();
  const claim = await client.mutation("scrapedPosts:claimPaidFetchLease", {
    handle: HANDLE,
    owner,
    leaseMs: 10 * 60_000,
    requestedResultsLimit: 1,
    fetchStartedAt: startedAt,
    bootstrapDays: 10,
    dayKey: getBudgetDayKey(new Date(startedAt)),
    dailyBudgetUsd: budget.dailyBudgetMicros / 1_000_000,
    maxChargeUsd: MAX_CHARGE_USD,
    attemptCooldownMs: 0,
    ignoreCheckpoint: true,
    requestBoundaryVersion: 1,
    paidEnabled: true,
    serviceSecret,
  });
  assert(claim.claimed === true, `Exact-post paid-fetch lease was denied: ${claim.reason ?? "unknown"}.`);

  let transportInvoked = false;
  let fetched = null;
  let persisted = null;
  let savedFromRace = null;
  try {
    // Another worker may have persisted the post between preview and lease.
    // If so, release the unused reservation and continue from its saved row.
    const newlySaved = await findSavedPost(client, serviceSecret);
    if (newlySaved) {
      savedFromRace = newlySaved;
    } else {
      const posts = await scrapeInstagramAccount({
        handle: POST_URL,
        resultsLimit: 1,
        noAgeCutoff: true,
        skipPinnedPosts: false,
        maxTotalChargeUsd: MAX_CHARGE_USD,
        abortAtMs: typeof claim.expiresAt === "number" ? claim.expiresAt - 60_000 : undefined,
        onRequestStarted: async () => {
          await client.mutation("scrapedPosts:markPaidFetchRequestStarted", {
            handle: HANDLE,
            owner,
            serviceSecret,
          });
        },
        onTransportInvoked: () => {
          transportInvoked = true;
        },
      });
      assert(posts.length === 1, "The provider did not return exactly one usable post.");
      fetched = posts[0];
      assert(isExactPostUrl(fetched.instagramPostUrl), "The provider returned a different Instagram post.");
      assert(fetched.username.trim().toLowerCase() === HANDLE, "The provider-attested post owner is not @faks_beograd.");
      assert(fetched.caption?.trim(), "The provider returned no caption for the reviewed post.");
      assert(fetched.postId?.trim(), "The provider returned no durable post identity.");

      const rows = await persistScrapedPostsForHandle(
        client,
        HANDLE,
        [fetched],
        serviceSecret,
        owner,
      );
      assert(rows.length === 1 && rows[0].scrapedPostId, "The exact post was not durably persisted.");
      persisted = rows[0];
    }
  } finally {
    // The durable request-start marker charges an ambiguous transport after a
    // crash. A still-live worker can release an unused reservation explicitly.
    const release = await client.mutation("scrapedPosts:releasePaidFetchLease", {
      owner,
      requestStarted: transportInvoked,
      ...(transportInvoked ? {
        targetedPostResult: {
          handle: HANDLE,
          instagramPostUrl: POST_URL,
          status: persisted ? "persisted" : "failed",
          ...(persisted ? { scrapedPostId: persisted.scrapedPostId } : {}),
        },
      } : {}),
      serviceSecret,
    });
    assert(release.released === true, "Paid-fetch lease release could not be verified.");
  }
  if (savedFromRace) return savedFromRace;
  assert(fetched && persisted, "The exact provider post was not persisted.");
  const saved = await client.query("scrapedPosts:getManyByIds", {
    ids: [persisted.scrapedPostId],
    serviceSecret,
  });
  assert(saved.length === 1 && saved[0].sourceRevision === persisted.sourceRevision, "Saved source revision changed after persistence.");
  return saved[0];
}

async function processExactSavedPost(client, serviceSecret, saved) {
  assert(saved.handle === HANDLE && isExactPostUrl(saved.instagramPostUrl), "Saved post no longer matches the reviewed identity.");
  const terminalOutcomes = new Set([
    "terminal_no_event",
    "terminal_permanent_failure",
    "terminal_canonical_duplicate",
    "receipt_complete",
  ]);
  let result = { state: "terminal", outcome: saved.processingOutcome ?? "receipt_complete" };
  if (!(saved.processingStatus === "completed" && terminalOutcomes.has(saved.processingOutcome))) {
    const { processSavedScrapedPostForDurableReceipt } = await import(
      "../lib/pipeline/ingestion/durable-saved-posts.ts"
    );
    result = await processSavedScrapedPostForDurableReceipt({
      handle: HANDLE,
      scrapedPostId: saved._id,
      expectedSourceRevision: saved.sourceRevision ?? 1,
      workOwner: `reviewed-direct-post:${SHORTCODE}:${crypto.randomUUID()}`,
      serviceSecret,
    });
  }
  const events = await client.query("events:listByInstagramPostUrl", {
    instagramPostUrl: POST_URL,
    serviceSecret,
  });
  return {
    savedPostId: saved._id,
    sourceRevision: saved.sourceRevision ?? 1,
    processingState: result.state,
    processingOutcome: result.outcome ?? null,
    retryAfterMs: result.retryAfterMs ?? null,
    events: events.map((event) => ({
      id: event._id,
      title: event.title,
      date: event.date,
      status: event.status,
      venue: event.venue,
    })),
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
  assert(convexUrl === CONVEX_URL && serviceSecret, "Production Convex URL or CRON_SECRET is missing or differs from the reviewed target.");
  if (apply) {
    assert(
      process.env.OPENAI_VISION_MODEL?.trim() === "gpt-5-mini",
      "The exact-post operator requires OPENAI_VISION_MODEL=gpt-5-mini before processing.",
    );
  }
  const client = new ConvexHttpClient(CONVEX_URL);
  const before = await loadPlan(client, serviceSecret);
  if (!apply) {
    console.log(JSON.stringify({
      mode: "preview",
      target: POST_URL,
      saved: Boolean(before.saved),
      savedPostId: before.saved?._id ?? null,
      processingStatus: before.saved?.processingStatus ?? null,
      maxChargeUsd: before.saved ? 0 : MAX_CHARGE_USD,
      planSha256: before.planSha256,
    }, null, 2));
    return;
  }
  assert(before.planSha256 === expectedHash, "The live source or saved-post state changed after preview.");
  const saved = before.saved ?? await fetchExactPost(client, serviceSecret);
  const result = await processExactSavedPost(client, serviceSecret, saved);
  console.log(JSON.stringify({ mode: "applied", target: POST_URL, ...result }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Exact-post recovery failed.");
  process.exitCode = 1;
});
