import assert from "node:assert/strict";

import { parseExtractedEventData } from "../lib/ai/extract-event-data.ts";
import {
  bindSourceOccurrenceMetadata,
  createEmptyIngestionSummary,
  isExistingEventEligibleForDurableMediaRetry,
  processIngestionPostWithExtractionForTesting,
} from "../lib/pipeline/run-instagram-ingestion.ts";
import { isCanonicallyGroundedApprovedEvent } from "../convex/publicEventGrounding.ts";
import { hasEventEvidenceV2AutoApproval } from "../lib/events/event-update-precondition.ts";
import {
  createEvent,
  listPublicCalendarEventsWindowPaginated,
  listPublicEventsWindow,
  repairTrustedV2EventVenue,
  recordInstagramSourceOccurrenceSatisfaction,
} from "../convex/events.ts";
import { markOpenAiAnalysisAttemptStarted } from "../convex/scrapedPosts.ts";

function isoDateDaysFromNow(offsetDays) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function confirmation(evidence) {
  return {
    confidence: 0.99,
    found_in: ["caption"],
    evidence,
    evidence_snippets: [{ source: "caption", text: evidence }],
    notes: "Durability boundary QA fixture.",
  };
}

const eventDate = isoDateDaysFromNow(90);
const extractionFixture = {
  extraction_contract_version: "event_evidence_v2",
  is_event: true,
  non_event_reason: "",
  title: "Boundary QA Concert",
  date: eventDate,
  time: "20:00",
  venue: "Boundary QA Hall",
  city: "Belgrade",
  country: "Serbia",
  price: "",
  currency: "",
  artists: ["Boundary Artist"],
  category: "music",
  description: "Boundary Artist performs.",
  confidence: 0.99,
  reasoning_notes: "Exact source evidence.",
  source_caption: `Boundary QA Concert with Boundary Artist on ${eventDate} at 20:00.`,
  source_url: "https://www.instagram.com/p/BOUNDARYV2/",
  date_evidence: {
    exact_text: eventDate,
    source: "caption",
    is_relative: false,
    resolved_date: eventDate,
  },
  time_evidence: {
    status: "start_time_stated",
    exact_text: "20:00",
    source: "caption",
  },
  source_conflicts: [],
  shared_schedule_context: {
    venue: {
      applies_to_all: false,
      value: "",
      evidence: "",
      source: "unknown",
    },
    time: {
      applies_to_all: false,
      value: "",
      evidence: "",
      source: "unknown",
    },
  },
  schedule_entries: [],
  _openaiUsage: {
    model: "gpt-5-mini-2025-08-07",
    inputTokens: 1_234,
    outputTokens: 321,
    totalTokens: 1_555,
  },
  field_confirmation: {
    title: confirmation("Boundary QA Concert"),
    location: confirmation("Belgrade"),
    location_name: confirmation("Boundary QA Hall"),
    price: confirmation(""),
    start_time: confirmation("20:00"),
    short_description: confirmation("Boundary Artist performs"),
    artists: confirmation("Boundary Artist"),
  },
};

const serializedExtraction = JSON.stringify(extractionFixture);
const parsedCachedExtraction = parseExtractedEventData(
  JSON.parse(serializedExtraction),
);
assert.deepEqual(parsedCachedExtraction._openaiUsage, extractionFixture._openaiUsage);
assert.equal(
  JSON.stringify(parsedCachedExtraction),
  serializedExtraction,
  "Parsing a durable v2 cache must preserve _openaiUsage and byte-equivalent JSON reserialization.",
);

function indexCriteria(configure) {
  const criteria = {};
  const builder = {
    eq(field, value) {
      criteria[field] = value;
      return builder;
    },
  };
  configure(builder);
  return criteria;
}

async function withoutIngestionConsole(callback) {
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = () => {};
  console.error = () => {};
  try {
    return await callback();
  } finally {
    console.info = originalInfo;
    console.error = originalError;
  }
}

