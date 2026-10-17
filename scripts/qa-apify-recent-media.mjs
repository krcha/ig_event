import assert from "node:assert/strict";
import {
  buildApifyInstagramScrapeRequest,
  getInstagramScrapeRawItemCount,
  loadRecentApifyRunPosts,
  scrapeInstagramAccount,
} from "../lib/scraper/instagram-scraper.ts";

// This test never contacts Apify, Instagram or a production backend. It observes
// every outgoing paid phase, including its input, charge ceiling and lease.
const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const CUTOFF = "2026-10-16T12:00:00.000Z";
const FRESH = "2026-10-17T11:00:00.000Z";
const OWNER = "qa_recent_media";
const IMAGE_HOST = "https://images.apifyusercontent.com/";
const envNames = [
  "APIFY_API_TOKEN", "APIFY_DATA_DETAIL_LEVEL", "APIFY_SKIP_PINNED_POSTS",
  "APIFY_MAX_TOTAL_CHARGE_USD_PER_RUN", "INSTAGRAM_SCRAPER_PROVIDER",
];
const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalInfo = console.info;
let checks = 0;

function fixture(id, overrides = {}) {
  return {
    id: String(id), shortCode: `QA${id}`, url: `https://www.instagram.com/p/QA${id}/`,
    ownerUsername: OWNER, timestamp: FRESH, type: "Image", caption: "Fresh source caption",
    displayUrl: `${IMAGE_HOST}${id}.jpg`, ...overrides,
  };
}
const SINGLE = fixture(71000001);
const BASIC_CAROUSEL = fixture(71000002, { type: "Sidecar", childPostsCount: 3, carouselMediaCount: 3 });
const CHILDREN = [
  { id: "71000003", type: "Image", displayUrl: `${IMAGE_HOST}slide-0.jpg` },
  { id: "71000004", type: "Video", isVideo: true, displayUrl: `${IMAGE_HOST}slide-1-video-thumb.jpg` },
  { id: "71000005", type: "Image", displayUrl: `${IMAGE_HOST}slide-2.jpg`, displayUrlHD: `${IMAGE_HOST}slide-2-hd.jpg` },
];
const DETAILED_CAROUSEL = { ...BASIC_CAROUSEL, childPosts: CHILDREN };

async function scenario(basicRows, detailedRows, options = {}, onCall) {
  const calls = [];
  const receipts = new Map();
  const datasets = new Map();
  let markerCount = 0;
  let transportCount = 0;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.hostname, "api.apify.com");
    if (init?.method !== "POST") {
      const receipt = receipts.get(parsed.pathname);
      if (receipt) return Response.json({ data: receipt });
      const dataset = datasets.get(parsed.pathname);
      assert.ok(dataset, `Unexpected read-only provider URL ${parsed.pathname}`);
      return Response.json(dataset);
    }
    assert.match(parsed.pathname, /\/acts\/[^/]+\/runs$/);
    assert.equal(init?.signal?.aborted, false);
    const input = JSON.parse(String(init?.body));
    const call = { input, cap: Number(parsed.searchParams.get("maxTotalChargeUsd")),
      maxItems: Number(parsed.searchParams.get("maxItems")),
      usage: input.dataDetailLevel === "basicData" ? 0.002 : 0.005 };
    calls.push(call);
    assert.ok(markerCount >= 1, "durable request marker must precede every paid phase");
    assert.equal(transportCount, calls.length, "every paid phase must invoke the transport receipt immediately before fetch");
    await onCall?.(call, calls.length);
    const id = `qa-run-${calls.length}`;
    const datasetId = `qa-dataset-${calls.length}`;
    const receipt = { id, status: "SUCCEEDED", defaultDatasetId: datasetId,
      finishedAt: new Date(NOW - 20_000).toISOString(), usageTotalUsd: call.usage };
    receipts.set(`/v2/actor-runs/${id}`, receipt);
    datasets.set(`/v2/datasets/${datasetId}/items`, input.dataDetailLevel === "basicData" ? basicRows : detailedRows);
    return Response.json({ data: receipt });
  };
  try {
    const posts = await scrapeInstagramAccount({
      handle: OWNER, resultsLimit: 4, daysBack: 1, selectAllEligiblePosts: true,
      maxTotalChargeUsd: 0.01,
      onRequestStarted: async () => { markerCount += 1; },
      onTransportInvoked: () => { transportCount += 1; },
      ...options,
    });
    return { posts, calls, markerCount };
  } finally {
    let settledUsage = 0;
    for (const call of calls) {
      assert.ok(call.cap > 0);
      assert.ok(settledUsage + call.cap <= (options.maxTotalChargeUsd ?? 0.01) + 1e-9,
        "each phase plus settled prior charges must fit the original per-handle reservation");
      settledUsage += call.usage;
      assert.equal(call.input.skipPinnedPosts, true);
      assert.equal(call.input.onlyPostsNewerThan,
        options.onlyPostsNewerThan && Date.parse(options.onlyPostsNewerThan) > Date.parse(CUTOFF)
          ? options.onlyPostsNewerThan : CUTOFF);
    }
    checks += 1;
  }
}

try {
  Date.now = () => NOW;
  console.info = () => {};
  process.env.APIFY_API_TOKEN = "qa-only-apify-token";
  process.env.INSTAGRAM_SCRAPER_PROVIDER = "apify";
  process.env.APIFY_DATA_DETAIL_LEVEL = "detailedData";
  process.env.APIFY_SKIP_PINNED_POSTS = "false";
  delete process.env.APIFY_MAX_TOTAL_CHARGE_USD_PER_RUN;

  for (const options of [
    {}, { daysBack: 30 }, { noAgeCutoff: true },
    { daysBack: 30, onlyPostsNewerThan: "2026-01-01T00:00:00.000Z" },
    { onlyPostsNewerThan: "invalid" },
  ]) {
    const request = buildApifyInstagramScrapeRequest({ actorUsernameInput: OWNER, ...options, env: {} });
    assert.equal(request.input.onlyPostsNewerThan, CUTOFF, "legacy and manual inputs must never widen paid fetching beyond 24 hours");
    assert.equal(request.input.dataDetailLevel, "basicData");
    assert.equal(request.input.skipPinnedPosts, true);
    checks += 1;
  }
  const laterBoundary = "2026-10-17T10:30:00.000Z";
  assert.equal(buildApifyInstagramScrapeRequest({ actorUsernameInput: OWNER,
    onlyPostsNewerThan: laterBoundary, env: {} }).input.onlyPostsNewerThan, laterBoundary,
  "a newer saved watermark must still prevent repeat provider results");

  let directFetches = 0;
  globalThis.fetch = async () => { directFetches += 1; throw new Error("unverified direct URL reached paid transport"); };
  await assert.rejects(() => scrapeInstagramAccount({ handle: SINGLE.url, daysBack: 1 }),
    /age|recent|verified|24|profile/i);
  assert.equal(directFetches, 0, "an arbitrary direct-post URL provides no trustworthy pre-payment age evidence");
  checks += 1;

  const fresh = await scenario([SINGLE], []);
  assert.equal(fresh.calls.length, 1, "a complete single-image source must not purchase detailed data");
  assert.equal(fresh.calls[0].input.dataDetailLevel, "basicData", "stale detailedData env values cannot force profile-wide surcharges");
  assert.equal(fresh.posts[0].postId, SINGLE.id);
  assert.equal(fresh.posts[0].caption, SINGLE.caption);
  assert.equal(fresh.posts[0].postedAt, FRESH);

  const burstRows = Array.from({ length: 6 }, (_, index) => fixture(71000100 + index));
  const burst = await scenario(burstRows, [], { resultsLimit: 6 }, (call) => { call.usage = 0.0078; });
  assert.equal(burst.posts.length, 6, "a full six-post basic burst must not be truncated to reserve speculative detail costs");
  assert.equal(burst.calls.length, 1);
  assert.equal(burst.calls[0].input.resultsLimit, 6);
  assert.equal(burst.calls[0].maxItems, 6);
  assert.equal(burst.calls[0].cap, 0.01, "discovery retains the existing whole logical ceiling when details are unnecessary");

  const narrowed = await scenario([SINGLE, fixture(71000009, { timestamp: "2026-10-17T10:00:00.000Z" })], [],
    { onlyPostsNewerThan: laterBoundary });
  assert.deepEqual(narrowed.posts.map((post) => post.postId), [SINGLE.id],
    "a newer checkpoint must also be enforced locally when the actor returns an older row");

  const ineligible = await scenario([
    fixture(71000010, { type: "Sidecar", timestamp: "2026-10-16T11:59:59.000Z" }),
    fixture(71000011, { type: "Sidecar", timestamp: undefined }),
    fixture(71000012, { type: "Sidecar", isPinned: true, timestamp: "2026-10-10T10:00:00.000Z" }),
    fixture(71000013, { type: "Sidecar", ownerUsername: "foreign_collaborator" }),
    fixture(71000014, { type: "Sidecar", timestamp: "2026-10-17T12:01:00.000Z" }),
    fixture(71000015, { type: "Sidecar", url: "https://example.com/p/QA71000015/" }),
    fixture(71000016, { type: "Sidecar", shortCode: "contradictory_short_code" }),
  ], [DETAILED_CAROUSEL], { daysBack: 30, noAgeCutoff: true, skipPinnedPosts: false, pinnedPostPolicy: "include_recent" });
  assert.deepEqual(ineligible.posts, []);
  assert.equal(ineligible.calls.length, 1, "old, undated, stale pins and foreign-owner sources must never trigger paid enrichment");
  assert.equal(getInstagramScrapeRawItemCount(ineligible.posts), 7);

  const full = await scenario([BASIC_CAROUSEL], [DETAILED_CAROUSEL]);
  assert.equal(full.calls.length, 2, "a recent carousel missing its siblings needs one bounded detailed read");
  assert.equal(full.calls[1].input.dataDetailLevel, "detailedData");
  assert.deepEqual(full.calls[1].input.username, [BASIC_CAROUSEL.url], "only the verified recent post may receive details");
  assert.equal(full.posts.length, 1);
  assert.equal(full.posts[0].postId, BASIC_CAROUSEL.id);
  assert.equal(full.posts[0].username, OWNER);
  assert.equal(full.posts[0].postedAt, FRESH);
  assert.equal(full.posts[0].imageSlideCount, 3);
  assert.deepEqual(full.posts[0].imageSlides.map((slide) => [slide.index, slide.mediaType]),
    [[0, "image"], [1, "video"], [2, "image"]]);
  assert.deepEqual(full.posts[0].imageSlides.map((slide) => slide.imageUrls[0]), CHILDREN.map((child) => child.displayUrl));
  assert.ok(full.posts[0].imageSlides[2].imageUrls.includes(CHILDREN[2].displayUrlHD));
  assert.equal(getInstagramScrapeRawItemCount(full.posts), 1, "enrichment must not inflate the raw profile-window result count");

  const alreadyComplete = await scenario([DETAILED_CAROUSEL], []);
  assert.equal(alreadyComplete.calls.length, 1, "a complete ordered basic-data manifest already has every slide");
  assert.equal(alreadyComplete.posts[0].imageSlideCount, 3);

  const completeWithoutCount = await scenario([{ ...DETAILED_CAROUSEL,
    carouselMediaCount: undefined, childPostsCount: undefined }], []);
  assert.equal(completeWithoutCount.calls.length, 1, "explicit complete ordered children establish the manifest without a count hint");
  for (const basic of [
    { ...BASIC_CAROUSEL, carouselMediaCount: undefined, childPostsCount: undefined },
    { ...BASIC_CAROUSEL, images: CHILDREN.map((child) => child.displayUrl),
      carouselMediaCount: undefined, childPostsCount: undefined },
  ]) {
    const unknown = await scenario([basic], [DETAILED_CAROUSEL]);
    assert.equal(unknown.calls.length, 2, "an unknown count or flat image list must not certify all carousel children");
    assert.equal(unknown.posts[0].imageSlideCount, 3);
  }
  const countedImages = await scenario([{ ...BASIC_CAROUSEL, images: CHILDREN.map((child) => child.displayUrl) }], []);
  assert.equal(countedImages.calls.length, 1, "an independently counted complete basic images manifest needs no detail surcharge");
  assert.equal(countedImages.posts[0].imageSlideCount, 3);
  for (const basic of [
    { ...SINGLE, caption: undefined }, { ...SINGLE, type: undefined }, { ...SINGLE, displayUrl: undefined },
  ]) {
    const requiredFields = await scenario([basic], [SINGLE]);
    assert.equal(requiredFields.calls.length, 2, "missing required source fields may receive only targeted details");
    assert.equal(requiredFields.posts[0].caption, SINGLE.caption);
  }
  const mixed = await scenario([SINGLE, BASIC_CAROUSEL], [DETAILED_CAROUSEL]);
  assert.deepEqual(new Set(mixed.posts.map((post) => post.postId)), new Set([SINGLE.id, BASIC_CAROUSEL.id]),
    "enriching one carousel must preserve every other selected complete basic source");
  assert.deepEqual(mixed.calls[1].input.username, [BASIC_CAROUSEL.url]);

  for (const detailed of [
    { ...DETAILED_CAROUSEL, id: "99999999" },
    { ...DETAILED_CAROUSEL, url: "https://www.instagram.com/p/OTHER/" },
    { ...DETAILED_CAROUSEL, ownerUsername: "foreign_owner" },
    { ...DETAILED_CAROUSEL, ownerUsername: undefined },
    { ...DETAILED_CAROUSEL, timestamp: "2026-10-17T11:00:01.000Z" },
    { ...DETAILED_CAROUSEL, timestamp: undefined },
    { ...DETAILED_CAROUSEL, timestamp: "2026-10-15T11:00:00.000Z" },
    { ...DETAILED_CAROUSEL, type: "Image", childPosts: undefined },
    { ...DETAILED_CAROUSEL, childPosts: CHILDREN.slice(0, 2) },
    { ...DETAILED_CAROUSEL, childPosts: [CHILDREN[0], { ...CHILDREN[1], displayUrl: undefined }, CHILDREN[2]] },
    { ...DETAILED_CAROUSEL, childPosts: [CHILDREN[0], CHILDREN[0], CHILDREN[2]] },
    { ...DETAILED_CAROUSEL, carouselMediaCount: 4 },
  ]) {
    await assert.rejects(() => scenario([BASIC_CAROUSEL, SINGLE], [detailed]),
      /detail|carousel|source|identity|complete|match|owner|timestamp/i,
      "unverified or incomplete enrichment must not return a cover-only carousel or advance its checkpoint");
  }
  await assert.rejects(() => scenario([BASIC_CAROUSEL, SINGLE], []), /detail|carousel|source|complete|match/i);
  await assert.rejects(() => scenario([{ ...BASIC_CAROUSEL,
    childPosts: [CHILDREN[0], { ...CHILDREN[1], displayUrl: undefined }, CHILDREN[2]],
  }], [{ ...DETAILED_CAROUSEL, childPosts: [CHILDREN[2], CHILDREN[1], CHILDREN[0]] }]),
  /detail|carousel|source|complete|match|order|slide/i,
  "hydration cannot reorder provider-attested basic child identities");

  let insufficientPaidCalls = 0;
  await assert.rejects(() => scenario([BASIC_CAROUSEL, SINGLE], [DETAILED_CAROUSEL],
    { maxTotalChargeUsd: 0.006 }, () => { insufficientPaidCalls += 1; }), /budget|charge|cap|remaining/i);
  assert.equal(insufficientPaidCalls, 1, "insufficient unreserved budget must never launch a second paid phase");

  let unsettledPaidCalls = 0;
  await assert.rejects(() => scenario([BASIC_CAROUSEL], [DETAILED_CAROUSEL], {}, (call) => {
    unsettledPaidCalls += 1;
    call.usage = undefined;
  }), /billing|charge|receipt/i);
  assert.equal(unsettledPaidCalls, 1, "missing settled billing evidence cannot authorize details");

  let expiredPaidCalls = 0;
  try {
    await assert.rejects(() => scenario([BASIC_CAROUSEL], [DETAILED_CAROUSEL],
      { abortAtMs: NOW + 10_000 }, () => {
        expiredPaidCalls += 1;
        Date.now = () => NOW + 8_000;
      }), /deadline/i);
    assert.equal(expiredPaidCalls, 1, "details cannot reset an absolute lease nearly exhausted by discovery");
  } finally {
    Date.now = () => NOW;
  }

  // Existing datasets can be imported without starting a paid actor. The new
  // acquisition cutoff must not silently erase historical source documents.
  // A newer basic cover must not win deduplication over an older complete run.
  const historicalTimestamp = "2026-10-01T10:00:00.000Z";
  const historicalBasic = fixture(71000051, { type: "Sidecar", timestamp: historicalTimestamp,
    caption: "Newer incomplete basic cover", carouselMediaCount: 3, childPostsCount: 3 });
  const historicalDetail = { ...historicalBasic, caption: "Older complete carousel evidence", childPosts: CHILDREN };
  const historicalSingle = fixture(71000050, { timestamp: historicalTimestamp });
  const incompleteHistoricalSingle = fixture(71000052, { timestamp: historicalTimestamp, caption: undefined });
  const historyCalls = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(init?.method, undefined);
    const parsed = new URL(String(url));
    historyCalls.push(parsed.pathname);
    if (parsed.pathname.endsWith("/runs")) return Response.json({ data: { items: [
      { id: "qa-newer-basic-run", defaultDatasetId: "qa-newer-basic-dataset", status: "SUCCEEDED" },
      { id: "qa-older-detail-run", defaultDatasetId: "qa-older-detail-dataset", status: "SUCCEEDED" },
    ] } });
    if (parsed.pathname === "/v2/datasets/qa-newer-basic-dataset/items") {
      return Response.json([historicalBasic, incompleteHistoricalSingle]);
    }
    assert.equal(parsed.pathname, "/v2/datasets/qa-older-detail-dataset/items");
    return Response.json([historicalDetail, historicalSingle]);
  };
  const history = await loadRecentApifyRunPosts({ handles: [OWNER], runsLimit: 2 });
  assert.equal(history.runsScanned, 2);
  assert.equal(history.importedPosts, 2, "incomplete basic carousels and missing-caption singles cannot enter history import");
  const historicalPosts = new Map(history.importedPostsByHandle[OWNER].map((post) => [post.postId, post]));
  assert.deepEqual(new Set(historicalPosts.keys()), new Set([historicalDetail.id, historicalSingle.id]));
  assert.equal(historicalPosts.get(historicalDetail.id).caption, historicalDetail.caption,
    "a newer incomplete basic row cannot shadow an older complete detail row for the same source");
  assert.equal(historicalPosts.get(historicalDetail.id).imageSlideCount, 3);
  assert.deepEqual(historicalPosts.get(historicalDetail.id).imageSlides.map((slide) => slide.imageUrls[0]),
    CHILDREN.map((child) => child.displayUrl));
  assert.ok([...historicalPosts.values()].every((post) => post.postedAt === historicalTimestamp),
    "complete historical rows remain eligible regardless of publication age");
  assert.equal(historyCalls.length, 3, "history import performs only read-only run and dataset lookups");
  checks += 3;
  console.log(`Apify recent-media QA passed: ${checks} mocked scenarios; strict 24h, basic first, verified complete carousels, shared charge caps and history preservation.`);
} finally {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
  console.info = originalInfo;
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