const previousCronSecret = process.env.CRON_SECRET;
process.env.CRON_SECRET = "qa-event-evidence-v2-secret";
try {
  const now = Date.now();
  let legacyPost = {
    _id: "scraped-post-v2-upgrade",
    handle: "boundary_venue",
    username: "boundary_venue",
    postId: "BOUNDARYV2",
    instagramPostUrl: extractionFixture.source_url,
    imageUrls: [],
    sourceRevision: 7,
    processingStatus: "processing",
    processingLeaseOwner: "qa-upgrade-owner",
    processingLeaseExpiresAt: now + 60_000,
    analysisRevision: 7,
    analysisResultJson: JSON.stringify({ title: "Legacy cached result" }),
    analysisCompletedAt: now - 1_000,
    analysisModel: "gpt-4.1-mini",
    analysisAttemptRevision: 7,
    analysisAttemptStartedAt: now - 2_000,
    analysisAttemptOwner: "old-owner",
    analysisAttemptProtocol: "openai-responses:event-extraction:legacy",
    analysisAttemptBudgetDayKey: "2026-08-10",
  };
  const budgets = [];
  const upgradeCtx = {
    auth: { getUserIdentity: async () => null },
    db: {
      async get(id) {
        return id === legacyPost._id ? legacyPost : null;
      },
      async patch(id, patch) {
        assert.equal(id, legacyPost._id);
        legacyPost = { ...legacyPost, ...structuredClone(patch) };
      },
      async insert(table, value) {
        assert.equal(table, "ingestionDailyBudgets");
        budgets.push({ _id: `budget-${budgets.length + 1}`, ...structuredClone(value) });
        return budgets.at(-1)._id;
      },
      query(table) {
        assert.equal(table, "ingestionDailyBudgets");
        return {
          withIndex(_index, configure) {
            const criteria = indexCriteria(configure);
            return {
              async unique() {
                return budgets.find((budget) => budget.key === criteria.key) ?? null;
              },
            };
          },
        };
      },
    },
  };
  const upgradeArgs = {
    handle: legacyPost.handle,
    scrapedPostId: legacyPost._id,
    postId: legacyPost.postId,
    instagramPostUrl: legacyPost.instagramPostUrl,
    owner: "qa-upgrade-owner",
    sourceRevision: 7,
    protocol: "openai-responses:event-extraction:event_evidence_v2",
    budgetDayKey: "2026-08-11",
    dailyRequestLimit: 10,
    serviceSecret: process.env.CRON_SECRET,
  };
  const upgradeStarted = await markOpenAiAnalysisAttemptStarted._handler(
    upgradeCtx,
    upgradeArgs,
  );
  assert.equal(upgradeStarted.recorded, true);
  assert.equal(upgradeStarted.reason, "started");
  assert.ok(upgradeStarted.startedAt >= now);
  assert.equal(legacyPost.analysisResultJson, undefined);
  assert.equal(legacyPost.analysisRevision, undefined);
  assert.equal(legacyPost.analysisContractVersion, undefined);
  assert.equal(legacyPost.analysisAttemptRevision, 7);
  assert.equal(legacyPost.analysisAttemptOwner, upgradeArgs.owner);
  assert.equal(legacyPost.analysisAttemptProtocol, upgradeArgs.protocol);
  assert.equal(budgets.length, 1);
  assert.equal(budgets[0].chargedMicros, 1);
  assert.deepEqual(
    await markOpenAiAnalysisAttemptStarted._handler(upgradeCtx, upgradeArgs),
    { recorded: false, reason: "already_started" },
    "A same-revision legacy cache may start exactly one v2 upgrade attempt.",
  );
  assert.equal(budgets.length, 1);
  assert.equal(budgets[0].chargedMicros, 1);

  const postId = "BOUNDARYV2";
  const sourceUrl = `https://www.instagram.com/p/${postId}/`;
  const sourceCaption = extractionFixture.source_caption;
  const sourcePostedAt = new Date(now - 86_400_000).toISOString();
  const imageSourceUrl = "https://images.example.test/boundary-v2.jpg";
  const imageStorageId = "storage-boundary-v2";
  const imageChecksum = "a".repeat(64);
  const rawExtractionJson = serializedExtraction;

  function makeNormalizedFields(extractionMode, dateEvidenceSource) {
    return {
      extractionContractVersion: "event_evidence_v2",
      extractionIsEvent: true,
      extractionNonEventReason: "",
      extractionSourceConflicts: [],
      extractionSourceConflictCount: 0,
      extractionMode,
      sourceGroundingVersion: 5,
      sourceGroundingEvidence: "persisted_openai_event_evidence_v2",
      sourceGroundingInstagramHandle: "boundary_venue",
      sourceGroundingInstagramPostId: postId,
      sourceGroundingInstagramPostUrl: sourceUrl,
      sourceGroundingSourceCaption: sourceCaption,
      dateEvidenceVerified: true,
      timeEvidenceVerified: true,
      identityEvidenceVerified: true,
      venueEvidenceVerified: true,
      structuredEvidenceVerified: true,
      dateEvidenceText: eventDate,
      dateEvidenceSource,
      dateEvidenceIsRelative: false,
      dateEvidenceResolvedDate: eventDate,
      timeEvidenceKind: "start_time_stated",
      timeSource: "caption",
      timeEvidenceText: "20:00",
      timeConfidence: 0.99,
      timeStatus: "confirmed",
      title: extractionFixture.title,
      normalizedDate: eventDate,
      time: extractionFixture.time,
      normalizedVenue: extractionFixture.venue,
      artists: extractionFixture.artists,
      approvalTitleSensible: true,
      normalizedIsValid: true,
      titleUsedFallback: false,
      dateSuspiciousYear: false,
      moderationAutoApproved: true,
      moderationAutoApproveRule: "event_evidence_v2",
      moderationPendingReasons: [],
      moderationConfidenceScore: 0.99,
    };
  }

  function makeEvent(extractionMode = "poster") {
    const dateEvidenceSource = extractionMode === "poster" ? "poster" : "caption";
    return {
      _id: `event-${extractionMode}`,
      _creationTime: now,
      title: extractionFixture.title,
      date: eventDate,
      time: extractionFixture.time,
      timeSource: "caption",
      timeEvidenceText: "20:00",
      timeConfidence: 0.99,
      timeStatus: "confirmed",
      timeEvidenceKind: "start_time_stated",
      dateEvidenceText: eventDate,
      dateEvidenceSource,
      dateEvidenceIsRelative: false,
      dateEvidenceResolvedDate: eventDate,
      sourceConflictFields: [],
      venue: extractionFixture.venue,
      artists: extractionFixture.artists,
      eventType: "music",
      status: "approved",
      createdAt: now,
      updatedAt: now,
      instagramPostId: postId,
      instagramPostUrl: sourceUrl,
      sourceCaption,
      sourcePostedAt,
      rawExtractionJson,
      normalizedFieldsJson: JSON.stringify(
        makeNormalizedFields(extractionMode, dateEvidenceSource),
      ),
      ...(extractionMode === "poster"
        ? {
            imageStorageId,
            imageUrl: "https://storage.example.test/boundary-v2.jpg",
          }
        : {}),
    };
  }

  function makePersistedPost(extractionMode = "poster") {
    return {
      _id: "persisted-boundary-v2",
      handle: "boundary_venue",
      username: "boundary_venue",
      postId,
      caption: sourceCaption,
      instagramPostUrl: sourceUrl,
      postedAt: sourcePostedAt,
      sourceRevision: 3,
      analysisRevision: 3,
      analysisResultJson: rawExtractionJson,
      analysisContractVersion: "event_evidence_v2",
      analysisIsEvent: true,
      analysisModel: "gpt-5-mini-2025-08-07",
      imageUrls: extractionMode === "poster" ? [imageSourceUrl] : [],
      ...(extractionMode === "poster"
        ? {
            analysisImageSourceUrl: imageSourceUrl,
            analysisImageChecksumSha256: imageChecksum,
            imageStorageId,
          }
        : {}),
    };
  }

  function makePosterAsset(overrides = {}) {
    return {
      _id: "asset-boundary-v2",
      sourceKey: `instagram-post:${postId}`,
      storageId: imageStorageId,
      url: "https://storage.example.test/boundary-v2.jpg",
      checksumSha256: imageChecksum,
      ...overrides,
    };
  }

  function makeGroundingCtx(persistedPost, assets) {
    let posterQueries = 0;
    return {
      ctx: {
        db: {
          query(table) {
            return {
              withIndex(_index, configure) {
                const criteria = indexCriteria(configure);
                return {
                  async take(limit) {
                    if (table === "scrapedPosts") {
                      return [persistedPost]
                        .filter(
                          (post) =>
                            post.handle === criteria.handle &&
                            post.postId === criteria.postId,
                        )
                        .slice(0, limit);
                    }
                    if (table === "mediaAssets") {
                      posterQueries += 1;
                      return assets
                        .filter((asset) => asset.sourceKey === criteria.sourceKey)
                        .slice(0, limit);
                    }
                    throw new Error(`Unexpected grounding table ${table}`);
                  },
                };
              },
            };
          },
        },
      },
      get posterQueries() {
        return posterQueries;
      },
    };
  }

  const posterEvent = makeEvent("poster");
  const posterPost = makePersistedPost("poster");
  const exactPosterGrounding = makeGroundingCtx(posterPost, [makePosterAsset()]);
  assert.equal(
    hasEventEvidenceV2AutoApproval(posterEvent.normalizedFieldsJson, posterEvent),
    true,
    "The exact poster fixture must satisfy the local v2 public-field attestation.",
  );
  assert.equal(
    await isCanonicallyGroundedApprovedEvent(exactPosterGrounding.ctx, posterEvent),
    true,
    "Exact persisted poster storage and checksum evidence must authorize publication.",
  );
  assert.equal(exactPosterGrounding.posterQueries, 1);

  const repairVenue = {
    _id: "venue-boundary-v2",
    _creationTime: now,
    name: extractionFixture.venue,
    instagramHandle: "boundary_venue",
    category: "music",
    publicStatus: "published",
    scrapeActive: true,
    createdAt: now,
    updatedAt: now,
  };
  const repairSource = {
    _id: "source-boundary-v2",
    _creationTime: now,
    handle: "boundary_venue",
    role: "unknown",
    venueId: repairVenue._id,
    active: true,
    discoveredAt: now,
    activatedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const repairCurrentFields = {
    ...makeNormalizedFields("poster", "poster"),
    rawVenue: extractionFixture.venue,
    normalizedVenue: "",
    trustedVenueSource: true,
  };
  const repairNextFields = {
    ...repairCurrentFields,
    normalizedVenue: extractionFixture.venue,
  };
  const repairEvent = {
    ...posterEvent,
    _id: "event-trusted-v2-venue-repair",
    venue: "",
    normalizedFieldsJson: JSON.stringify(repairCurrentFields),
  };
  const repairEvents = [repairEvent];
  const repairAudits = [];
  const repairCtx = {
    auth: { getUserIdentity: async () => null },
    db: {
      async get(id) {
        return repairEvents.find((event) => event._id === id) ?? null;
      },
      async patch(id, patch) {
        const event = repairEvents.find((candidate) => candidate._id === id);
        if (!event) throw new Error(`Unexpected trusted venue repair patch ${id}`);
        Object.assign(event, structuredClone(patch));
      },
      async insert(table, value) {
        assert.equal(table, "eventAuditLog");
        const id = `venue-repair-audit-${repairAudits.length + 1}`;
        repairAudits.push({ _id: id, ...structuredClone(value) });
        return id;
      },
      query(table) {
        if (table === "venues") {
          return { collect: async () => [repairVenue] };
        }
        if (table === "events") {
          return {
            withIndex(_index, configure) {
              const criteria = indexCriteria(configure);
              return {
                async collect() {
                  return repairEvents.filter((event) => event.date === criteria.date);
                },
              };
            },
          };
        }
        return {
          withIndex(_index, configure) {
            const criteria = indexCriteria(configure);
            const records =
              table === "instagramSources"
                ? [repairSource]
                : table === "scrapedPosts"
                  ? [posterPost]
                  : table === "mediaAssets"
                    ? [makePosterAsset()]
                    : [];
            return {
              async take(limit) {
                return records
                  .filter((record) =>
                    Object.entries(criteria).every(
                      ([field, value]) => record[field] === value,
                    ),
                  )
                  .slice(0, limit);
              },
            };
          },
        };
      },
    },
  };
  const venueRepairResult = await repairTrustedV2EventVenue._handler(repairCtx, {
    id: repairEvent._id,
    expectedStatus: "approved",
    expectedUpdatedAt: repairEvent.updatedAt,
    expectedNormalizedFieldsJson: repairEvent.normalizedFieldsJson,
    nextVenue: extractionFixture.venue,
    nextNormalizedFieldsJson: JSON.stringify(repairNextFields),
    moderationNote: "Exact trusted source venue restored after v2 normalization loss.",
    serviceSecret: process.env.CRON_SECRET,
  });
  assert.equal(venueRepairResult.updated, true);
  assert.equal(repairEvent.venue, extractionFixture.venue);
  assert.equal(repairEvent.venueId, repairVenue._id);
  assert.equal(repairEvent.venueInstagramHandle, repairVenue.instagramHandle);
  assert.equal(
    JSON.parse(repairEvent.normalizedFieldsJson).normalizedVenue,
    extractionFixture.venue,
  );
  assert.equal(repairAudits.length, 1);
  assert.equal(repairAudits[0].action, "trusted_v2_venue_repaired");

  const unsafeRepairFields = {
    ...repairCurrentFields,
    normalizedVenue: extractionFixture.venue,
    title: "Changed during venue repair",
  };
  const unsafeRepairEvent = {
    ...posterEvent,
    _id: "event-unsafe-v2-venue-repair",
    venue: "",
    normalizedFieldsJson: JSON.stringify(repairCurrentFields),
  };
  repairEvents.push(unsafeRepairEvent);
  await assert.rejects(
    repairTrustedV2EventVenue._handler(repairCtx, {
      id: unsafeRepairEvent._id,
      expectedStatus: "approved",
      expectedUpdatedAt: unsafeRepairEvent.updatedAt,
      expectedNormalizedFieldsJson: unsafeRepairEvent.normalizedFieldsJson,
      nextVenue: extractionFixture.venue,
      nextNormalizedFieldsJson: JSON.stringify(unsafeRepairFields),
      moderationNote: "Attempted unsafe venue repair must fail without any mutation.",
      serviceSecret: process.env.CRON_SECRET,
    }),
    /may only change normalizedVenue/i,
  );
  assert.equal(unsafeRepairEvent.venue, "");

  for (const [label, persistedPost, assets] of [
    ["missing media asset", posterPost, []],
    [
      "wrong media source key",
      posterPost,
      [makePosterAsset({ sourceKey: "instagram-post:another-post" })],
    ],
    [
      "mismatched storage id",
      posterPost,
      [makePosterAsset({ storageId: "storage-mismatch" })],
    ],
    [
      "mismatched checksum",
      posterPost,
      [makePosterAsset({ checksumSha256: "b".repeat(64) })],
    ],
    [
      "missing persisted storage id",
      { ...posterPost, imageStorageId: undefined },
      [makePosterAsset()],
    ],
    ["ambiguous duplicate assets", posterPost, [makePosterAsset(), makePosterAsset({ _id: "asset-duplicate" })]],
  ]) {
    const grounding = makeGroundingCtx(persistedPost, assets);
    assert.equal(
      await isCanonicallyGroundedApprovedEvent(grounding.ctx, posterEvent),
      false,
      `Poster evidence must reject ${label}.`,
    );
  }

  const rotatedPosterGrounding = makeGroundingCtx(
    {
      ...posterPost,
      imageUrls: ["https://scontent.cdninstagram.com/re-signed-poster.jpg"],
    },
    [makePosterAsset()],
  );
  assert.equal(
    await isCanonicallyGroundedApprovedEvent(rotatedPosterGrounding.ctx, posterEvent),
    true,
    "A rotating upstream signed URL must not invalidate exact durable poster bytes/checksum.",
  );
  const unrelatedDisplayedImageGrounding = makeGroundingCtx(
    posterPost,
    [makePosterAsset()],
  );
  assert.equal(
    await isCanonicallyGroundedApprovedEvent(unrelatedDisplayedImageGrounding.ctx, {
      ...posterEvent,
      imageStorageId: "unrelated-storage",
      imageUrl: "https://storage.example.test/unrelated.jpg",
    }),
    false,
    "Poster publication must reject a displayed image that is not the exact attested asset.",
  );
  for (const partialImage of [
    { imageStorageId },
    { imageUrl: "https://storage.example.test/boundary-v2.jpg" },
  ]) {
    assert.equal(
      await isCanonicallyGroundedApprovedEvent(
        makeGroundingCtx(posterPost, [makePosterAsset()]).ctx,
        {
          ...posterEvent,
          imageStorageId: undefined,
          imageUrl: undefined,
          ...partialImage,
        },
      ),
      false,
      "Poster publication must reject a partial displayed-image identity.",
    );
  }
  const mismatchedSourceUsernameGrounding = makeGroundingCtx(
    { ...posterPost, username: "different_account" },
    [makePosterAsset()],
  );
  assert.equal(
    await isCanonicallyGroundedApprovedEvent(
      mismatchedSourceUsernameGrounding.ctx,
      posterEvent,
    ),
    false,
    "Public v2 grounding must reject a persisted username outside the exact source handle.",
  );

  function makePublicWindowCtx(events, persistedPost, assets) {
    const chain = {
      eq() {
        return chain;
      },
      gte() {
        return chain;
      },
      lt() {
        return chain;
      },
    };
    return {
      db: {
        async get() {
          return null;
        },
        query(table) {
          return {
            withIndex(_index, configure) {
              configure(chain);
              return {
                async paginate() {
                  if (table !== "events") {
                    throw new Error(`Unexpected pagination table ${table}`);
                  }
                  return {
                    page: events,
                    continueCursor: "",
                    isDone: true,
                  };
                },
                async take(limit) {
                  if (table === "scrapedPosts") return [persistedPost].slice(0, limit);
                  if (table === "mediaAssets") return assets.slice(0, limit);
                  throw new Error(`Unexpected public grounding table ${table}`);
                },
              };
            },
          };
        },
      },
    };
  }

  const invalidStructuredEvent = {
    ...posterEvent,
    _id: "invalid-structured-v2",
    time: "23:59",
  };
  const legacyApprovedEvent = {
    ...posterEvent,
    _id: "legacy-approved-event",
    rawExtractionJson: JSON.stringify({ legacy: true }),
    normalizedFieldsJson: JSON.stringify({ legacy: true }),
  };
  for (const [label, queryObject, args] of [
    [
      "list",
      listPublicEventsWindow,
      {
        fromDate: eventDate,
        beforeDate: isoDateDaysFromNow(91),
        paginationOpts: { cursor: null, numItems: 10 },
      },
    ],
    [
      "calendar",
      listPublicCalendarEventsWindowPaginated,
      {
        fromDate: eventDate,
        beforeDate: isoDateDaysFromNow(91),
        cursor: null,
      },
    ],
  ]) {
    const result = await queryObject._handler(
      makePublicWindowCtx(
        [posterEvent, invalidStructuredEvent, legacyApprovedEvent],
        posterPost,
        [makePosterAsset()],
      ),
      args,
    );
    assert.deepEqual(
      result.page.map((event) => event._id),
      [posterEvent._id, legacyApprovedEvent._id],
      `The public ${label} must revalidate v2 rows without hiding approved legacy rows.`,
    );
  }

  const captionEvent = makeEvent("caption_only");
  const captionPost = makePersistedPost("caption_only");
  const captionGrounding = makeGroundingCtx(captionPost, []);
  assert.equal(
    await isCanonicallyGroundedApprovedEvent(captionGrounding.ctx, captionEvent),
    true,
    "Caption-only v2 evidence must not require a poster asset.",
  );
  assert.equal(
    captionGrounding.posterQueries,
    0,
    "Caption-only grounding must not query poster assets.",
  );

  const tamperedTimeGrounding = makeGroundingCtx(captionPost, []);
  assert.equal(
    await isCanonicallyGroundedApprovedEvent(tamperedTimeGrounding.ctx, {
      ...captionEvent,
      time: "21:30",
    }),
    false,
    "A public time that differs from the v2 attestation must fail closed.",
  );

  const unresolvedBoundaryDefects = [];

  function makeOfflinePipelineClient(options = {}) {
    const creates = [];
    const receiptWrites = [];
    const otherMutations = [];
    const actions = [];
    const queries = [];
    return {
      creates,
      receiptWrites,
      otherMutations,
      actions,
      queries,
      client: {
        async query(_reference, args) {
          queries.push(structuredClone(args));
          if ("sourceIdentity" in args) return options.sourceReceipt ?? null;
          if ("instagramPostId" in args) {
            return (options.sourceMatches ?? []).map((match) => match.existingEvent);
          }
          if ("instagramPostUrl" in args) {
            return (options.sourceMatches ?? []).map((match) => match.existingEvent);
          }
          if ("date" in args) return [];
          if ("id" in args) {
            return creates.find((event) => event._id === args.id) ?? null;
          }
          return [];
        },
        async mutation(_reference, args) {
          if ("representativeEventId" in args) {
            receiptWrites.push(structuredClone(args));
            return { recorded: true };
          }
          if ("title" in args && "date" in args) {
            const created = {
              _id: `pipeline-event-${creates.length + 1}`,
              ...structuredClone(args),
              updatedAt: now + creates.length + 1,
            };
            creates.push(created);
            return {
              eventId: created._id,
              created: true,
              updatedAt: created.updatedAt,
            };
          }
          otherMutations.push(structuredClone(args));
          return { recorded: true, updatedAt: now + 1 };
        },
        async action(_reference, args) {
          actions.push(structuredClone(args));
          if (options.actionHandler) return options.actionHandler(args);
          if (options.actionError) throw options.actionError;
          return { persisted: true };
        },
      },
    };
  }

  const cachedPosterExtraction = parseExtractedEventData({
    ...structuredClone(extractionFixture),
    date_evidence: {
      ...structuredClone(extractionFixture.date_evidence),
      source: "poster",
    },
    time_evidence: {
      ...structuredClone(extractionFixture.time_evidence),
      source: "poster",
    },
  });
  const cachedPosterClient = makeOfflinePipelineClient({
    actionError: new Error("REMOTE_MEDIA_HTTP_STATUS=403; cached poster expired"),
  });
  const cachedPosterSummary = createEmptyIngestionSummary([
    "cached_poster_boundary",
  ]).handles[0];
  const cachedPosterUrl = "https://scontent.cdninstagram.com/cached-poster.jpg";
  await withoutIngestionConsole(() =>
    processIngestionPostWithExtractionForTesting({
      client: cachedPosterClient.client,
      handle: "cached_poster_boundary",
      post: {
        postId: "CACHEDPOSTER",
        caption: extractionFixture.source_caption,
        altText: null,
        imageUrl: cachedPosterUrl,
        imageUrls: [cachedPosterUrl],
        postType: "image",
        locationName: null,
        instagramPostUrl: "https://www.instagram.com/p/CACHEDPOSTER/",
        postedAt: sourcePostedAt,
        username: "cached_poster_boundary",
      },
      summary: cachedPosterSummary,
      canonicalVenueNamesByHandle: {},
      venueNameOverridesByHandle: {},
      configuredVenueNamesByHandle: {},
      sourceRolesByHandle: { cached_poster_boundary: "unknown" },
      serviceSecret: process.env.CRON_SECRET,
      cachedAnalysisJson: JSON.stringify(cachedPosterExtraction),
      cachedAnalysisContractVersion: "event_evidence_v2",
      cachedAnalysisImageSourceUrl: cachedPosterUrl,
      cachedAnalysisImageChecksumSha256: "c".repeat(64),
      providerExecution: {
        claim: async () => {
          throw new Error("A valid cached poster must not claim a new provider request.");
        },
        block: async () => {},
        release: async () => {},
      },
      extracted: cachedPosterExtraction,
      dependencies: {
        downloadImage: async () => {
          throw new Error("A cached poster must use its persisted analyzed-image binding.");
        },
      },
    }),
  );
  if (cachedPosterClient.creates.length !== 0) {
    const createdFields = JSON.parse(
      cachedPosterClient.creates[0].normalizedFieldsJson ?? "{}",
    );
    unresolvedBoundaryDefects.push(
      `cached poster + CDN failure created ${cachedPosterClient.creates[0].status} event as ${createdFields.extractionMode ?? "unknown"} (pending: ${JSON.stringify(createdFields.moderationPendingReasons ?? [])}, occurrence plan: ${Boolean(cachedPosterClient.creates[0].sourceOccurrencePlan)}) instead of deferring the unavailable poster-bound cache`,
    );
  }
  if (cachedPosterClient.receiptWrites.length !== 0) {
    unresolvedBoundaryDefects.push(
      "cached poster + CDN failure marked a source occurrence satisfied without recoverable poster evidence",
    );
  }
  if (cachedPosterClient.actions.length !== 1) {
    unresolvedBoundaryDefects.push(
      `cached poster + CDN failure attempted ${cachedPosterClient.actions.length} durable poster recoveries instead of exactly one`,
    );
  }


  const rotatedCachedPosterClient = makeOfflinePipelineClient({
    actionHandler: async (args) => {
      if (args.upstreamUrl === cachedPosterUrl) {
        throw new Error("REMOTE_MEDIA_HTTP_STATUS=403; old signed URL expired");
      }
      assert.equal(args.upstreamUrl, rotatedCurrentPosterUrl);
      if (args.expectedChecksumSha256 !== undefined) {
        assert.equal(args.expectedChecksumSha256, "c".repeat(64));
      }
      return { persisted: true };
    },
  });
  const rotatedCachedPosterSummary = createEmptyIngestionSummary([
    "rotated_cached_poster_boundary",
  ]).handles[0];
  const rotatedCurrentPosterUrl =
    "https://scontent.cdninstagram.com/re-signed-cached-poster.jpg";
  await withoutIngestionConsole(() =>
    processIngestionPostWithExtractionForTesting({
      client: rotatedCachedPosterClient.client,
      handle: "rotated_cached_poster_boundary",
      post: {
        postId: "ROTATEDCACHEDPOSTER",
        caption: extractionFixture.source_caption,
        altText: null,
        imageUrl: rotatedCurrentPosterUrl,
        imageUrls: [rotatedCurrentPosterUrl],
        postType: "image",
        locationName: null,
        instagramPostUrl: "https://www.instagram.com/p/ROTATEDCACHEDPOSTER/",
        postedAt: sourcePostedAt,
        username: "rotated_cached_poster_boundary",
      },
      summary: rotatedCachedPosterSummary,
      canonicalVenueNamesByHandle: {},
      venueNameOverridesByHandle: {},
      configuredVenueNamesByHandle: {},
      sourceRolesByHandle: { rotated_cached_poster_boundary: "unknown" },
      serviceSecret: process.env.CRON_SECRET,
      cachedAnalysisJson: JSON.stringify({
        ...cachedPosterExtraction,
        source_url: "https://www.instagram.com/p/ROTATEDCACHEDPOSTER/",
      }),
      cachedAnalysisContractVersion: "event_evidence_v2",
      cachedAnalysisImageSourceUrl: cachedPosterUrl,
      cachedAnalysisImageChecksumSha256: "c".repeat(64),
      providerExecution: {
        claim: async () => {
          throw new Error("A rotated cached poster must not claim a new provider request.");
        },
        block: async () => {},
        release: async () => {},
      },
      extracted: cachedPosterExtraction,
      dependencies: {
        downloadImage: async () => {
          throw new Error("Exact durable poster recovery must not refetch a rotated signed URL.");
        },
      },
    }),
  );
  if (rotatedCachedPosterClient.creates.length !== 1) {
    unresolvedBoundaryDefects.push(
      `rotated cached poster with an exact durable asset created ${rotatedCachedPosterClient.creates.length} events instead of continuing without OpenAI/refetch`,
    );
  }
  if (
    JSON.stringify(rotatedCachedPosterClient.actions.slice(0, 2).map((args) => args.upstreamUrl)) !==
    JSON.stringify([cachedPosterUrl, rotatedCurrentPosterUrl])
  ) {
    unresolvedBoundaryDefects.push(
      `rotated cached poster did not try the old binding then the current exact-checksum candidate: ${JSON.stringify(rotatedCachedPosterClient.actions.map((args) => args.upstreamUrl))}`,
    );
  }
  if (
    rotatedCachedPosterSummary.failedImagePersistence !== 0 ||
    (rotatedCachedPosterSummary.permanentImagePersistenceFailures ?? 0) !== 0
  ) {
    unresolvedBoundaryDefects.push(
      `a successful checksum-bound rotated poster recovery retained failed-candidate counters (${rotatedCachedPosterSummary.failedImagePersistence}/${rotatedCachedPosterSummary.permanentImagePersistenceFailures ?? 0})`,
    );
  }

  const mismatchedRotatedPosterClient = makeOfflinePipelineClient({
    actionHandler: async () => {
      throw new Error("Fetched Instagram image checksum does not match the analyzed poster.");
    },
  });
  const mismatchedRotatedPosterSummary = createEmptyIngestionSummary([
    "mismatched_rotated_poster_boundary",
  ]).handles[0];
  await withoutIngestionConsole(() =>
    processIngestionPostWithExtractionForTesting({
      client: mismatchedRotatedPosterClient.client,
      handle: "mismatched_rotated_poster_boundary",
      post: {
        postId: "MISMATCHEDROTATEDPOSTER",
        caption: extractionFixture.source_caption,
        altText: null,
        imageUrl: rotatedCurrentPosterUrl,
        imageUrls: [rotatedCurrentPosterUrl],
        postType: "image",
        locationName: null,
        instagramPostUrl: "https://www.instagram.com/p/MISMATCHEDROTATEDPOSTER/",
        postedAt: sourcePostedAt,
        username: "mismatched_rotated_poster_boundary",
      },
      summary: mismatchedRotatedPosterSummary,
      canonicalVenueNamesByHandle: {},
      venueNameOverridesByHandle: {},
      configuredVenueNamesByHandle: {},
      sourceRolesByHandle: { mismatched_rotated_poster_boundary: "unknown" },
      serviceSecret: process.env.CRON_SECRET,
      cachedAnalysisJson: JSON.stringify({
        ...cachedPosterExtraction,
        source_url: "https://www.instagram.com/p/MISMATCHEDROTATEDPOSTER/",
      }),
      cachedAnalysisContractVersion: "event_evidence_v2",
      cachedAnalysisImageSourceUrl: cachedPosterUrl,
      cachedAnalysisImageChecksumSha256: "c".repeat(64),
      providerExecution: {
        claim: async () => {
          throw new Error("A mismatched cached poster must not claim a new provider request.");
        },
        block: async () => {},
        release: async () => {},
      },
      extracted: cachedPosterExtraction,
    }),
  );
  if (
    mismatchedRotatedPosterClient.creates.length !== 0 ||
    mismatchedRotatedPosterClient.receiptWrites.length !== 0
  ) {
    unresolvedBoundaryDefects.push(
      "a rotated poster whose current bytes miss the recorded checksum wrote an event/receipt",
    );
  }

  function makeEarlyReturnRecoveryFixture(suffix) {
    const handle = `early_return_${suffix}`;
    const fixturePostId = `EARLYRETURN${suffix.toUpperCase()}`;
    const fixturePost = {
      postId: fixturePostId,
      caption: extractionFixture.source_caption,
      altText: null,
      imageUrl: rotatedCurrentPosterUrl,
      imageUrls: [rotatedCurrentPosterUrl],
      postType: "image",
      locationName: null,
      instagramPostUrl: `https://www.instagram.com/p/${fixturePostId}/`,
      postedAt: sourcePostedAt,
      username: handle,
    };
    const [bound] = bindSourceOccurrenceMetadata(fixturePost, [
      {
        kind: "ok",
        event: {
          ...posterEvent,
          instagramPostId: fixturePostId,
          instagramPostUrl: fixturePost.instagramPostUrl,
          sourceCaption: fixturePost.caption,
          sourcePostedAt: fixturePost.postedAt,
          imageUrl: undefined,
          imageStorageId: undefined,
        },
        normalizedFields: {
          normalizedDate: eventDate,
          time: extractionFixture.time,
        },
      },
    ]);
    assert.equal(bound?.kind, "ok");
    const sourceOccurrenceKey = bound.normalizedFields.sourceOccurrenceKey;
    const sourceFingerprint =
      bound.normalizedFields.sourceOccurrenceSourceFingerprint;
    assert.equal(typeof sourceOccurrenceKey, "string");
    assert.equal(typeof sourceFingerprint, "string");
    const normalizedFieldsJson = JSON.stringify({
      ...bound.normalizedFields,
      normalizedIsValid: true,
      extractionContractVersion: "event_evidence_v2",
      extractionIsEvent: true,
      extractionMode: "poster",
      structuredEvidenceVerified: true,
    });
    return {
      handle,
      post: fixturePost,
      sourceMatch: {
        existingEvent: {
          ...posterEvent,
          _id: `existing-${suffix}`,
          instagramPostId: fixturePostId,
          instagramPostUrl: fixturePost.instagramPostUrl,
          sourceCaption: fixturePost.caption,
          sourcePostedAt: fixturePost.postedAt,
          imageUrl: undefined,
          imageStorageId: undefined,
          sourceOccurrenceKey,
          normalizedFieldsJson,
        },
        matchedBy: "post_id",
        matchedValue: fixturePostId,
      },
      receipt: {
        sourceIdentity: `instagram-source-identity-v1:${fixturePostId}`,
        sourceFingerprint,
        expectedKeys: [sourceOccurrenceKey],
        satisfiedKeys: [sourceOccurrenceKey],
        satisfiedOccurrences: [
          { key: sourceOccurrenceKey, eventId: `existing-${suffix}` },
        ],
        deferredChildCount: 0,
        deferredChildKeys: [],
      },
    };
  }

  async function runEarlyReturnRecovery(
    fixture,
    offlineClient,
    providerMessage,
    { withCachedPoster = true } = {},
  ) {
    let providerClaims = 0;
    const summary = createEmptyIngestionSummary([fixture.handle]).handles[0];
    await withoutIngestionConsole(() =>
      processIngestionPostWithExtractionForTesting({
        client: offlineClient.client,
        handle: fixture.handle,
        post: fixture.post,
        summary,
        canonicalVenueNamesByHandle: {},
        venueNameOverridesByHandle: {},
        configuredVenueNamesByHandle: {},
        sourceRolesByHandle: { [fixture.handle]: "unknown" },
        serviceSecret: process.env.CRON_SECRET,
        ...(withCachedPoster
          ? {
              cachedAnalysisJson: JSON.stringify(cachedPosterExtraction),
              cachedAnalysisContractVersion: "event_evidence_v2",
              cachedAnalysisImageSourceUrl: cachedPosterUrl,
              cachedAnalysisImageChecksumSha256: "c".repeat(64),
            }
          : {}),
        providerExecution: {
          claim: async () => {
            providerClaims += 1;
            throw new Error(providerMessage);
          },
          block: async () => {},
          release: async () => {},
        },
        extracted: cachedPosterExtraction,
        dependencies: {
          downloadImage: async () => {
            throw new Error("An early-return media retry must not download or re-analyze the post.");
          },
        },
      }),
    );
    assert.equal(providerClaims, 0, providerMessage);
    return summary;
  }

  const completeRecoveryFixture = makeEarlyReturnRecoveryFixture("complete");
  assert.equal(
    isExistingEventEligibleForDurableMediaRetry(
      completeRecoveryFixture.sourceMatch.existingEvent,
    ),
    true,
    "the completed-receipt fixture must represent a verified event missing its durable image",
  );
  const completeRecoveryClient = makeOfflinePipelineClient({
    sourceReceipt: completeRecoveryFixture.receipt,
    sourceMatches: [completeRecoveryFixture.sourceMatch],
    actionHandler: async (args) => {
      assert.equal(args.expectedChecksumSha256, "c".repeat(64));
      if (args.upstreamUrl === cachedPosterUrl) {
        throw new Error("REMOTE_MEDIA_HTTP_STATUS=403; completed receipt URL expired");
      }
      assert.equal(args.upstreamUrl, rotatedCurrentPosterUrl);
      return { persisted: true };
    },
  });
  const completeRecoverySummary = await runEarlyReturnRecovery(
    completeRecoveryFixture,
    completeRecoveryClient,
    "A completed occurrence receipt must not claim OpenAI while repairing its exact media.",
  );
  assert.deepEqual(
    completeRecoveryClient.actions.map((args) => args.upstreamUrl),
    [cachedPosterUrl, rotatedCurrentPosterUrl],
    `completed-receipt recovery must try the analyzed URL, then the current signed candidate (${JSON.stringify({ summary: completeRecoverySummary, queries: completeRecoveryClient.queries })})`,
  );
  assert.equal(completeRecoveryClient.creates.length, 0);
  assert.equal(completeRecoveryClient.receiptWrites.length, 0);

  const duplicateRecoveryFixture = makeEarlyReturnRecoveryFixture("duplicate");
  const duplicateRecoveryClient = makeOfflinePipelineClient({
    sourceMatches: [duplicateRecoveryFixture.sourceMatch],
    actionHandler: async (args) => {
      assert.equal(args.expectedChecksumSha256, "c".repeat(64));
      if (args.upstreamUrl === cachedPosterUrl) {
        throw new Error("REMOTE_MEDIA_HTTP_STATUS=403; duplicate source URL expired");
      }
      assert.equal(args.upstreamUrl, rotatedCurrentPosterUrl);
      throw new Error("Fetched Instagram image checksum does not match the analyzed poster.");
    },
  });
  await runEarlyReturnRecovery(
    duplicateRecoveryFixture,
    duplicateRecoveryClient,
    "A source-duplicate media retry must not claim OpenAI or refetch the provider.",
  );
  assert.deepEqual(
    duplicateRecoveryClient.actions.map((args) => args.upstreamUrl),
    [cachedPosterUrl, rotatedCurrentPosterUrl],
    "source-duplicate recovery must checksum-fence the old and current media candidates",
  );
  assert.equal(duplicateRecoveryClient.creates.length, 0);
  assert.equal(duplicateRecoveryClient.receiptWrites.length, 0);
  assert.equal(
    duplicateRecoveryClient.otherMutations.length,
    0,
    "a checksum-mismatched duplicate retry must not attach or write media state",
  );

  const unboundPosterRecoveryClient = makeOfflinePipelineClient({
    sourceMatches: [duplicateRecoveryFixture.sourceMatch],
  });
  const unboundPosterRecoverySummary = await runEarlyReturnRecovery(
    duplicateRecoveryFixture,
    unboundPosterRecoveryClient,
    "An unbound v2 poster retry must not claim OpenAI while failing closed.",
    { withCachedPoster: false },
  );
  assert.equal(unboundPosterRecoveryClient.actions.length, 0);
  assert.equal(unboundPosterRecoverySummary.failedImagePersistence, 1);
  assert.match(
    unboundPosterRecoverySummary.errors.join("\n"),
    /requires the cached analyzed-image checksum/i,
    "a v2 poster retry without an exact cache binding must remain explicitly unrepaired",
  );

  const cachedCaptionExtraction = parseExtractedEventData(
    structuredClone(extractionFixture),
  );
  const cachedCaptionClient = makeOfflinePipelineClient();
  const cachedCaptionSummary = createEmptyIngestionSummary([
    "cached_caption_boundary",
  ]).handles[0];
  const recoveredImageUrl = "https://images.example.test/recovered-caption.jpg";
  await withoutIngestionConsole(() =>
    processIngestionPostWithExtractionForTesting({
      client: cachedCaptionClient.client,
      handle: "cached_caption_boundary",
      post: {
        postId: "CACHEDCAPTION",
        caption: extractionFixture.source_caption,
        altText: null,
        imageUrl: recoveredImageUrl,
        imageUrls: [recoveredImageUrl],
        postType: "image",
        locationName: null,
        instagramPostUrl: "https://www.instagram.com/p/CACHEDCAPTION/",
        postedAt: sourcePostedAt,
        username: "cached_caption_boundary",
      },
      summary: cachedCaptionSummary,
      canonicalVenueNamesByHandle: {},
      venueNameOverridesByHandle: {},
      configuredVenueNamesByHandle: {},
      sourceRolesByHandle: { cached_caption_boundary: "unknown" },
      serviceSecret: process.env.CRON_SECRET,
      cachedAnalysisJson: JSON.stringify(cachedCaptionExtraction),
      cachedAnalysisContractVersion: "event_evidence_v2",
      providerExecution: {
        claim: async () => {
          throw new Error("A valid cached caption analysis must not claim a new provider request.");
        },
        block: async () => {},
        release: async () => {},
      },
      extracted: cachedCaptionExtraction,
      dependencies: {
        downloadImage: async () => {
          throw new Error("Caption-cache recovery must not relabel the analysis as poster-derived.");
        },
        normalizeToJpeg: async (imageBuffer) => ({
          imageBuffer,
          mimeType: "image/jpeg",
        }),
      },
    }),
  );
  if (cachedCaptionClient.creates.length !== 1) {
    unresolvedBoundaryDefects.push(
      `cached caption-only analysis + recovered image created ${cachedCaptionClient.creates.length} events instead of preserving caption provenance and continuing`,
    );
  } else {
    const createdFields = JSON.parse(
      cachedCaptionClient.creates[0].normalizedFieldsJson ?? "{}",
    );
    if (createdFields.extractionMode !== "caption_only") {
      unresolvedBoundaryDefects.push(
        `cached caption-only analysis was relabeled ${createdFields.extractionMode ?? "unknown"} after image recovery`,
      );
    }
  }
  if (cachedCaptionClient.actions.length !== 1) {
    const createdFields = JSON.parse(
      cachedCaptionClient.creates[0]?.normalizedFieldsJson ?? "{}",
    );
    unresolvedBoundaryDefects.push(
      `cached caption-only analysis + recovered image performed ${cachedCaptionClient.actions.length} durable media recoveries instead of one post-analysis attachment (status: ${cachedCaptionClient.creates[0]?.status ?? "missing"}, valid: ${String(createdFields.normalizedIsValid)}, structured: ${String(createdFields.structuredEvidenceVerified)}, date/time/identity/venue: ${[createdFields.dateEvidenceVerified, createdFields.timeEvidenceVerified, createdFields.identityEvidenceVerified, createdFields.venueEvidenceVerified].map(String).join("/")}, pending: ${JSON.stringify(createdFields.moderationPendingReasons ?? [])}, legacy grounding: ${String(createdFields.sourceGroundingVerified)})`,
    );
  }

  const carouselClient = makeOfflinePipelineClient();
  const carouselSummary = createEmptyIngestionSummary([
    "single_bound_poster",
  ]).handles[0];
  const carouselUrls = [
    "https://images.example.test/carousel-first.jpg",
    "https://images.example.test/carousel-second.jpg",
  ];
  const downloadedCarouselUrls = [];
  let providerClaims = 0;
  let providerReleases = 0;
  const freshCarouselExtraction = parseExtractedEventData({
    ...structuredClone(extractionFixture),
    source_caption: extractionFixture.source_caption,
    source_url: "https://www.instagram.com/p/SINGLEBOUNDPOSTER/",
    date_evidence: {
      ...structuredClone(extractionFixture.date_evidence),
      source: "poster",
    },
    time_evidence: {
      ...structuredClone(extractionFixture.time_evidence),
      source: "poster",
    },
  });
  await withoutIngestionConsole(() =>
    processIngestionPostWithExtractionForTesting({
      client: carouselClient.client,
      handle: "single_bound_poster",
      post: {
        postId: "SINGLEBOUNDPOSTER",
        caption: extractionFixture.source_caption,
        altText: null,
        imageUrl: carouselUrls[0],
        imageUrls: carouselUrls,
        postType: "carousel",
        locationName: null,
        instagramPostUrl: "https://www.instagram.com/p/SINGLEBOUNDPOSTER/",
        postedAt: sourcePostedAt,
        username: "single_bound_poster",
      },
      summary: carouselSummary,
      canonicalVenueNamesByHandle: {},
      venueNameOverridesByHandle: {},
      configuredVenueNamesByHandle: {},
      sourceRolesByHandle: { single_bound_poster: "unknown" },
      serviceSecret: process.env.CRON_SECRET,
      providerExecution: {
        claim: async () => {
          providerClaims += 1;
          return { claimed: true, reason: "claimed" };
        },
        block: async () => {},
        release: async () => {
          providerReleases += 1;
        },
      },
      extracted: freshCarouselExtraction,
      dependencies: {
        downloadImage: async (url) => {
          downloadedCarouselUrls.push(url);
          return {
            imageBuffer: Buffer.from(`offline-${url}`),
            contentType: "image/jpeg",
          };
        },
        normalizeToJpeg: async (imageBuffer) => ({
          imageBuffer,
          mimeType: "image/jpeg",
          wasConverted: false,
        }),
      },
    }),
  );
  if (
    JSON.stringify(downloadedCarouselUrls) !== JSON.stringify([carouselUrls[0]])
  ) {
    unresolvedBoundaryDefects.push(
      `fresh carousel analysis decoded ${JSON.stringify(downloadedCarouselUrls)} instead of binding exactly the first successful image`,
    );
  }
  const recordedCarouselAnalysis = carouselClient.otherMutations.find(
    (args) => args.resultJson && args.imageSourceUrl,
  );
  if (
    providerClaims !== 1 ||
    providerReleases !== 1 ||
    recordedCarouselAnalysis?.imageSourceUrl !== carouselUrls[0] ||
    !/^[a-f0-9]{64}$/u.test(recordedCarouselAnalysis?.imageChecksumSha256 ?? "")
  ) {
    unresolvedBoundaryDefects.push(
      "fresh carousel analysis did not persist one provider attempt bound to exactly one source URL/checksum",
    );
  }

  function makeMissingVenueSource({ handle, postId, suffix }) {
    const instagramPostUrl = `https://www.instagram.com/p/${postId}/`;
    const caption = `${extractionFixture.source_caption} ${suffix}`;
    const rawExtractionJson = JSON.stringify({
      ...structuredClone(extractionFixture),
      venue: "",
      source_caption: caption,
      source_url: instagramPostUrl,
    });
    const normalizedFields = {
      ...makeNormalizedFields("caption_only", "caption"),
      normalizedVenue: "",
      sourceGroundingInstagramHandle: handle,
      sourceGroundingInstagramPostId: postId,
      sourceGroundingInstagramPostUrl: instagramPostUrl,
      sourceGroundingSourceCaption: caption,
    };
    const sourceOccurrenceKey = `instagram-occurrence-v2:${suffix.repeat(64).slice(0, 64)}`;
    const sourceIdentity = `instagram-source-identity-v1:${postId.toLowerCase()}`;
    const sourceFingerprint = `instagram-source-v2:${suffix.repeat(64).slice(0, 64)}`;
    const scrapedPostId = `scraped-${postId.toLowerCase()}`;
    const persistedPost = {
      _id: scrapedPostId,
      handle,
      username: handle,
      postId,
      caption,
      instagramPostUrl,
      postedAt: sourcePostedAt,
      imageUrls: [],
      sourceRevision: 1,
      processingStatus: "processing",
      processingLeaseOwner: `owner-${suffix}`,
      processingLeaseExpiresAt: now + 60_000,
      analysisRevision: 1,
      analysisResultJson: rawExtractionJson,
      analysisContractVersion: "event_evidence_v2",
      analysisIsEvent: true,
      analysisModel: "gpt-5-mini-2025-08-07",
    };
    const eventArgs = {
      title: extractionFixture.title,
      date: eventDate,
      time: extractionFixture.time,
      timeSource: "caption",
      timeEvidenceText: "20:00",
      timeConfidence: 0.99,
      timeStatus: "confirmed",
      timeEvidenceKind: "start_time_stated",
      dateEvidenceText: eventDate,
      dateEvidenceSource: "caption",
      dateEvidenceIsRelative: false,
      dateEvidenceResolvedDate: eventDate,
      sourceConflictFields: [],
      venue: "",
      artists: extractionFixture.artists,
      eventType: "music",
      status: "approved",
      instagramPostId: postId,
      instagramPostUrl,
      sourceCaption: caption,
      sourcePostedAt,
      rawExtractionJson,
      normalizedFieldsJson: JSON.stringify(normalizedFields),
    };
    const processingFence = {
      scrapedPostId,
      handle,
      postId,
      instagramPostUrl,
      owner: persistedPost.processingLeaseOwner,
      sourceRevision: 1,
    };
    const sourceOccurrencePlan = {
      sourceIdentity,
      sourceFingerprint,
      expectedKeys: [sourceOccurrenceKey],
      expectedOccurrences: [
        {
          key: sourceOccurrenceKey,
          date: eventDate,
          time: extractionFixture.time,
          venue: "",
          title: extractionFixture.title,
          artists: extractionFixture.artists,
        },
      ],
      deferredChildCount: 0,
      deferredChildKeys: [],
      observedChildKeys: [`instagram-source-child-v1:${suffix}`],
    };
    return {
      eventArgs,
      persistedPost,
      processingFence,
      sourceOccurrenceKey,
      sourceOccurrencePlan,
    };
  }

  const firstMissingVenue = makeMissingVenueSource({
    handle: "unknown_source_a",
    postId: "UNKNOWNVENUEA",
    suffix: "a",
  });
  const secondMissingVenue = makeMissingVenueSource({
    handle: "unknown_source_b",
    postId: "UNKNOWNVENUEB",
    suffix: "b",
  });
  const missingVenueState = {
    posts: [
      firstMissingVenue.persistedPost,
      secondMissingVenue.persistedPost,
      posterPost,
    ],
    mediaAssets: [makePosterAsset()],
    events: [],
    receipts: [],
    sourceLinks: [],
    audits: [],
  };
  const missingVenueCtx = {
    auth: { getUserIdentity: async () => null },
    db: {
      async get(id) {
        return (
          missingVenueState.posts.find((item) => item._id === id) ??
          missingVenueState.events.find((item) => item._id === id) ??
          null
        );
      },
      async patch(id, patch) {
        const record = [
          ...missingVenueState.posts,
          ...missingVenueState.events,
          ...missingVenueState.receipts,
          ...missingVenueState.sourceLinks,
          ...missingVenueState.mediaAssets,
        ].find((item) => item._id === id);
        if (!record) throw new Error(`Unexpected missing-venue patch ${id}`);
        Object.assign(record, structuredClone(patch));
      },
      async insert(table, value) {
        const targets = {
          events: missingVenueState.events,
          instagramSourceOccurrenceReceipts: missingVenueState.receipts,
          instagramEventSources: missingVenueState.sourceLinks,
          eventAuditLog: missingVenueState.audits,
        };
        const target = targets[table];
        if (!target) throw new Error(`Unexpected missing-venue insert ${table}`);
        const id = `${table}-${target.length + 1}`;
        target.push({ _id: id, ...structuredClone(value) });
        return id;
      },
      query(table) {
        if (table === "venues") {
          return { collect: async () => [] };
        }
        return {
          withIndex(_index, configure) {
            const criteria = indexCriteria(configure);
            const matching = () => {
              if (table === "scrapedPosts") return missingVenueState.posts;
              if (table === "events") return missingVenueState.events;
              if (table === "instagramSourceOccurrenceReceipts") {
                return missingVenueState.receipts;
              }
              if (table === "instagramEventSources") {
                return missingVenueState.sourceLinks;
              }
              if (table === "mediaAssets") return missingVenueState.mediaAssets;
              throw new Error(`Unexpected missing-venue table ${table}`);
            };
            const filtered = () =>
              matching().filter((record) =>
                Object.entries(criteria).every(
                  ([field, value]) => record[field] === value,
                ),
              );
            return {
              async take(limit) {
                return filtered().slice(0, limit);
              },
              async unique() {
                const values = filtered();
                if (values.length > 1) throw new Error("Expected unique QA record.");
                return values[0] ?? null;
              },
              async collect() {
                return filtered();
              },
            };
          },
        };
      },
    },
  };

  await assert.rejects(
    createEvent._handler(missingVenueCtx, {
      title: posterEvent.title,
      date: posterEvent.date,
      time: posterEvent.time,
      timeSource: posterEvent.timeSource,
      timeEvidenceText: posterEvent.timeEvidenceText,
      timeConfidence: posterEvent.timeConfidence,
      timeStatus: posterEvent.timeStatus,
      timeEvidenceKind: posterEvent.timeEvidenceKind,
      dateEvidenceText: posterEvent.dateEvidenceText,
      dateEvidenceSource: posterEvent.dateEvidenceSource,
      dateEvidenceIsRelative: posterEvent.dateEvidenceIsRelative,
      dateEvidenceResolvedDate: posterEvent.dateEvidenceResolvedDate,
      sourceConflictFields: [],
      venue: posterEvent.venue,
      artists: posterEvent.artists,
      eventType: posterEvent.eventType,
      status: "approved",
      instagramPostId: posterEvent.instagramPostId,
      instagramPostUrl: posterEvent.instagramPostUrl,
      sourceCaption: posterEvent.sourceCaption,
      sourcePostedAt: posterEvent.sourcePostedAt,
      rawExtractionJson: posterEvent.rawExtractionJson,
      normalizedFieldsJson: posterEvent.normalizedFieldsJson,
      imageStorageId: "unrelated-storage",
      imageUrl: "https://storage.example.test/unrelated.jpg",
      serviceSecret: process.env.CRON_SECRET,
    }),
    /exact source revision/i,
    "The Convex write boundary must reject a poster event displaying an unrelated asset.",
  );

  let missingVenueCreatedEvent = null;
  try {
    const createResult = await createEvent._handler(missingVenueCtx, {
      ...firstMissingVenue.eventArgs,
      sourceOccurrenceKey: firstMissingVenue.sourceOccurrenceKey,
      sourceOccurrencePlan: firstMissingVenue.sourceOccurrencePlan,
      processingFence: firstMissingVenue.processingFence,
      returnCreateDisposition: true,
      serviceSecret: process.env.CRON_SECRET,
    });
    missingVenueCreatedEvent = missingVenueState.events.find(
      (event) => event._id === createResult.eventId,
    );
    if (!missingVenueCreatedEvent) {
      unresolvedBoundaryDefects.push(
        "missing-venue create returned without a persisted event",
      );
    }
    if (
      missingVenueState.receipts.length !== 1 ||
      missingVenueState.receipts[0].satisfiedKeys[0] !==
        firstMissingVenue.sourceOccurrenceKey
    ) {
      unresolvedBoundaryDefects.push(
        "missing-venue create did not atomically persist its occurrence receipt",
      );
    }
  } catch (error) {
    unresolvedBoundaryDefects.push(
      `missing-venue create/receipt rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!missingVenueCreatedEvent) {
    missingVenueCreatedEvent = {
      _id: "seed-missing-venue-event",
      _creationTime: now,
      ...firstMissingVenue.eventArgs,
      sourceOccurrenceKey: firstMissingVenue.sourceOccurrenceKey,
      createdAt: now,
      updatedAt: now,
    };
    missingVenueState.events.push(missingVenueCreatedEvent);
  }
  if (
    !(await isCanonicallyGroundedApprovedEvent(
      missingVenueCtx,
      missingVenueCreatedEvent,
    ))
  ) {
    unresolvedBoundaryDefects.push(
      "an otherwise exact missing-venue v2 event was hidden from the public grounding surface",
    );
  }

  const eventCountBeforeCrossSourceAttempt = missingVenueState.events.length;
  let crossSourceRejectedAsAmbiguous = false;
  try {
    await createEvent._handler(missingVenueCtx, {
      ...secondMissingVenue.eventArgs,
      returnCreateDisposition: true,
      serviceSecret: process.env.CRON_SECRET,
    });
  } catch (error) {
    crossSourceRejectedAsAmbiguous = /ambiguous|already exists|duplicate/i.test(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (
    !crossSourceRejectedAsAmbiguous ||
    missingVenueState.events.length !== eventCountBeforeCrossSourceAttempt
  ) {
    unresolvedBoundaryDefects.push(
      "same-day/title/time/artist events with unknown venues from different sources were not held as ambiguous",
    );
  }

  const occurrencePost = {
    postId: "BOUNDARYOCCURRENCE",
    caption: `Boundary QA Concert with Boundary Artist on ${eventDate} at 20:00.`,
    altText: null,
    imageUrl: null,
    imageUrls: [],
    postType: "image",
    locationName: null,
    instagramPostUrl: "https://www.instagram.com/p/BOUNDARYOCCURRENCE/",
    postedAt: sourcePostedAt,
    username: "boundary_venue",
  };
  const occurrencePrepared = bindSourceOccurrenceMetadata(occurrencePost, [
    {
      kind: "ok",
      event: {
        title: extractionFixture.title,
        date: eventDate,
        time: extractionFixture.time,
        venue: extractionFixture.venue,
        artists: extractionFixture.artists,
        eventType: "music",
        status: "pending",
        normalizedFieldsJson: "{}",
      },
      normalizedFields: {
        normalizedDate: eventDate,
        time: extractionFixture.time,
      },
    },
  ])[0];
  assert.equal(occurrencePrepared.kind, "ok");
  const currentFingerprint =
    occurrencePrepared.normalizedFields.sourceOccurrenceSourceFingerprint;
  const currentOccurrenceKey = occurrencePrepared.event.sourceOccurrenceKey;
  const oldFingerprint = `instagram-source-v1:${"c".repeat(64)}`;
  const oldOccurrenceKey = `instagram-occurrence-v2:${"d".repeat(64)}`;
  assert.match(currentFingerprint, /^instagram-source-v2:/);
  assert.notEqual(currentFingerprint, oldFingerprint);
  assert.notEqual(currentOccurrenceKey, oldOccurrenceKey);

  const processingFence = {
    scrapedPostId: "scraped-post-occurrence",
    handle: occurrencePost.username,
    postId: occurrencePost.postId,
    instagramPostUrl: occurrencePost.instagramPostUrl,
    owner: "qa-occurrence-owner",
    sourceRevision: 1,
  };
  const sourceFenceRecord = {
    _id: processingFence.scrapedPostId,
    ...processingFence,
    processingStatus: "processing",
    processingLeaseOwner: processingFence.owner,
    processingLeaseExpiresAt: now + 60_000,
  };
  const representativeEvent = {
    _id: "event-occurrence",
    title: extractionFixture.title,
    date: eventDate,
    time: extractionFixture.time,
    venue: extractionFixture.venue,
    artists: extractionFixture.artists,
    status: "pending",
    sourceOccurrenceKey: currentOccurrenceKey,
    instagramPostId: occurrencePost.postId,
    instagramPostUrl: occurrencePost.instagramPostUrl,
  };
  let receipt = {
    _id: "receipt-occurrence",
    sourceIdentity: "instagram-source-identity-v1:boundaryoccurrence",
    sourceFingerprint: oldFingerprint,
    expectedKeys: [oldOccurrenceKey],
    expectedOccurrences: [
      {
        key: oldOccurrenceKey,
        title: representativeEvent.title,
        date: representativeEvent.date,
        time: representativeEvent.time,
        venue: representativeEvent.venue,
        artists: representativeEvent.artists,
      },
    ],
    deferredChildCount: 0,
    deferredChildKeys: [],
    satisfiedKeys: [oldOccurrenceKey],
    satisfiedOccurrences: [
      { key: oldOccurrenceKey, eventId: representativeEvent._id },
    ],
  };
  let sourceLink = {
    _id: "source-link-occurrence",
    eventId: representativeEvent._id,
    sourceIdentity: receipt.sourceIdentity,
    sourceFingerprint: oldFingerprint,
    sourceOccurrenceKey: oldOccurrenceKey,
  };
  const occurrenceCtx = {
    auth: { getUserIdentity: async () => null },
    db: {
      async get(id) {
        if (id === sourceFenceRecord._id) return sourceFenceRecord;
        if (id === representativeEvent._id) return representativeEvent;
        return null;
      },
      async patch(id, patch) {
        if (id === receipt._id) {
          receipt = { ...receipt, ...structuredClone(patch) };
          return;
        }
        if (id === sourceLink._id) {
          sourceLink = { ...sourceLink, ...structuredClone(patch) };
          return;
        }
        throw new Error(`Unexpected occurrence patch ${id}`);
      },
      async insert(table) {
        throw new Error(`Unexpected occurrence insert into ${table}`);
      },
      async delete(id) {
        throw new Error(`Unexpected occurrence delete ${id}`);
      },
      query(table) {
        return {
          withIndex(_index, configure) {
            const criteria = indexCriteria(configure);
            return {
              async unique() {
                if (table === "instagramSourceOccurrenceReceipts") {
                  return criteria.sourceIdentity === receipt.sourceIdentity ? receipt : null;
                }
                if (table === "instagramEventSources") {
                  return criteria.sourceIdentity === sourceLink.sourceIdentity &&
                    criteria.sourceOccurrenceKey === sourceLink.sourceOccurrenceKey
                    ? sourceLink
                    : null;
                }
                throw new Error(`Unexpected occurrence table ${table}`);
              },
            };
          },
        };
      },
    },
  };
  await recordInstagramSourceOccurrenceSatisfaction._handler(occurrenceCtx, {
    plan: {
      sourceIdentity: receipt.sourceIdentity,
      sourceFingerprint: currentFingerprint,
      previousSourceFingerprint: oldFingerprint,
      expectedKeys: [currentOccurrenceKey],
      expectedOccurrences: [
        {
          key: currentOccurrenceKey,
          title: representativeEvent.title,
          date: representativeEvent.date,
          time: representativeEvent.time,
          venue: representativeEvent.venue,
          artists: representativeEvent.artists,
        },
      ],
      deferredChildCount: 0,
      deferredChildKeys: [],
      observedChildKeys: ["instagram-source-child-v1:boundary-current"],
    },
    satisfiedKey: currentOccurrenceKey,
    representativeEventId: representativeEvent._id,
    supersededKey: oldOccurrenceKey,
    processingFence,
    serviceSecret: process.env.CRON_SECRET,
  });
  assert.equal(receipt.sourceFingerprint, currentFingerprint);
  assert.deepEqual(receipt.expectedKeys, [currentOccurrenceKey]);
  assert.deepEqual(receipt.satisfiedKeys, [currentOccurrenceKey]);
  assert.deepEqual(receipt.satisfiedOccurrences, [
    { key: currentOccurrenceKey, eventId: representativeEvent._id },
  ]);
  assert.equal(sourceLink.sourceFingerprint, currentFingerprint);
  assert.equal(sourceLink.sourceOccurrenceKey, currentOccurrenceKey);
  assert.deepEqual(
    unresolvedBoundaryDefects,
    [],
    `Event evidence v2 runtime boundary defects:\n${unresolvedBoundaryDefects
      .map((defect) => `- ${defect}`)
      .join("\n")}`,
  );
} finally {
  if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousCronSecret;
}

console.log(
  "Event evidence v2 durability QA passed: cache usage, one-shot upgrade, exact media grounding, cache provenance/recovery, single-image binding, missing venue, time binding, and occurrence protocol migration.",
);
