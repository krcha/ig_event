import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import * as eventFunctions from "../convex/events.ts";
import {
  foldReviewedPromoterScheduleDuplicate,
  getReviewedPromoterScheduleFoldContext,
} from "../convex/reviewedPromoterScheduleFold.ts";
import { isCanonicallyGroundedApprovedEvent } from "../convex/publicEventGrounding.ts";
import { isCrossPostCampaignLineageEvent } from "../lib/events/cross-post-campaign-aggregate-attestation.ts";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../lib/events/source-occurrence-representation.ts";

const {
  deleteApprovedEvent,
  foldReviewedCrossPostScheduleDuplicate,
  foldReviewedStructuredPromotionVariant,
  foldReviewedStructuredSameSourceContinuation,
  getReviewedCrossPostScheduleFoldContext,
  mergeApprovedEvents,
  updateEvent,
} = eventFunctions;

assert.ok(
  foldReviewedCrossPostScheduleDuplicate?._handler,
  "The reviewed cross-post schedule fold mutation must be exported.",
);
assert.ok(
  getReviewedCrossPostScheduleFoldContext?._handler,
  "The reviewed cross-post schedule fold context query must be exported.",
);
assert.ok(
  foldReviewedStructuredPromotionVariant?._handler,
  "The reviewed promotion-variant fold mutation must be exported.",
);
assert.ok(
  foldReviewedStructuredSameSourceContinuation?._handler,
  "The reviewed same-source continuation fold mutation must be exported.",
);

const previousCronSecret = process.env.CRON_SECRET;
const previousAdminIds = process.env.ADMIN_CLERK_USER_IDS;
const originalDateNow = Date.now;
const QA_NOW = new Date("2026-08-28T12:00:00.000Z").getTime();
process.env.CRON_SECRET = "qa-reviewed-fold-secret";
process.env.ADMIN_CLERK_USER_IDS = "qa-reviewed-fold-admin";
Date.now = () => QA_NOW;

const clone = (value) => structuredClone(value);

function indexPredicates(configure) {
  const predicates = [];
  const builder = {
    eq(field, value) {
      predicates.push((row) => row[field] === value);
      return builder;
    },
    gt(field, value) {
      predicates.push((row) => row[field] > value);
      return builder;
    },
    gte(field, value) {
      predicates.push((row) => row[field] >= value);
      return builder;
    },
    lt(field, value) {
      predicates.push((row) => row[field] < value);
      return builder;
    },
    lte(field, value) {
      predicates.push((row) => row[field] <= value);
      return builder;
    },
  };
  configure(builder);
  return predicates;
}

function makeHarness(seed) {
  const tableNames = [
    "events",
    "instagramEventSources",
    "instagramSourceOccurrenceReceipts",
    "sourceOccurrences",
    "instagramSources",
    "scrapedPosts",
    "mediaAssets",
    "venues",
    "savedEvents",
    "userSavedEvents",
    "eventAuditLog",
    "eventRetentionCursors",
    "sourceOccurrenceTopologyEpoch",
  ];
  const tables = Object.fromEntries(
    tableNames.map((table) => [
      table,
      new Map(
        (
          seed[table] ??
          (table === "sourceOccurrenceTopologyEpoch"
            ? [{
                _id: "qa-source-occurrence-topology-epoch",
                key: "source-occurrence-topology-v1",
                currentEpoch: 0,
                verifiedEpoch: 0,
                createdAt: 1,
                updatedAt: 1,
              }]
            : [])
        ).map((row) => [row._id, clone(row)]),
      ),
    ]),
  );
  const operations = [];
  let insertedId = 0;

  function rows(table) {
    return [...(tables[table]?.values() ?? [])];
  }

  function result(table, predicates = []) {
    const matches = () =>
      rows(table)
        .filter((row) => predicates.every((predicate) => predicate(row)))
        .map(clone);
    return {
      order() {
        return this;
      },
      async collect() {
        return matches();
      },
      async first() {
        return matches()[0] ?? null;
      },
      async take(limit) {
        return matches().slice(0, limit);
      },
      async unique() {
        const found = matches();
        if (found.length > 1) {
          throw new Error(`Expected one ${table} row, found ${found.length}.`);
        }
        return found[0] ?? null;
      },
      async paginate(options) {
        const found = matches();
        const page = found.slice(0, options.numItems);
        return {
          page,
          isDone: page.length === found.length,
          continueCursor: page.length === found.length ? "" : "qa-next-cursor",
        };
      },
    };
  }

  const db = {
    normalizeId(table, id) {
      return tables[table]?.has(id) ? id : null;
    },
    async get(id) {
      for (const table of Object.values(tables)) {
        const row = table.get(id);
        if (row) return clone(row);
      }
      return null;
    },
    query(table) {
      return {
        ...result(table),
        withIndex(_index, configure) {
          return result(table, indexPredicates(configure));
        },
      };
    },
    async patch(id, patch) {
      for (const [tableName, table] of Object.entries(tables)) {
        if (!table.has(id)) continue;
        table.set(id, { ...table.get(id), ...clone(patch) });
        operations.push({ kind: "patch", table: tableName, id, patch: clone(patch) });
        return;
      }
      throw new Error(`Cannot patch missing QA row ${id}.`);
    },
    async delete(id) {
      for (const [tableName, table] of Object.entries(tables)) {
        if (!table.delete(id)) continue;
        operations.push({ kind: "delete", table: tableName, id });
        return;
      }
      throw new Error(`Cannot delete missing QA row ${id}.`);
    },
    async insert(table, value) {
      assert.ok(tables[table], `Unexpected QA insert table ${table}.`);
      insertedId += 1;
      const id = `qa-${table}-${insertedId}`;
      tables[table].set(id, {
        _id: id,
        _creationTime: Date.now(),
        ...clone(value),
      });
      operations.push({ kind: "insert", table, id, value: clone(value) });
      return id;
    },
  };

  function snapshot() {
    return {
      tables: Object.fromEntries(
        Object.entries(tables).map(([table, records]) => [
          table,
          [...records.entries()].map(clone),
        ]),
      ),
      operations: clone(operations),
      insertedId,
    };
  }

  function restore(saved) {
    for (const [table, entries] of Object.entries(saved.tables)) {
      tables[table].clear();
      for (const [id, value] of entries) tables[table].set(id, clone(value));
    }
    operations.splice(0, operations.length, ...clone(saved.operations));
    insertedId = saved.insertedId;
  }

  return {
    tables,
    operations,
    db,
    serviceCtx: { auth: { getUserIdentity: async () => null }, db },
    adminCtx: {
      auth: {
        getUserIdentity: async () => ({ subject: "qa-reviewed-fold-admin" }),
      },
      db,
    },
    snapshot,
    restore,
  };
}

async function invokeAtomically(mutation, harness, args) {
  const before = harness.snapshot();
  try {
    return await mutation._handler(harness.serviceCtx, args);
  } catch (error) {
    // Direct handler QA does not receive Convex's transaction rollback, so the
    // harness restores the snapshot on failure to model the production boundary.
    harness.restore(before);
    throw error;
  }
}

function rawExtraction(scheduleEntries = []) {
  return JSON.stringify({
    extraction_contract_version: "event_evidence_v2",
    is_event: true,
    non_event_reason: "",
    schedule_entries: scheduleEntries,
  });
}

function normalizedFields({
  title,
  date,
  time,
  venue,
  artists,
  handle,
  postId,
  postUrl,
  caption,
  occurrenceKey,
  sourceFingerprint,
  expectedKeys,
  splitSourceLine,
}) {
  return JSON.stringify({
    extractionContractVersion: "event_evidence_v2",
    extractionIsEvent: true,
    extractionNonEventReason: "",
    extractionMode: "caption",
    extractionSourceConflicts: [],
    extractionSourceConflictCount: 0,
    sourceConflictFields: [],
    sourceGroundingVersion: 5,
    sourceGroundingEvidence: "persisted_openai_event_evidence_v2",
    sourceGroundingInstagramHandle: handle,
    sourceGroundingInstagramPostId: postId,
    sourceGroundingInstagramPostUrl: postUrl,
    sourceGroundingSourceCaption: caption,
    dateEvidenceVerified: true,
    timeEvidenceVerified: time !== "TBD",
    identityEvidenceVerified: true,
    venueEvidenceVerified: Boolean(venue),
    structuredEvidenceVerified: true,
    dateEvidenceText: date,
    dateEvidenceSource: "caption",
    dateEvidenceIsRelative: false,
    dateEvidenceResolvedDate: date,
    timeEvidenceKind: time === "TBD" ? "unreadable" : "start_time_stated",
    timeSource: time === "TBD" ? "unknown" : "caption",
    timeEvidenceText: time === "TBD" ? "" : time,
    timeConfidence: time === "TBD" ? 0 : 0.99,
    timeStatus: time === "TBD" ? "tbd" : "confirmed",
    title,
    normalizedDate: date,
    time,
    normalizedVenue: venue,
    artists,
    normalizedIsValid: true,
    titleUsedFallback: false,
    dateSuspiciousYear: false,
    moderationAutoApproved: false,
    moderationAutoApproveRule: null,
    moderationPendingReasons: ["requires_human_approval"],
    moderationSignals: ["requires_human_approval"],
    humanReviewedStructuredSourcePolicyVersion: 1,
    sourceOccurrenceKey: occurrenceKey,
    sourceOccurrenceSourceFingerprint: sourceFingerprint,
    sourceOccurrenceExpectedCount: expectedKeys.length,
    sourceOccurrenceExpectedKeys: expectedKeys,
    sourceOccurrenceDeferredChildCount: 0,
    ...(splitSourceLine
      ? { splitSourceLine, rowSourceText: splitSourceLine }
      : {}),
  });
}

function eventRow({
  id,
  title,
  date,
  time,
  venue,
  venueId,
  venueHandle,
  artists,
  description,
  handle,
  postId,
  caption,
  postedAt,
  occurrenceKey,
  sourceFingerprint,
  expectedKeys,
  raw,
  updatedAt,
  splitSourceLine,
}) {
  const postUrl = `https://www.instagram.com/p/${postId}/`;
  return {
    _id: id,
    _creationTime: updatedAt - 100,
    title,
    date,
    time,
    timeSource: time === "TBD" ? "unknown" : "caption",
    timeEvidenceText: time === "TBD" ? undefined : time,
    timeConfidence: time === "TBD" ? 0 : 0.99,
    timeStatus: time === "TBD" ? "tbd" : "confirmed",
    timeEvidenceKind: time === "TBD" ? "unreadable" : "start_time_stated",
    dateEvidenceText: date,
    dateEvidenceSource: "caption",
    dateEvidenceIsRelative: false,
    dateEvidenceResolvedDate: date,
    sourceConflictFields: [],
    venue,
    ...(venueId ? { venueId } : {}),
    ...(venueHandle ? { venueInstagramHandle: venueHandle } : {}),
    artists,
    description,
    eventType: "nightlife",
    status: "approved",
    instagramPostId: postId,
    instagramPostUrl: postUrl,
    sourceCaption: caption,
    sourcePostedAt: postedAt,
    rawExtractionJson: raw,
    normalizedFieldsJson: normalizedFields({
      title,
      date,
      time,
      venue,
      artists,
      handle,
      postId,
      postUrl,
      caption,
      occurrenceKey,
      sourceFingerprint,
      expectedKeys,
      splitSourceLine,
    }),
    sourceOccurrenceKey: occurrenceKey,
    humanReviewedStructuredSourcePolicyVersion: 1,
    reviewedAt: updatedAt - 20,
    reviewedBy: "QA reviewer",
    moderationNote: "Human reviewed the exact persisted structured Instagram evidence.",
    createdAt: updatedAt - 100,
    updatedAt,
  };
}

function sourceLink({ id, event, sourceIdentity, sourceFingerprint, handle, updatedAt }) {
  return {
    _id: id,
    _creationTime: updatedAt - 100,
    eventId: event._id,
    sourceIdentity,
    sourceFingerprint,
    sourceOccurrenceKey: event.sourceOccurrenceKey,
    instagramPostId: event.instagramPostId,
    instagramPostUrl: event.instagramPostUrl,
    sourceHandle: handle,
    linkedAt: updatedAt - 50,
    updatedAt,
  };
}

function expectedOccurrence(event) {
  return {
    key: event.sourceOccurrenceKey,
    date: event.date,
    time: event.time,
    venue: event.venue,
    title: event.title,
    artists: clone(event.artists),
  };
}

function receiptRow({ id, sourceIdentity, sourceFingerprint, events, updatedAt }) {
  return {
    _id: id,
    _creationTime: updatedAt - 100,
    sourceIdentity,
    sourceFingerprint,
    expectedKeys: events.map((event) => event.sourceOccurrenceKey),
    expectedOccurrences: events.map(expectedOccurrence),
    satisfiedKeys: events.map((event) => event.sourceOccurrenceKey),
    satisfiedOccurrences: events.map((event) => ({
      key: event.sourceOccurrenceKey,
      eventId: event._id,
    })),
    deferredChildCount: 0,
    deferredChildKeys: [],
    createdAt: updatedAt - 100,
    updatedAt,
  };
}

function persistedPost({ id, handle, postId, caption, postedAt, raw, sourceRevision = 1 }) {
  return {
    _id: id,
    _creationTime: 1,
    handle,
    username: handle,
    postId,
    instagramPostUrl: `https://www.instagram.com/p/${postId}/`,
    caption,
    postedAt,
    imageUrls: [],
    sourceRevision,
    analysisRevision: sourceRevision,
    analysisResultJson: raw,
    analysisContractVersion: "event_evidence_v2",
    analysisIsEvent: true,
    analysisModel: "gpt-5-mini-2025-08-07",
    createdAt: 1,
    updatedAt: 1,
  };
}

function getOnlyAudit(harness, eventId, action) {
  const audits = [...harness.tables.eventAuditLog.values()].filter(
    (row) => row.eventId === eventId && row.action === action,
  );
  assert.equal(audits.length, 1, `Expected one ${action} audit for ${eventId}.`);
  return audits[0];
}

function assertReceiptComplete(harness, receiptId) {
  const receipt = harness.tables.instagramSourceOccurrenceReceipts.get(receiptId);
  assert.ok(receipt);
  assert.deepEqual(receipt.expectedKeys, receipt.expectedOccurrences.map(({ key }) => key));
  assert.deepEqual(receipt.satisfiedKeys, receipt.satisfiedOccurrences.map(({ key }) => key));
  assert.equal(new Set(receipt.expectedKeys).size, receipt.expectedKeys.length);
  assert.equal(new Set(receipt.satisfiedKeys).size, receipt.satisfiedKeys.length);
  assert.equal(receipt.deferredChildCount, 0);
  assert.deepEqual(receipt.deferredChildKeys, []);
  for (const satisfaction of receipt.satisfiedOccurrences) {
    const expected = receipt.expectedOccurrences.find(
      (occurrence) => occurrence.key === satisfaction.key,
    );
    assert.ok(expected, `Missing expected occurrence ${satisfaction.key}.`);
    assert.equal(
      sourceOccurrenceRepresentativeMatchesExpected(
        harness.tables.events.get(satisfaction.eventId) ?? null,
        expected,
      ),
      true,
      `Receipt ${receiptId} has a stale representative for ${satisfaction.key}.`,
    );
  }
  return receipt;
}

function skiFixture() {
  const handle = "infuse.rs";
  const date = "2026-09-05";
  const postedAt = "2026-08-25T10:00:00.000Z";
  const primaryFingerprint = `instagram-source-v2:${"a".repeat(64)}`;
  const variantFingerprint = `instagram-source-v2:${"b".repeat(64)}`;
  const primaryKey = `instagram-occurrence-v2:${"a".repeat(64)}`;
  const variantKey = `instagram-occurrence-v2:${"b".repeat(64)}`;
  const primaryRaw = rawExtraction();
  const variantRaw = rawExtraction();
  const primary = eventRow({
    id: "j5794-ski-primary",
    title: "INFUSE",
    date,
    time: "TBD",
    venue: "Ski Stazi",
    artists: [],
    description: "INFUSE gathering at Ski Stazi.",
    handle,
    postId: "SKIPRIMARY",
    caption: "INFUSE na Ski Stazi, 5. septembra. Vidimo se od 19H do 01H.",
    postedAt,
    occurrenceKey: primaryKey,
    sourceFingerprint: primaryFingerprint,
    expectedKeys: [primaryKey],
    raw: primaryRaw,
    updatedAt: 1_000,
  });
  const variant = eventRow({
    id: "j5779-ski-variant",
    title: "INFUSE teaser",
    date,
    time: "TBD",
    venue: "Ski Staza",
    artists: [],
    description: "INFUSE teaser for Ski Staza.",
    handle,
    postId: "SKIVARIANT",
    caption: "INFUSE / Ski Staza / subota 5. septembar.",
    postedAt,
    occurrenceKey: variantKey,
    sourceFingerprint: variantFingerprint,
    expectedKeys: [variantKey],
    raw: variantRaw,
    updatedAt: 1_100,
  });
  const primaryLink = sourceLink({
    id: "ski-primary-link",
    event: primary,
    sourceIdentity: "instagram-source-identity-v1:ski-primary",
    sourceFingerprint: primaryFingerprint,
    handle,
    updatedAt: 1_200,
  });
  const variantLink = sourceLink({
    id: "ski-variant-link",
    event: variant,
    sourceIdentity: "instagram-source-identity-v1:ski-variant",
    sourceFingerprint: variantFingerprint,
    handle,
    updatedAt: 1_300,
  });
  const primaryReceipt = receiptRow({
    id: "ski-primary-receipt",
    sourceIdentity: primaryLink.sourceIdentity,
    sourceFingerprint: primaryFingerprint,
    events: [primary],
    updatedAt: 1_400,
  });
  const variantReceipt = receiptRow({
    id: "ski-variant-receipt",
    sourceIdentity: variantLink.sourceIdentity,
    sourceFingerprint: variantFingerprint,
    events: [variant],
    updatedAt: 1_500,
  });
  const harness = makeHarness({
    events: [primary, variant],
    instagramEventSources: [primaryLink, variantLink],
    instagramSourceOccurrenceReceipts: [primaryReceipt, variantReceipt],
    scrapedPosts: [
      persistedPost({
        id: "ski-primary-post",
        handle,
        postId: primary.instagramPostId,
        caption: primary.sourceCaption,
        postedAt,
        raw: primaryRaw,
      }),
      persistedPost({
        id: "ski-variant-post",
        handle,
        postId: variant.instagramPostId,
        caption: variant.sourceCaption,
        postedAt,
        raw: variantRaw,
      }),
    ],
    savedEvents: [
      { _id: "ski-save-existing", userId: "same-user", eventId: primary._id, createdAt: 1 },
      { _id: "ski-save-dedupe", userId: "same-user", eventId: variant._id, createdAt: 2 },
      { _id: "ski-save-move", userId: "move-user", eventId: variant._id, createdAt: 3 },
    ],
    userSavedEvents: [
      { _id: "ski-legacy-existing", userId: "legacy-same", eventId: primary._id, savedAt: 1 },
      { _id: "ski-legacy-dedupe", userId: "legacy-same", eventId: variant._id, savedAt: 2 },
      { _id: "ski-legacy-move", userId: "legacy-move", eventId: variant._id, savedAt: 3 },
    ],
  });
  return {
    harness,
    primary,
    variant,
    primaryLink,
    variantLink,
    primaryReceipt,
    variantReceipt,
  };
}

function skiArgs(fixture) {
  return {
    operationId: "reviewed-fold:ski-staza-infuse-2026-09-05",
    primaryId: fixture.primary._id,
    expectedPrimaryUpdatedAt: fixture.primary.updatedAt,
    expectedPrimaryNormalizedFieldsJson: fixture.primary.normalizedFieldsJson,
    expectedPrimarySourceLinkId: fixture.primaryLink._id,
    expectedPrimarySourceLinkUpdatedAt: fixture.primaryLink.updatedAt,
    expectedPrimaryReceiptId: fixture.primaryReceipt._id,
    expectedPrimaryReceiptUpdatedAt: fixture.primaryReceipt.updatedAt,
    variantId: fixture.variant._id,
    expectedVariantUpdatedAt: fixture.variant.updatedAt,
    expectedVariantNormalizedFieldsJson: fixture.variant.normalizedFieldsJson,
    expectedVariantSourceLinkId: fixture.variantLink._id,
    expectedVariantSourceLinkUpdatedAt: fixture.variantLink.updatedAt,
    expectedVariantReceiptId: fixture.variantReceipt._id,
    expectedVariantReceiptUpdatedAt: fixture.variantReceipt.updatedAt,
    expectedSourceHandle: "infuse.rs",
    campaignAnchors: ["INFUSE"],
    primaryDuplicateEvidence: ["INFUSE", "5. septembra", "Ski Stazi"],
    variantDuplicateEvidence: ["INFUSE", "5. septembar", "Ski Staza"],
    nextTitle: "INFUSE",
    nextTime: "19:00-01:00",
    nextVenue: "Ski Staza",
    nextArtists: ["Eelke Kleijn", "Gorber", "Despic"],
    nextDescription:
      "INFUSE at Ski Staza with Eelke Kleijn, Gorber and Despic, from 19:00 to 01:00.",
    posterVenueEvidence: "SKI STAZA",
    posterTimeEvidence: "19H - 01H",
    posterArtistEvidence: ["EELKE KLEIJN", "GORBER", "DESPIC"],
    moderationNote:
      "Reviewed both INFUSE posts as one Ski Staza event and preserved both source receipts.",
    serviceSecret: process.env.CRON_SECRET,
  };
}

async function qaSkiFold() {
  const fixture = skiFixture();
  const { harness, primary, variant, primaryReceipt, variantReceipt } = fixture;
  assert.equal(await isCanonicallyGroundedApprovedEvent(harness.serviceCtx, primary), true);
  assert.equal(await isCanonicallyGroundedApprovedEvent(harness.serviceCtx, variant), true);

  const immutablePrimary = clone(primary);
  const immutableVariant = clone(variant);
  const immutableLinks = clone([...harness.tables.instagramEventSources.values()]);
  const result = await invokeAtomically(
    foldReviewedStructuredPromotionVariant,
    harness,
    skiArgs(fixture),
  );
  assert.equal(result.primaryId, primary._id);
  assert.equal(result.variantId, variant._id);
  assert.equal(result.movedSaveCount, 2);
  assert.equal(result.dedupedSaveCount, 2);

  const finalPrimary = harness.tables.events.get(primary._id);
  const finalVariant = harness.tables.events.get(variant._id);
  assert.equal(finalPrimary.status, "approved");
  assert.equal(finalPrimary.title, "INFUSE");
  assert.equal(finalPrimary.time, "19:00-01:00");
  assert.equal(finalPrimary.venue, "Ski Staza");
  assert.equal(finalPrimary.venueId, undefined);
  assert.deepEqual(finalPrimary.artists, ["Eelke Kleijn", "Gorber", "Despic"]);
  assert.equal(finalVariant.status, "rejected");
  assert.match(finalVariant.moderationNote, /^\[reviewed_promotion_variant:v1\]/u);
  assert.equal(isCrossPostCampaignLineageEvent(finalPrimary), true);
  assert.equal(isCrossPostCampaignLineageEvent(finalVariant), true);
  assert.equal(await isCanonicallyGroundedApprovedEvent(harness.serviceCtx, finalPrimary), true);

  for (const field of [
    "instagramPostId",
    "instagramPostUrl",
    "sourceCaption",
    "sourcePostedAt",
    "rawExtractionJson",
    "sourceOccurrenceKey",
  ]) {
    assert.equal(finalPrimary[field], immutablePrimary[field], `Primary ${field} changed.`);
    assert.equal(finalVariant[field], immutableVariant[field], `Variant ${field} changed.`);
  }
  assert.deepEqual(
    [...harness.tables.instagramEventSources.values()],
    immutableLinks,
    "Reviewed folding must not rewrite or delete source links.",
  );

  const finalPrimaryReceipt = assertReceiptComplete(harness, primaryReceipt._id);
  const finalVariantReceipt = assertReceiptComplete(harness, variantReceipt._id);
  assert.deepEqual(finalPrimaryReceipt.expectedKeys, primaryReceipt.expectedKeys);
  assert.deepEqual(finalVariantReceipt.expectedKeys, variantReceipt.expectedKeys);
  assert.equal(finalPrimaryReceipt.satisfiedOccurrences[0].eventId, primary._id);
  assert.equal(finalVariantReceipt.satisfiedOccurrences[0].eventId, primary._id);

  const primaryAudit = getOnlyAudit(
    harness,
    primary._id,
    "reviewed_promotion_variant_folded",
  );
  const variantAudit = getOnlyAudit(
    harness,
    variant._id,
    "reviewed_promotion_variant_rejected",
  );
  assert.equal(JSON.parse(primaryAudit.patchJson).operationId, result.operationId);
  assert.equal(JSON.parse(variantAudit.patchJson).operationId, result.operationId);

  assert.equal(
    [...harness.tables.savedEvents.values()].some((save) => save.eventId === variant._id),
    false,
  );
  assert.equal(
    [...harness.tables.userSavedEvents.values()].some((save) => save.eventId === variant._id),
    false,
  );

  await assert.rejects(
    invokeAtomically(
      foldReviewedStructuredPromotionVariant,
      harness,
      skiArgs(fixture),
    ),
    /precondition|approved|lineage|already/iu,
    "A stale replay must fail closed.",
  );

  await assert.rejects(
    updateEvent._handler(harness.adminCtx, {
      id: primary._id,
      expectedStatus: "approved",
      expectedUpdatedAt: finalPrimary.updatedAt,
      patch: { title: "Tampered INFUSE" },
    }),
    /lineage|re-attestation/iu,
    "Generic updates must not alter a reviewed-fold primary.",
  );
  await assert.rejects(
    deleteApprovedEvent._handler(harness.adminCtx, {
      id: primary._id,
      expectedUpdatedAt: finalPrimary.updatedAt,
    }),
    /lineage|retained|hard-deleted/iu,
    "Generic deletion must retain a reviewed-fold primary.",
  );
  await assert.rejects(
    mergeApprovedEvents._handler(harness.adminCtx, {
      primaryId: primary._id,
      duplicateIds: [],
      expectedPrimaryUpdatedAt: finalPrimary.updatedAt,
      expectedDuplicateVersions: [],
      patch: {},
    }),
    /dedicated|campaign|lineage/iu,
    "Generic merging must not absorb a reviewed-fold primary.",
  );
}

function mutateSkiFixture(mutator) {
  const fixture = skiFixture();
  mutator(fixture);
  return fixture;
}

async function qaSkiAdversarialCases() {
  const cases = [
    {
      label: "stale primary revision",
      mutate: (fixture) => {
        fixture.harness.tables.events.get(fixture.primary._id).updatedAt += 1;
      },
      error: /precondition|version|changed/iu,
    },
    {
      label: "stale variant normalized evidence",
      mutate: (fixture) => {
        const variant = fixture.harness.tables.events.get(fixture.variant._id);
        variant.normalizedFieldsJson = JSON.stringify({
          ...JSON.parse(variant.normalizedFieldsJson),
          title: "Changed after review",
        });
      },
      error: /precondition|changed/iu,
    },
    {
      label: "swapped source-link identity",
      mutate: (fixture) => {
        fixture.harness.tables.instagramEventSources.get(
          fixture.primaryLink._id,
        ).sourceIdentity = fixture.variantLink.sourceIdentity;
      },
      error: /source link|receipt|inconsistent/iu,
    },
    {
      label: "stale receipt revision",
      mutate: (fixture) => {
        fixture.harness.tables.instagramSourceOccurrenceReceipts.get(
          fixture.variantReceipt._id,
        ).updatedAt += 1;
      },
      error: /receipt changed|receipt.*missing/iu,
    },
    {
      label: "deferred teaser child",
      mutate: (fixture) => {
        const receipt = fixture.harness.tables.instagramSourceOccurrenceReceipts.get(
          fixture.variantReceipt._id,
        );
        receipt.deferredChildCount = 1;
        receipt.deferredChildKeys = ["instagram-source-child-v1:unresolved"];
      },
      error: /source|campaign|receipt|proof/iu,
    },
    {
      label: "stale occurrence representative",
      mutate: (fixture) => {
        fixture.harness.tables.instagramSourceOccurrenceReceipts.get(
          fixture.primaryReceipt._id,
        ).expectedOccurrences[0].title = "Different occurrence";
      },
      error: /stale occurrence|receipt/iu,
    },
    {
      label: "mutated persisted caption",
      mutate: (fixture) => {
        fixture.harness.tables.scrapedPosts.get("ski-primary-post").caption += " edited";
      },
      error: /grounded|source/iu,
    },
    {
      label: "pre-existing reviewed lineage",
      mutate: (fixture) => {
        const primary = fixture.harness.tables.events.get(fixture.primary._id);
        primary.normalizedFieldsJson = JSON.stringify({
          ...JSON.parse(primary.normalizedFieldsJson),
          reviewedPromotionVariantFold: { operationId: "older-reviewed-operation" },
        });
        fixture.primary.normalizedFieldsJson = primary.normalizedFieldsJson;
      },
      error: /precondition|lineage/iu,
    },
    {
      label: "known venue without exact target",
      mutate: (fixture) => {
        fixture.harness.tables.venues.set("venue-ski-staza", {
          _id: "venue-ski-staza",
          _creationTime: 1,
          name: "Ski Staza",
          instagramHandle: "skistaza",
          normalizedInstagramHandle: "skistaza",
          category: "nightlife",
          publicStatus: "published",
          scrapeActive: true,
          createdAt: 1,
          updatedAt: 1,
        });
      },
      error: /known|target|canonical/iu,
    },
  ];

  for (const testCase of cases) {
    const fixture = mutateSkiFixture(testCase.mutate);
    const before = fixture.harness.snapshot();
    await assert.rejects(
      invokeAtomically(
        foldReviewedStructuredPromotionVariant,
        fixture.harness,
        skiArgs(fixture),
      ),
      testCase.error,
      testCase.label,
    );
    assert.deepEqual(
      fixture.harness.snapshot(),
      before,
      `${testCase.label} must be atomic.`,
    );
  }

  const excessiveSaves = skiFixture();
  for (let index = 0; index < 101; index += 1) {
    excessiveSaves.harness.tables.savedEvents.set(`overflow-save-${index}`, {
      _id: `overflow-save-${index}`,
      userId: `overflow-user-${index}`,
      eventId: excessiveSaves.variant._id,
      createdAt: index,
    });
  }
  const overflowBefore = excessiveSaves.harness.snapshot();
  await assert.rejects(
    invokeAtomically(
      foldReviewedStructuredPromotionVariant,
      excessiveSaves.harness,
      skiArgs(excessiveSaves),
    ),
    /save cohort|safe bound/iu,
  );
  assert.deepEqual(excessiveSaves.harness.snapshot(), overflowBefore);
}

const BEN_DATE_FRIDAY = "2026-09-04";
const BEN_DATE_SATURDAY = "2026-09-05";
const BEN_FRIDAY_SOURCE_TEXT = "PETAK 04.09 / BEN AKIBA / 22H-04H";
const BEN_DISCO_SOURCE_TEXT = "SUBOTA 05.09 / DISCO / 20H / DJ MUNJA / DJ FILE";
const BEN_MALINA_SOURCE_TEXT = "SUBOTA 05.09 / DISCO / AFTER MIDNIGHT MALINA";

function benFixture() {
  const handle = "benakiba";
  const postId = "BENWEEKEND";
  const postedAt = "2026-08-25T12:00:00.000Z";
  const caption = [
    "BEN AKIBA WEEKEND",
    BEN_FRIDAY_SOURCE_TEXT,
    BEN_DISCO_SOURCE_TEXT,
    BEN_MALINA_SOURCE_TEXT,
  ].join("\n");
  const sourceIdentity = "instagram-source-identity-v1:ben-weekend";
  const sourceFingerprint = `instagram-source-v2:${"c".repeat(64)}`;
  const keys = {
    friday: `instagram-occurrence-v2:${"d".repeat(64)}`,
    disco: `instagram-occurrence-v2:${"e".repeat(64)}`,
    malina: `instagram-occurrence-v2:${"f".repeat(64)}`,
  };
  const raw = rawExtraction([
    {
      title: "Friday at Ben Akiba",
      date: BEN_DATE_FRIDAY,
      time: "22:00-04:00",
      venue: "Ben Akiba",
      artists: [],
      source_text: BEN_FRIDAY_SOURCE_TEXT,
    },
    {
      title: "DISCO",
      date: BEN_DATE_SATURDAY,
      time: "20:00",
      venue: "Ben Akiba",
      artists: ["DJ Munja", "DJ File"],
      source_text: BEN_DISCO_SOURCE_TEXT,
    },
    {
      title: "Malina",
      date: BEN_DATE_SATURDAY,
      time: "",
      venue: "Ben Akiba",
      artists: ["Malina"],
      source_text: BEN_MALINA_SOURCE_TEXT,
    },
  ]);
  const venue = {
    _id: "venue-ben-akiba",
    _creationTime: 1,
    name: "Ben Akiba",
    instagramHandle: handle,
    normalizedInstagramHandle: handle,
    category: "nightlife",
    location: "Braće Krsmanović 6, Beograd",
    publicStatus: "published",
    scrapeActive: true,
    createdAt: 1,
    updatedAt: 2_000,
  };
  const common = {
    venue: venue.name,
    venueId: venue._id,
    venueHandle: venue.instagramHandle,
    handle,
    postId,
    caption,
    postedAt,
    sourceFingerprint,
    expectedKeys: Object.values(keys),
    raw,
  };
  const independent = eventRow({
    ...common,
    id: "j570-ben-friday",
    title: "Friday at Ben Akiba",
    date: BEN_DATE_FRIDAY,
    time: "TBD",
    artists: [],
    description: "Friday program at Ben Akiba.",
    occurrenceKey: keys.friday,
    updatedAt: 2_100,
    splitSourceLine: BEN_FRIDAY_SOURCE_TEXT,
  });
  const primary = eventRow({
    ...common,
    id: "j579-ben-disco",
    title: "DISCO",
    date: BEN_DATE_SATURDAY,
    time: "20:00",
    artists: ["DJ Munja", "DJ File"],
    description: "Saturday DISCO at Ben Akiba.",
    occurrenceKey: keys.disco,
    updatedAt: 2_200,
    splitSourceLine: BEN_DISCO_SOURCE_TEXT,
  });
  const continuation = eventRow({
    ...common,
    id: "j570-ben-malina",
    title: "Malina",
    date: BEN_DATE_SATURDAY,
    time: "TBD",
    artists: ["Malina"],
    description: "Malina joins the Saturday program.",
    occurrenceKey: keys.malina,
    updatedAt: 2_300,
    splitSourceLine: BEN_MALINA_SOURCE_TEXT,
  });
  const links = [independent, primary, continuation].map((event, index) =>
    sourceLink({
      id: `ben-link-${index}`,
      event,
      sourceIdentity,
      sourceFingerprint,
      handle,
      updatedAt: 2_400 + index,
    }),
  );
  const receipt = receiptRow({
    id: "ben-receipt",
    sourceIdentity,
    sourceFingerprint,
    events: [independent, primary, continuation],
    updatedAt: 2_500,
  });
  const harness = makeHarness({
    events: [independent, primary, continuation],
    instagramEventSources: links,
    instagramSourceOccurrenceReceipts: [receipt],
    scrapedPosts: [
      persistedPost({
        id: "ben-post",
        handle,
        postId,
        caption,
        postedAt,
        raw,
      }),
    ],
    venues: [venue],
    savedEvents: [
      { _id: "ben-save-existing", userId: "same-user", eventId: primary._id, createdAt: 1 },
      { _id: "ben-save-dedupe", userId: "same-user", eventId: continuation._id, createdAt: 2 },
      { _id: "ben-save-move", userId: "move-user", eventId: continuation._id, createdAt: 3 },
    ],
    userSavedEvents: [],
  });
  return {
    harness,
    venue,
    independent,
    primary,
    continuation,
    independentLink: links[0],
    primaryLink: links[1],
    continuationLink: links[2],
    receipt,
    sourceIdentity,
    sourceFingerprint,
    keys,
  };
}

function benArgs(fixture) {
  return {
    operationId: "reviewed-fold:ben-akiba-saturday-2026-09-05",
    primaryId: fixture.primary._id,
    expectedPrimaryUpdatedAt: fixture.primary.updatedAt,
    expectedPrimaryNormalizedFieldsJson: fixture.primary.normalizedFieldsJson,
    expectedPrimarySourceLinkId: fixture.primaryLink._id,
    expectedPrimarySourceLinkUpdatedAt: fixture.primaryLink.updatedAt,
    continuationId: fixture.continuation._id,
    expectedContinuationUpdatedAt: fixture.continuation.updatedAt,
    expectedContinuationNormalizedFieldsJson: fixture.continuation.normalizedFieldsJson,
    expectedContinuationSourceLinkId: fixture.continuationLink._id,
    expectedContinuationSourceLinkUpdatedAt: fixture.continuationLink.updatedAt,
    independentId: fixture.independent._id,
    expectedIndependentUpdatedAt: fixture.independent.updatedAt,
    expectedIndependentNormalizedFieldsJson: fixture.independent.normalizedFieldsJson,
    expectedIndependentSourceLinkId: fixture.independentLink._id,
    expectedIndependentSourceLinkUpdatedAt: fixture.independentLink.updatedAt,
    expectedReceiptId: fixture.receipt._id,
    expectedReceiptUpdatedAt: fixture.receipt.updatedAt,
    expectedSourceHandle: "benakiba",
    expectedSourceIdentity: fixture.sourceIdentity,
    expectedSourceFingerprint: fixture.sourceFingerprint,
    primaryScheduleSourceText: BEN_DISCO_SOURCE_TEXT,
    continuationScheduleSourceText: BEN_MALINA_SOURCE_TEXT,
    nextIndependentTime: "22:00-04:00",
    independentPosterVenueEvidence: "BEN AKIBA",
    independentPosterTimeEvidence: "22H-04H",
    independentPosterArtistEvidence: ["FRIDAY PROGRAM"],
    nextVenue: fixture.venue.name,
    targetVenueId: fixture.venue._id,
    expectedTargetVenueUpdatedAt: fixture.venue.updatedAt,
    expectedTargetVenueHandle: fixture.venue.instagramHandle,
    nextArtists: ["DJ Munja", "DJ File", "Malina"],
    nextDescription: `${fixture.primary.description} ${fixture.continuation.description}`,
    moderationNote:
      "Reviewed the Saturday DISCO and Malina schedule rows as one event while preserving Friday.",
    serviceSecret: process.env.CRON_SECRET,
  };
}

async function qaBenFold() {
  const fixture = benFixture();
  const { harness, independent, primary, continuation, receipt, keys } = fixture;
  for (const event of [independent, primary, continuation]) {
    assert.equal(await isCanonicallyGroundedApprovedEvent(harness.serviceCtx, event), true);
  }
  const independentBefore = clone(independent);
  const continuationBefore = clone(continuation);
  const linksBefore = clone([...harness.tables.instagramEventSources.values()]);
  const result = await invokeAtomically(
    foldReviewedStructuredSameSourceContinuation,
    harness,
    benArgs(fixture),
  );
  assert.equal(result.primaryId, primary._id);
  assert.equal(result.continuationId, continuation._id);

  const finalIndependent = harness.tables.events.get(independent._id);
  const finalPrimary = harness.tables.events.get(primary._id);
  const finalContinuation = harness.tables.events.get(continuation._id);
  assert.equal(finalIndependent.title, independentBefore.title);
  assert.equal(finalIndependent.date, independentBefore.date);
  assert.deepEqual(finalIndependent.artists, independentBefore.artists);
  assert.equal(finalIndependent.description, independentBefore.description);
  assert.equal(finalIndependent.time, "22:00-04:00");
  assert.equal(finalIndependent.timeSource, "poster");
  assert.equal(finalIndependent.venue, "Ben Akiba");
  assert.equal(finalIndependent.venueId, fixture.venue._id);
  assert.equal(isCrossPostCampaignLineageEvent(finalIndependent), true);
  assert.equal(
    await isCanonicallyGroundedApprovedEvent(harness.serviceCtx, finalIndependent),
    true,
  );
  assert.equal(finalPrimary.status, "approved");
  assert.equal(finalPrimary.title, primary.title, "The DISCO title must be preserved.");
  assert.equal(finalPrimary.date, primary.date, "The Saturday date must be preserved.");
  assert.equal(finalPrimary.time, primary.time, "The confirmed 20:00 start must be preserved.");
  assert.equal(finalPrimary.venue, "Ben Akiba");
  assert.equal(finalPrimary.venueId, fixture.venue._id);
  assert.deepEqual(finalPrimary.artists, ["DJ Munja", "DJ File", "Malina"]);
  assert.equal(finalContinuation.status, "rejected");
  assert.match(
    finalContinuation.moderationNote,
    /^\[reviewed_same_source_continuation:v1\]/u,
  );
  assert.equal(isCrossPostCampaignLineageEvent(finalPrimary), true);
  assert.equal(isCrossPostCampaignLineageEvent(finalContinuation), true);
  assert.equal(await isCanonicallyGroundedApprovedEvent(harness.serviceCtx, finalPrimary), true);

  for (const field of [
    "instagramPostId",
    "instagramPostUrl",
    "sourceCaption",
    "sourcePostedAt",
    "rawExtractionJson",
    "sourceOccurrenceKey",
  ]) {
    assert.equal(finalContinuation[field], continuationBefore[field]);
    assert.equal(
      finalIndependent[field],
      independentBefore[field],
      `Friday immutable ${field} changed.`,
    );
  }
  assert.deepEqual(
    [...harness.tables.instagramEventSources.values()],
    linksBefore,
    "Same-source folding must preserve all three source links.",
  );

  const finalReceipt = assertReceiptComplete(harness, receipt._id);
  assert.deepEqual(finalReceipt.expectedKeys, receipt.expectedKeys);
  assert.deepEqual(finalReceipt.satisfiedKeys, receipt.satisfiedKeys);
  assert.equal(finalReceipt.expectedOccurrences.length, 3);
  assert.deepEqual(
    finalReceipt.expectedOccurrences.find(({ key }) => key === keys.friday),
    {
      key: keys.friday,
      date: BEN_DATE_FRIDAY,
      time: "22:00-04:00",
      venue: "Ben Akiba",
      title: independent.title,
      artists: independent.artists,
    },
    "The Friday occurrence binding must receive only its reviewed correction.",
  );
  assert.equal(
    finalReceipt.satisfiedOccurrences.find(({ key }) => key === keys.friday).eventId,
    independent._id,
  );
  assert.equal(
    finalReceipt.satisfiedOccurrences.find(({ key }) => key === keys.disco).eventId,
    primary._id,
  );
  assert.equal(
    finalReceipt.satisfiedOccurrences.find(({ key }) => key === keys.malina).eventId,
    primary._id,
  );
  for (const key of [keys.disco, keys.malina]) {
    const occurrence = finalReceipt.expectedOccurrences.find((item) => item.key === key);
    assert.deepEqual(
      { ...occurrence, key: undefined },
      {
        key: undefined,
        date: BEN_DATE_SATURDAY,
        time: "20:00",
        venue: "Ben Akiba",
        title: "DISCO",
        artists: ["DJ Munja", "DJ File", "Malina"],
      },
    );
  }

  const primaryFields = JSON.parse(finalPrimary.normalizedFieldsJson);
  assert.equal(primaryFields.reviewedSameSourceContinuationFold.operationId, result.operationId);
  assert.equal(
    getOnlyAudit(harness, primary._id, "reviewed_same_source_continuation_folded")
      .eventId,
    primary._id,
  );
  assert.equal(
    getOnlyAudit(
      harness,
      continuation._id,
      "reviewed_same_source_continuation_rejected",
    ).eventId,
    continuation._id,
  );
  assert.equal(
    getOnlyAudit(
      harness,
      independent._id,
      "reviewed_same_source_independent_corrected",
    ).eventId,
    independent._id,
  );

  await assert.rejects(
    invokeAtomically(
      foldReviewedStructuredSameSourceContinuation,
      harness,
      benArgs(fixture),
    ),
    /precondition|approved|lineage|already/iu,
    "A stale same-source replay must fail closed.",
  );
}

function mutateBenFixture(mutator) {
  const fixture = benFixture();
  mutator(fixture);
  return fixture;
}

async function qaBenAdversarialCases() {
  const cases = [
    {
      label: "stale independent Friday revision",
      mutate: (fixture) => {
        fixture.harness.tables.events.get(fixture.independent._id).updatedAt += 1;
      },
      error: /precondition|version|changed/iu,
    },
    {
      label: "changed independent Friday normalized evidence",
      mutate: (fixture) => {
        const independent = fixture.harness.tables.events.get(fixture.independent._id);
        independent.normalizedFieldsJson = JSON.stringify({
          ...JSON.parse(independent.normalizedFieldsJson),
          time: "23:00-04:00",
        });
      },
      error: /precondition|changed|receipt|representative/iu,
    },
    {
      label: "receipt with removed Friday key",
      mutate: (fixture) => {
        const receipt = fixture.harness.tables.instagramSourceOccurrenceReceipts.get(
          fixture.receipt._id,
        );
        receipt.expectedKeys = receipt.expectedKeys.filter(
          (key) => key !== fixture.keys.friday,
        );
        receipt.expectedOccurrences = receipt.expectedOccurrences.filter(
          ({ key }) => key !== fixture.keys.friday,
        );
        receipt.satisfiedKeys = receipt.satisfiedKeys.filter(
          (key) => key !== fixture.keys.friday,
        );
        receipt.satisfiedOccurrences = receipt.satisfiedOccurrences.filter(
          ({ key }) => key !== fixture.keys.friday,
        );
      },
      error: /three|receipt|topology|independent/iu,
    },
    {
      label: "receipt with an extra fourth key",
      mutate: (fixture) => {
        const receipt = fixture.harness.tables.instagramSourceOccurrenceReceipts.get(
          fixture.receipt._id,
        );
        const key = `instagram-occurrence-v2:${"9".repeat(64)}`;
        receipt.expectedKeys.push(key);
        receipt.expectedOccurrences.push({
          key,
          date: "2026-09-06",
          time: "21:00",
          venue: "Ben Akiba",
          title: "Unreviewed fourth row",
          artists: [],
        });
        receipt.satisfiedKeys.push(key);
        receipt.satisfiedOccurrences.push({ key, eventId: fixture.independent._id });
      },
      error: /three|receipt|topology|ambiguous/iu,
    },
    {
      label: "crossed Malina source link",
      mutate: (fixture) => {
        fixture.harness.tables.instagramEventSources.get(
          fixture.continuationLink._id,
        ).sourceOccurrenceKey = fixture.keys.disco;
      },
      error: /source link|inconsistent|occurrence/iu,
    },
    {
      label: "changed shared source fingerprint",
      mutate: (fixture) => {
        fixture.harness.tables.instagramEventSources.get(
          fixture.primaryLink._id,
        ).sourceFingerprint = `instagram-source-v2:${"8".repeat(64)}`;
      },
      error: /fingerprint|source|receipt/iu,
    },
    {
      label: "wrong primary schedule source text",
      mutate: (fixture) => {
        fixture.primaryScheduleSourceText = "SUBOTA / A DIFFERENT EVENT";
      },
      args: (fixture) => ({
        ...benArgs(fixture),
        primaryScheduleSourceText: fixture.primaryScheduleSourceText,
      }),
      error: /schedule|source text|evidence/iu,
    },
    {
      label: "mutated raw extraction after review",
      mutate: (fixture) => {
        const primary = fixture.harness.tables.events.get(fixture.primary._id);
        primary.rawExtractionJson = rawExtraction([]);
      },
      error: /grounded|source|raw|evidence/iu,
    },
    {
      label: "wrong canonical venue revision",
      mutate: (fixture) => {
        fixture.harness.tables.venues.get(fixture.venue._id).updatedAt += 1;
      },
      error: /venue|revision|exact/iu,
    },
    {
      label: "continuation has confirmed conflicting time",
      mutate: (fixture) => {
        const continuation = fixture.harness.tables.events.get(fixture.continuation._id);
        continuation.time = "23:00";
        continuation.timeStatus = "confirmed";
        continuation.timeEvidenceKind = "start_time_stated";
        const fields = JSON.parse(continuation.normalizedFieldsJson);
        fields.time = "23:00";
        fields.timeStatus = "confirmed";
        fields.timeEvidenceKind = "start_time_stated";
        continuation.normalizedFieldsJson = JSON.stringify(fields);
        const receipt = fixture.harness.tables.instagramSourceOccurrenceReceipts.get(
          fixture.receipt._id,
        );
        receipt.expectedOccurrences.find(
          ({ key }) => key === fixture.keys.malina,
        ).time = "23:00";
        fixture.continuation.updatedAt = continuation.updatedAt;
        fixture.continuation.normalizedFieldsJson = continuation.normalizedFieldsJson;
      },
      error: /continuation|TBD|unreadable|time|proof/iu,
    },
  ];

  for (const testCase of cases) {
    const fixture = mutateBenFixture(testCase.mutate);
    const before = fixture.harness.snapshot();
    await assert.rejects(
      invokeAtomically(
        foldReviewedStructuredSameSourceContinuation,
        fixture.harness,
        testCase.args?.(fixture) ?? benArgs(fixture),
      ),
      testCase.error,
      testCase.label,
    );
    assert.deepEqual(fixture.harness.snapshot(), before, `${testCase.label} must be atomic.`);
  }
}

function reviewedScheduleFoldFixture() {
  const date = "2026-09-05";
  const handle = "kolarac_art_bioskop";
  const sourceIdentity = "instagram-source-identity-v1:kolarac-weekly";
  const sourceFingerprint = `instagram-source-v2:${"7".repeat(64)}`;
  const keys = {
    prior: `instagram-occurrence-v2:${"1".repeat(64)}`,
    hobotnica: `instagram-occurrence-v2:${"2".repeat(64)}`,
    later: `instagram-occurrence-v2:${"3".repeat(64)}`,
  };
  const primaryCaption = [
    "REPERTOAR LETNJEG BIOSKOPA",
    "Petak 4.9. 20:30 DRUGI FILM",
    "Subota 5.9. 20:30 HOBOTNICA",
    "Nedelja 6.9. 20:30 TREĆI FILM",
    "Ulaznice su dostupne na Biletarnici Kolarca.",
  ].join("\n");
  const raw = rawExtraction([
    {
      title: "DRUGI FILM",
      date: "2026-09-04",
      time: "20:30",
      venue: "LETNJI BIOSKOP NA TERASI KOLARCA",
      artists: [],
      source_text: "Petak 4.9. 20:30 DRUGI FILM",
    },
    {
      title: "HOBOTNICA",
      date,
      time: "20:30",
      venue: "LETNJI BIOSKOP NA TERASI KOLARCA",
      artists: [],
      source_text: "Subota 5.9. 20:30 HOBOTNICA",
    },
    {
      title: "TREĆI FILM",
      date: "2026-09-06",
      time: "20:30",
      venue: "LETNJI BIOSKOP NA TERASI KOLARCA",
      artists: [],
      source_text: "Nedelja 6.9. 20:30 TREĆI FILM",
    },
  ]);
  const venue = {
    _id: "venue-kolarac",
    _creationTime: 1,
    name: "Kolarac",
    instagramHandle: "kolarac_kolarceva_zaduzbina",
    normalizedInstagramHandle: "kolarac_kolarceva_zaduzbina",
    category: "arts & culture",
    publicStatus: "published",
    scrapeActive: true,
    createdAt: 1,
    updatedAt: 4_000,
  };
  const common = {
    venue: "LETNJI BIOSKOP NA TERASI KOLARCA",
    artists: [],
    handle,
    postId: "KOLARACWEEKLY",
    caption: primaryCaption,
    postedAt: "2026-08-28T08:00:00.000Z",
    sourceFingerprint,
    expectedKeys: Object.values(keys),
    raw,
  };
  const prior = eventRow({
    ...common,
    id: "j57-kolarac-prior",
    title: "DRUGI FILM",
    date: "2026-09-04",
    time: "20:30",
    description: "A different screening.",
    occurrenceKey: keys.prior,
    updatedAt: 4_100,
    splitSourceLine: "Petak 4.9. 20:30 DRUGI FILM",
  });
  const primary = eventRow({
    ...common,
    id: "j573-hobotnica-primary",
    title: "HOBOTNICA",
    date,
    time: "20:30",
    description: "Film screening: HOBOTNICA.",
    occurrenceKey: keys.hobotnica,
    updatedAt: 4_200,
    splitSourceLine: "Subota 5.9. 20:30 HOBOTNICA",
  });
  const later = eventRow({
    ...common,
    id: "j57-kolarac-later",
    title: "TREĆI FILM",
    date: "2026-09-06",
    time: "20:30",
    description: "Another different screening.",
    occurrenceKey: keys.later,
    updatedAt: 4_300,
    splitSourceLine: "Nedelja 6.9. 20:30 TREĆI FILM",
  });
  for (const [index, event] of [prior, primary, later].entries()) {
    const fields = JSON.parse(event.normalizedFieldsJson);
    fields.multiEventSplitDetected = true;
    fields.multiEventSplitCount = 3;
    fields.splitEventIndex = index + 1;
    fields.splitEventTotal = 3;
    event.normalizedFieldsJson = JSON.stringify(fields);
  }
  const duplicate = eventRow({
    id: "j57c-hobotnica-legacy",
    title: "HOBOTNICA (Hobotnica)",
    date,
    time: "20:30",
    venue: "Kolarac",
    venueId: venue._id,
    venueHandle: venue.instagramHandle,
    artists: [],
    description: "Documentary screening lasting 64 minutes.",
    handle: "beldocsfest",
    postId: "BELDOCSLETO",
    caption: [
      "BELDOCS LETO na terasi Art bioskopa Kolarac",
      "4.9. DRUGI PROGRAM",
      "5.9. 20:30 HOBOTNICA (Hobotnica) | 64 min",
      "6.9. ČETVRTI PROGRAM",
    ].join("\n"),
    postedAt: "2026-08-01T08:00:00.000Z",
    occurrenceKey: `instagram-occurrence-v2:${"4".repeat(64)}`,
    sourceFingerprint: `instagram-source-v2:${"8".repeat(64)}`,
    expectedKeys: [],
    raw: rawExtraction([]),
    updatedAt: 4_400,
    splitSourceLine: "5.9. 20:30 HOBOTNICA (Hobotnica) | 64 min",
  });
  const duplicateFields = JSON.parse(duplicate.normalizedFieldsJson);
  duplicateFields.multiEventSplitDetected = true;
  duplicateFields.multiEventSplitCount = 3;
  duplicateFields.splitEventIndex = 3;
  duplicateFields.splitEventTotal = 3;
  delete duplicateFields.sourceOccurrenceKey;
  delete duplicateFields.sourceOccurrenceSourceFingerprint;
  delete duplicateFields.sourceOccurrenceExpectedKeys;
  delete duplicateFields.sourceOccurrenceExpectedCount;
  duplicate.normalizedFieldsJson = JSON.stringify(duplicateFields);
  delete duplicate.sourceOccurrenceKey;

  const links = [prior, primary, later].map((event, index) =>
    sourceLink({
      id: `kolarac-link-${index}`,
      event,
      sourceIdentity,
      sourceFingerprint,
      handle,
      updatedAt: 4_500 + index,
    }),
  );
  const receipt = receiptRow({
    id: "kolarac-receipt",
    sourceIdentity,
    sourceFingerprint,
    events: [prior, primary, later],
    updatedAt: 4_600,
  });
  const harness = makeHarness({
    events: [prior, primary, later, duplicate],
    instagramEventSources: links,
    instagramSourceOccurrenceReceipts: [receipt],
    scrapedPosts: [
      persistedPost({
        id: "kolarac-post",
        handle,
        postId: primary.instagramPostId,
        caption: primary.sourceCaption,
        postedAt: primary.sourcePostedAt,
        raw,
      }),
    ],
    venues: [venue],
    savedEvents: [
      { _id: "hobotnica-primary-save", userId: "same", eventId: primary._id, createdAt: 1 },
      { _id: "hobotnica-deduped-save", userId: "same", eventId: duplicate._id, createdAt: 2 },
      { _id: "hobotnica-moved-save", userId: "moved", eventId: duplicate._id, createdAt: 3 },
    ],
    userSavedEvents: [],
  });
  return {
    harness,
    venue,
    prior,
    primary,
    later,
    duplicate,
    primaryLink: links[1],
    receipt,
    keys,
  };
}

function reviewedScheduleFoldArgs(fixture) {
  return {
    operationId: "reviewed-schedule-fold:hobotnica-2026-09-05",
    primaryId: fixture.primary._id,
    expectedPrimaryUpdatedAt: fixture.primary.updatedAt,
    expectedPrimaryNormalizedFieldsJson: fixture.primary.normalizedFieldsJson,
    expectedPrimarySourceLinkId: fixture.primaryLink._id,
    expectedPrimarySourceLinkUpdatedAt: fixture.primaryLink.updatedAt,
    expectedPrimaryReceiptId: fixture.receipt._id,
    expectedPrimaryReceiptUpdatedAt: fixture.receipt.updatedAt,
    duplicateId: fixture.duplicate._id,
    expectedDuplicateUpdatedAt: fixture.duplicate.updatedAt,
    expectedDuplicateNormalizedFieldsJson: fixture.duplicate.normalizedFieldsJson,
    expectedDuplicateSourceVersions: [],
    targetVenueId: fixture.venue._id,
    expectedTargetVenueUpdatedAt: fixture.venue.updatedAt,
    expectedTargetVenueHandle: fixture.venue.instagramHandle,
    occurrenceAnchors: ["HOBOTNICA"],
    primaryVenueEvidence: "Biletarnici Kolarca",
    duplicateVenueEvidence: "Art bioskopa Kolarac",
    nextTitle: "HOBOTNICA",
    nextTime: "20:30",
    nextVenue: "Kolarac",
    nextArtists: [],
    nextDescription:
      "Documentary screening at Kolarac, lasting 64 minutes. Tickets cost 400 RSD.",
    timeEvidenceText: "20:30 HOBOTNICA",
    moderationNote:
      "Human-reviewed cross-post schedule row fold with exact local row evidence.",
    serviceSecret: process.env.CRON_SECRET,
  };
}

async function qaReviewedCrossPostScheduleFold() {
  const fixture = reviewedScheduleFoldFixture();
  const operationId = reviewedScheduleFoldArgs(fixture).operationId;
  const beforeContext = await getReviewedCrossPostScheduleFoldContext._handler(
    fixture.harness.serviceCtx,
    {
      operationId,
      primaryId: fixture.primary._id,
      duplicateId: fixture.duplicate._id,
      serviceSecret: process.env.CRON_SECRET,
    },
  );
  assert.equal(beforeContext.primarySources.length, 1);
  assert.equal(beforeContext.primarySources[0].receipt._id, fixture.receipt._id);
  assert.equal(beforeContext.duplicateSources.length, 0);
  assert.equal(beforeContext.primaryAudits.length, 0);
  assert.equal(beforeContext.duplicateAudits.length, 0);
  const immutableSiblingExpected = fixture.receipt.expectedOccurrences
    .filter(({ key }) => key !== fixture.keys.hobotnica)
    .map(clone);
  const immutableSiblingSatisfied = fixture.receipt.satisfiedOccurrences
    .filter(({ key }) => key !== fixture.keys.hobotnica)
    .map(clone);
  const immutableLinks = clone([...fixture.harness.tables.instagramEventSources.values()]);

  const result = await invokeAtomically(
    foldReviewedCrossPostScheduleDuplicate,
    fixture.harness,
    reviewedScheduleFoldArgs(fixture),
  );
  assert.equal(result.primaryId, fixture.primary._id);
  assert.equal(result.duplicateId, fixture.duplicate._id);
  assert.equal(result.movedSaveCount, 1);
  assert.equal(result.dedupedSaveCount, 1);

  const finalPrimary = fixture.harness.tables.events.get(fixture.primary._id);
  const finalDuplicate = fixture.harness.tables.events.get(fixture.duplicate._id);
  assert.equal(finalPrimary.status, "approved");
  assert.equal(finalPrimary.title, "HOBOTNICA");
  assert.equal(finalPrimary.time, "20:30");
  assert.equal(finalPrimary.venue, "Kolarac");
  assert.equal(finalPrimary.venueId, fixture.venue._id);
  assert.deepEqual(finalPrimary.artists, []);
  assert.equal(finalDuplicate.status, "rejected");
  assert.match(finalDuplicate.moderationNote, /^\[reviewed_cross_post_schedule_duplicate:v1\]/u);
  assert.deepEqual(
    [...fixture.harness.tables.instagramEventSources.values()],
    immutableLinks,
    "Schedule folding must not rewrite unrelated source links.",
  );

  const finalReceipt = assertReceiptComplete(fixture.harness, fixture.receipt._id);
  assert.deepEqual(
    finalReceipt.expectedOccurrences.filter(({ key }) => key !== fixture.keys.hobotnica),
    immutableSiblingExpected,
  );
  assert.deepEqual(
    finalReceipt.satisfiedOccurrences.filter(({ key }) => key !== fixture.keys.hobotnica),
    immutableSiblingSatisfied,
  );
  assert.equal(
    finalReceipt.satisfiedOccurrences.find(({ key }) => key === fixture.keys.hobotnica).eventId,
    fixture.primary._id,
  );
  assert.equal(
    finalReceipt.expectedOccurrences.find(({ key }) => key === fixture.keys.hobotnica).venue,
    "Kolarac",
  );
  getOnlyAudit(fixture.harness, fixture.primary._id, "reviewed_cross_post_schedule_folded");
  getOnlyAudit(
    fixture.harness,
    fixture.duplicate._id,
    "reviewed_cross_post_schedule_duplicate_rejected",
  );
  const afterContext = await getReviewedCrossPostScheduleFoldContext._handler(
    fixture.harness.serviceCtx,
    {
      operationId,
      primaryId: fixture.primary._id,
      duplicateId: fixture.duplicate._id,
      serviceSecret: process.env.CRON_SECRET,
    },
  );
  assert.equal(afterContext.primary.status, "approved");
  assert.equal(afterContext.duplicate.status, "rejected");
  assert.equal(afterContext.primaryAudits.length, 1);
  assert.equal(afterContext.duplicateAudits.length, 1);
}

async function qaReviewedCrossPostScheduleAdversarialCases() {
  const cases = [
    {
      label: "overlapping broad caption with a different row",
      mutate: (fixture) => {
        const duplicate = fixture.harness.tables.events.get(fixture.duplicate._id);
        const fields = JSON.parse(duplicate.normalizedFieldsJson);
        fields.rowSourceText = "5.9. 20:30 DRUGI PROGRAM";
        fields.splitSourceLine = fields.rowSourceText;
        duplicate.normalizedFieldsJson = JSON.stringify(fields);
        fixture.duplicate.normalizedFieldsJson = duplicate.normalizedFieldsJson;
      },
      error: /row-local|evidence/iu,
    },
    {
      label: "different verified time",
      mutate: (fixture) => {
        const duplicate = fixture.harness.tables.events.get(fixture.duplicate._id);
        duplicate.time = "21:00";
        const fields = JSON.parse(duplicate.normalizedFieldsJson);
        fields.time = "21:00";
        duplicate.normalizedFieldsJson = JSON.stringify(fields);
        fixture.duplicate.normalizedFieldsJson = duplicate.normalizedFieldsJson;
      },
      error: /identity|time|exact/iu,
    },
    {
      label: "event time matches but duplicate row carries a different clock",
      mutate: (fixture) => {
        const duplicate = fixture.harness.tables.events.get(fixture.duplicate._id);
        const fields = JSON.parse(duplicate.normalizedFieldsJson);
        fields.rowSourceText = "5.9. 21:00 HOBOTNICA (Hobotnica) | 64 min";
        fields.splitSourceLine = fields.rowSourceText;
        duplicate.normalizedFieldsJson = JSON.stringify(fields);
        fixture.duplicate.normalizedFieldsJson = duplicate.normalizedFieldsJson;
      },
      error: /row-local|evidence/iu,
    },
    {
      label: "same Instagram post",
      mutate: (fixture) => {
        const duplicate = fixture.harness.tables.events.get(fixture.duplicate._id);
        duplicate.instagramPostId = fixture.primary.instagramPostId;
        duplicate.instagramPostUrl = fixture.primary.instagramPostUrl;
      },
      error: /distinct Instagram posts/iu,
    },
    {
      label: "matching Instagram post ID with a conflicting URL",
      mutate: (fixture) => {
        const duplicate = fixture.harness.tables.events.get(fixture.duplicate._id);
        duplicate.instagramPostId = fixture.primary.instagramPostId;
      },
      error: /distinct Instagram posts/iu,
    },
    {
      label: "matching Instagram post URL with a conflicting ID",
      mutate: (fixture) => {
        const duplicate = fixture.harness.tables.events.get(fixture.duplicate._id);
        duplicate.instagramPostUrl = fixture.primary.instagramPostUrl;
      },
      error: /distinct Instagram posts/iu,
    },
    {
      label: "new duplicate source link after review",
      mutate: (fixture) => {
        fixture.harness.tables.instagramEventSources.set("unexpected-legacy-link", {
          _id: "unexpected-legacy-link",
          _creationTime: 1,
          eventId: fixture.duplicate._id,
          sourceIdentity: "instagram-source-identity-v1:legacy",
          sourceFingerprint: `instagram-source-v2:${"9".repeat(64)}`,
          sourceOccurrenceKey: `instagram-occurrence-v2:${"9".repeat(64)}`,
          linkedAt: 1,
          updatedAt: 1,
        });
      },
      error: /source links changed/iu,
    },
    {
      label: "changed canonical venue revision",
      mutate: (fixture) => {
        fixture.harness.tables.venues.get(fixture.venue._id).updatedAt += 1;
      },
      error: /target venue|exact|public/iu,
    },
  ];

  for (const testCase of cases) {
    const fixture = reviewedScheduleFoldFixture();
    testCase.mutate(fixture);
    const before = fixture.harness.snapshot();
    await assert.rejects(
      invokeAtomically(
        foldReviewedCrossPostScheduleDuplicate,
        fixture.harness,
        reviewedScheduleFoldArgs(fixture),
      ),
      testCase.error,
      testCase.label,
    );
    assert.deepEqual(fixture.harness.snapshot(), before, `${testCase.label} must be atomic.`);
  }
}

function promoterScheduleFoldFixture() {
  const venue = { _id: "vinyl-venue", _creationTime: 1, name: "Vinyl",
    instagramHandle: "vinyl.belgrade", normalizedInstagramHandle: "vinyl.belgrade",
    category: "nightclub", publicStatus: "published", scrapeActive: true,
    createdAt: 1, updatedAt: 9_000 };
  const dates = ["2026-10-16", "2026-10-17", "2026-10-18"];
  const programTitle = "\u0110IR";
  const keys = ["a", "b", "c", "d"].map((value) => `instagram-occurrence-v2:${value.repeat(64)}`);
  const promoterFingerprint = `instagram-source-v2:${"d".repeat(64)}`;
  const scheduleFingerprint = `instagram-source-v2:${"e".repeat(64)}`;
  const scheduleRow = `Nedelja 18.10; ${programTitle}`;
  const scheduleCaptionLine = "Nedelja 18.10 - @djir.bg";
  const rows = dates.map((date, index) => ({ date, time: "TBD", venue: "Vinyl",
    title: index === 2 ? programTitle : `Independent program ${index + 1}`,
    artists: [], source_text: index === 2 ? scheduleRow : `${16 + index}.10 Independent program ${index + 1}` }));
  const scheduleRaw = rawExtraction(rows);
  const scheduleCaption = `Vikend u Vinylu\nPetak 16.10 - Independent program 1\nSubota 17.10 - Independent program 2\n${scheduleCaptionLine}`;
  const primary = eventRow({ id: "dj-program-primary", title: "Knezevic Aleksaa, Kukibeats",
    date: dates[2], time: "TBD", venue: "DJIR", artists: ["Knezevic Aleksaa", "Kukibeats"],
    description: "DJIR party with Knezevic Aleksaa and Kukibeats.", handle: "djir.bg",
    postId: "DJIRPRIMARY", caption: `Napravicemo jedan ${programTitle} do grada ti i ja! #${programTitle} #vinyl`,
    postedAt: "2026-10-12T10:00:00.000Z", occurrenceKey: keys[3],
    sourceFingerprint: promoterFingerprint, expectedKeys: [keys[3]],
    raw: rawExtraction(), updatedAt: 9_100 });
  primary.normalizedFieldsJson = JSON.stringify({ ...JSON.parse(primary.normalizedFieldsJson), multiEventSplitDetected: false });
  const scheduleEvents = rows.map((row, index) => {
    const event = eventRow({ id: `vinyl-weekly-${index}`, title: row.title,
      date: row.date, time: "TBD", venue: "Vinyl", venueId: venue._id,
      venueHandle: venue.instagramHandle, artists: [], description: row.title,
      handle: venue.instagramHandle, postId: "VINYLWEEKLY", caption: scheduleCaption,
      postedAt: "2026-10-15T10:00:00.000Z", occurrenceKey: keys[index],
      sourceFingerprint: scheduleFingerprint, expectedKeys: keys.slice(0, 3),
      raw: scheduleRaw, updatedAt: 9_200 + index, splitSourceLine: row.source_text });
    event.normalizedFieldsJson = JSON.stringify({ ...JSON.parse(event.normalizedFieldsJson),
      multiEventSplitDetected: true, multiEventSplitCount: 3, splitEventIndex: index + 1,
      splitEventTotal: 3 });
    return event;
  });
  const [unsatisfied, sibling, duplicate] = scheduleEvents;
  Object.assign(sibling, { publicationPolicyVersion: 1, publicationState: "publishable",
    publicationReason: "canonical_source_grounding_verified" });
  const primaryLink = sourceLink({ id: "dj-primary-link", event: primary,
    sourceIdentity: "instagram-source-identity-v1:DJIRPRIMARY", sourceFingerprint: promoterFingerprint,
    handle: "djir.bg", updatedAt: 9_300 });
  const scheduleLinks = [sibling, duplicate].map((event, index) => sourceLink({
    id: `vinyl-link-${index}`, event, sourceIdentity: "instagram-source-identity-v1:VINYLWEEKLY",
    sourceFingerprint: scheduleFingerprint, handle: venue.instagramHandle, updatedAt: 9_310 + index }));
  const primaryReceipt = receiptRow({ id: "dj-primary-receipt", sourceIdentity: primaryLink.sourceIdentity,
    sourceFingerprint: promoterFingerprint, events: [primary], updatedAt: 9_400 });
  const scheduleReceipt = receiptRow({ id: "vinyl-weekly-receipt", sourceIdentity: scheduleLinks[0].sourceIdentity,
    sourceFingerprint: scheduleFingerprint, events: scheduleEvents, updatedAt: 9_410 });
  scheduleReceipt.satisfiedKeys = keys.slice(1, 3);
  scheduleReceipt.satisfiedOccurrences = [sibling, duplicate].map((event) => ({ key: event.sourceOccurrenceKey, eventId: event._id }));
  function sourceOccurrence(event, link, ordinal, id, satisfied = true) {
    const factsJson = JSON.stringify({ artistClaims: event.artists, localDate: event.date,
      titleClaim: event.title, venueClaim: event.venue, eventTypeClaim: event.eventType,
      timeRelation: "unknown", evidence: [{ field: "title", source: "caption", exactText: event.title }],
      policy: { approvalDisposition: "approved", pendingReasons: [], signals: [], structuredEvidenceVerified: true } });
    const canonicalEventJson = JSON.stringify({ normalizedFieldsJson: event.normalizedFieldsJson,
      requestedStatus: "approved", sourceConflictFields: [], time: "TBD", timeConfidence: 0,
      timeSource: "unknown", timeStatus: "unknown", timeEvidenceKind: "unreadable" });
    const receipt = link.sourceIdentity === primaryLink.sourceIdentity ? primaryReceipt : scheduleReceipt;
    const expected = receipt.expectedOccurrences.find(({ key }) => key === event.sourceOccurrenceKey);
    Object.assign(expected, { factsJson, canonicalEventJson });
    return { _id: id, _creationTime: 1, provider: "instagram", sourceDocumentId: `${link.sourceIdentity}-post`,
      sourceIdentity: link.sourceIdentity, sourceFingerprint: link.sourceFingerprint,
      canonicalSourceUrl: event.instagramPostUrl, sourceRevision: 1, sourceOccurrenceKey: event.sourceOccurrenceKey,
      occurrenceOrdinal: ordinal, factsJson, canonicalEventJson, normalizedOccurrenceJson: JSON.stringify(expectedOccurrence(event)),
      venueResolutionStatus: "resolved", ...(event.venueId ? { venueId: event.venueId } : {}),
      ...(satisfied ? { canonicalEventId: event._id } : {}), state: satisfied ? "satisfied" : "expected",
      occurrenceSignatureVersion: 1, occurrenceSignatureHash: `signature-${id}`, occurrenceDateKey: event.date,
      occurrenceVenueIdentity: event.venue, occurrenceTimeIdentity: "unknown-time", occurrenceTitleFamily: event.title,
      occurrenceArtistFingerprint: event.artists.join("+"), occurrenceEventType: event.eventType,
      createdAt: 1, updatedAt: 9_500 + ordinal };
  }
  const primaryOccurrence = sourceOccurrence(primary, primaryLink, 0, "dj-primary-occurrence");
  const scheduleOccurrences = scheduleEvents.map((event, index) => sourceOccurrence(event,
    scheduleLinks.find((link) => link.eventId === event._id) ?? scheduleLinks[0], index,
    `vinyl-occurrence-${index}`, index !== 0));
  scheduleOccurrences[0].state = "superseded";
  primaryLink.sourceOccurrenceId = primaryOccurrence._id;
  scheduleLinks.forEach((link) => { link.sourceOccurrenceId = scheduleOccurrences.find((row) => row.canonicalEventId === link.eventId)._id; });
  const harness = makeHarness({ events: [primary, sibling, duplicate], venues: [venue],
    instagramEventSources: [primaryLink, ...scheduleLinks],
    instagramSourceOccurrenceReceipts: [primaryReceipt, scheduleReceipt],
    sourceOccurrences: [primaryOccurrence, ...scheduleOccurrences],
    instagramSources: [{ _id: "djir-source", handle: "djir.bg", role: "venue", active: true, updatedAt: 1 }],
    scrapedPosts: [primary, duplicate].map((event, index) => persistedPost({
      id: `${index === 0 ? primaryLink.sourceIdentity : scheduleLinks[1].sourceIdentity}-post`,
      handle: index === 0 ? "djir.bg" : venue.instagramHandle, postId: event.instagramPostId,
      caption: event.sourceCaption, postedAt: event.sourcePostedAt, raw: event.rawExtractionJson })),
    savedEvents: [{ _id: "primary-same-save", userId: "same", eventId: primary._id, createdAt: 1 },
      { _id: "duplicate-same-save", userId: "same", eventId: duplicate._id, createdAt: 2 },
      { _id: "duplicate-new-save", userId: "different", eventId: duplicate._id, createdAt: 3 }],
    userSavedEvents: [{ _id: "duplicate-legacy-save", userId: "legacy", eventId: duplicate._id, createdAt: 4 }] });
  return { harness, venue, primary, duplicate, sibling, unsatisfied, primaryLink,
    duplicateLink: scheduleLinks[1], primaryReceipt, scheduleReceipt, primaryOccurrence,
    duplicateOccurrence: scheduleOccurrences[2], scheduleOccurrences, scheduleRow, scheduleCaptionLine, programTitle };
}

function promoterScheduleFoldArgs(fixture) {
  const sourceVersion = (link, receipt, occurrence) => ({ sourceLinkId: link._id,
    sourceLinkUpdatedAt: link.updatedAt, receiptId: receipt._id, receiptUpdatedAt: receipt.updatedAt,
    sourceOccurrenceId: occurrence._id, sourceOccurrenceUpdatedAt: occurrence.updatedAt });
  return { operationId: "reviewed-promoter-fold:djir-2026-10-18", primaryId: fixture.primary._id,
    expectedPrimaryUpdatedAt: fixture.primary.updatedAt,
    expectedPrimaryNormalizedFieldsJson: fixture.primary.normalizedFieldsJson,
    primarySource: sourceVersion(fixture.primaryLink, fixture.primaryReceipt, fixture.primaryOccurrence),
    duplicateId: fixture.duplicate._id, expectedDuplicateUpdatedAt: fixture.duplicate.updatedAt,
    expectedDuplicateNormalizedFieldsJson: fixture.duplicate.normalizedFieldsJson,
    duplicateSource: sourceVersion(fixture.duplicateLink, fixture.scheduleReceipt, fixture.duplicateOccurrence),
    expectedPrimarySourceHandle: "djir.bg", expectedScheduleSourceHandle: "vinyl.belgrade",
    targetVenueId: fixture.venue._id, expectedTargetVenueUpdatedAt: fixture.venue.updatedAt,
    expectedTargetVenueHandle: fixture.venue.instagramHandle, nextVenue: "Vinyl", programTitle: fixture.programTitle,
    nextTitle: fixture.programTitle, expectedScheduleRow: fixture.scheduleRow,
    expectedScheduleCaptionLine: fixture.scheduleCaptionLine,
    nextDescription: "DJIR at Vinyl with Knezevic Aleksaa and Kukibeats.",
    moderationNote: "Reviewed the promoter caption and the exact Vinyl Sunday schedule row and account mention as the same occurrence.",
    serviceSecret: process.env.CRON_SECRET };
}

async function qaReviewedPromoterScheduleFold() {
  const fixture = promoterScheduleFoldFixture();
  const { harness } = fixture;
  const before = harness.snapshot();
  const contextArgs = { operationId: promoterScheduleFoldArgs(fixture).operationId,
    primaryId: fixture.primary._id, duplicateId: fixture.duplicate._id,
    targetVenueId: fixture.venue._id, serviceSecret: process.env.CRON_SECRET };
  await assert.rejects(getReviewedPromoterScheduleFoldContext._handler(harness.serviceCtx,
    { ...contextArgs, serviceSecret: "wrong" }), /./u);
  const context = await getReviewedPromoterScheduleFoldContext._handler(harness.serviceCtx, contextArgs);
  assert.equal(context.primary.sources[0].occurrence._id, fixture.primaryOccurrence._id);
  assert.equal(context.duplicate.sources[0].receipt.expectedKeys.length, 3);
  assert.equal(context.duplicate.sources[0].receipt.satisfiedKeys.length, 2);
  assert.equal(context.targetVenue._id, fixture.venue._id);
  for (const event of [fixture.primary, fixture.duplicate, fixture.sibling]) {
    assert.equal(await isCanonicallyGroundedApprovedEvent(harness.serviceCtx, event), true);
  }
  const result = await invokeAtomically(foldReviewedPromoterScheduleDuplicate, harness, promoterScheduleFoldArgs(fixture));
  assert.equal(result.primaryId, fixture.primary._id);
  assert.equal(result.duplicateId, fixture.duplicate._id);
  const primary = harness.tables.events.get(fixture.primary._id);
  const duplicate = harness.tables.events.get(fixture.duplicate._id);
  assert.equal(primary.status, "approved");
  assert.equal(primary.publicationState, "publishable", "The corrected primary must remain publicly discoverable.");
  assert.equal(primary.title, fixture.programTitle);
  assert.equal(primary.venue, "Vinyl");
  assert.equal(primary.venueId, fixture.venue._id);
  assert.equal(primary.time, "TBD", "A venue profile's generic opening hours cannot become this event's time.");
  assert.equal(primary.timeSource, "unknown");
  assert.deepEqual(primary.artists, fixture.primary.artists, "Promoter billing must not be erased by the sparse weekly row.");
  assert.equal(duplicate.status, "rejected");
  assert.equal(isCrossPostCampaignLineageEvent(primary), false,
    "A fold with both complete source bindings uses the ordinary provenance contract.");
  assert.equal(await isCanonicallyGroundedApprovedEvent(harness.serviceCtx, primary), true);
  for (const event of [fixture.primary, fixture.duplicate]) {
    const final = harness.tables.events.get(event._id);
    for (const field of ["instagramPostId", "instagramPostUrl", "sourceCaption", "sourcePostedAt", "rawExtractionJson", "sourceOccurrenceKey"]) {
      assert.equal(final[field], event[field], `Immutable event ${field} changed.`);
    }
  }
  const finalSibling = harness.tables.events.get(fixture.sibling._id);
  for (const [field, value] of Object.entries(fixture.sibling)) {
    assert.deepEqual(finalSibling[field], value, `Saturday source/public field ${field} must not change.`);
  }
  assert.deepEqual(harness.tables.sourceOccurrences.get(fixture.scheduleOccurrences[0]._id), fixture.scheduleOccurrences[0]);
  assert.deepEqual(harness.tables.sourceOccurrences.get(fixture.scheduleOccurrences[1]._id), fixture.scheduleOccurrences[1]);
  for (const occurrence of [fixture.primaryOccurrence, fixture.duplicateOccurrence]) {
    const final = harness.tables.sourceOccurrences.get(occurrence._id);
    assert.equal(final.canonicalEventId, fixture.primary._id);
    assert.equal(final.state, "satisfied");
    assert.equal(final.venueId, fixture.venue._id);
    for (const field of ["factsJson", "canonicalEventJson", "sourceFingerprint", "sourceRevision", "sourceOccurrenceKey", "canonicalSourceUrl"]) {
      assert.equal(final[field], occurrence[field], `Observed occurrence ${field} must remain immutable.`);
    }
    const expected = JSON.parse(final.normalizedOccurrenceJson);
    assert.equal(sourceOccurrenceRepresentativeMatchesExpected(primary, expected), true);
  }
  for (const [receiptBefore, key] of [[fixture.primaryReceipt, fixture.primary.sourceOccurrenceKey], [fixture.scheduleReceipt, fixture.duplicate.sourceOccurrenceKey]]) {
    const receipt = assertReceiptComplete(harness, receiptBefore._id);
    assert.deepEqual(receipt.expectedKeys, receiptBefore.expectedKeys);
    assert.deepEqual(receipt.satisfiedKeys, receiptBefore.satisfiedKeys);
    assert.deepEqual(receipt.expectedOccurrences.filter((row) => row.key !== key), receiptBefore.expectedOccurrences.filter((row) => row.key !== key));
    assert.deepEqual(receipt.satisfiedOccurrences.filter((row) => row.key !== key), receiptBefore.satisfiedOccurrences.filter((row) => row.key !== key));
    const expected = receipt.expectedOccurrences.find((row) => row.key === key);
    const original = receiptBefore.expectedOccurrences.find((row) => row.key === key);
    assert.equal(expected.factsJson, original.factsJson);
    assert.equal(expected.canonicalEventJson, original.canonicalEventJson);
    assert.equal(expected.title, fixture.programTitle);
    assert.equal(expected.venue, "Vinyl");
    assert.deepEqual(expected.artists, fixture.primary.artists);
    assert.equal(receipt.satisfiedOccurrences.find((row) => row.key === key).eventId, fixture.primary._id);
  }
  assert.equal(harness.tables.instagramSourceOccurrenceReceipts.get(fixture.scheduleReceipt._id).expectedKeys.length, 3);
  assert.equal(harness.tables.instagramSourceOccurrenceReceipts.get(fixture.scheduleReceipt._id).satisfiedKeys.length, 2);
  for (const link of [fixture.primaryLink, fixture.duplicateLink]) {
    const final = harness.tables.instagramEventSources.get(link._id);
    assert.equal(final.eventId, fixture.primary._id);
    for (const field of ["sourceIdentity", "sourceFingerprint", "sourceOccurrenceId", "sourceOccurrenceKey", "instagramPostUrl"]) assert.equal(final[field], link[field]);
  }
  assert.equal([...harness.tables.savedEvents.values()].filter((row) => row.eventId === fixture.primary._id).length, 2);
  assert.equal([...harness.tables.userSavedEvents.values()].filter((row) => row.eventId === fixture.primary._id).length, 1);
  assert.equal([...harness.tables.savedEvents.values()].some((row) => row.eventId === fixture.duplicate._id), false);
  assert.equal([...harness.tables.userSavedEvents.values()].some((row) => row.eventId === fixture.duplicate._id), false);
  assert.equal([...harness.tables.eventAuditLog.values()].filter((row) => row.eventId === fixture.primary._id).length > 0, true);
  const epoch = [...harness.tables.sourceOccurrenceTopologyEpoch.values()][0];
  assert.equal(epoch.currentEpoch, epoch.verifiedEpoch);
  assert.ok(harness.operations.length > before.operations.length);
  const finalContext = await getReviewedPromoterScheduleFoldContext._handler(harness.serviceCtx, contextArgs);
  assert.equal(finalContext.primary.sources.length, 2);
  assert.equal(finalContext.duplicate.sources.length, 0);
  assert.equal(finalContext.primary.audits.length, 1);
  assert.equal(finalContext.duplicate.audits.length, 1);
  const after = harness.snapshot();
  await assert.rejects(invokeAtomically(foldReviewedPromoterScheduleDuplicate, harness, promoterScheduleFoldArgs(fixture)), /precondition|approved|changed|lineage|already/iu);
  assert.deepEqual(harness.snapshot(), after, "Replayed stale repairs must not change any row.");
}

async function qaReviewedPromoterScheduleFoldAdversarialCases() {
  const cases = [
    ["service authentication", (_f, args) => { args.serviceSecret = "wrong"; }],
    ...["Primary", "Duplicate"].flatMap((name) => [
      [`stale ${name} event revision`, (_f, args) => { args[`expected${name}UpdatedAt`] += 1; }],
      [`stale ${name} normalized evidence`, (_f, args) => { args[`expected${name}NormalizedFieldsJson`] = "{}"; }],
      ...["sourceLinkUpdatedAt", "receiptUpdatedAt", "sourceOccurrenceUpdatedAt"].map((field) =>
        [`stale ${name} ${field}`, (_f, args) => { args[`${name.toLowerCase()}Source`][field] += 1; }]),
    ]),
    ["wrong physical venue revision", (_f, args) => { args.expectedTargetVenueUpdatedAt += 1; }],
    ["wrong physical venue identity", (_f, args) => { args.expectedTargetVenueHandle = "other.venue"; }],
    ["wrong source account", (_f, args) => { args.expectedPrimarySourceHandle = "another.promoter"; }],
    ["weekly source must own target venue", (_f, args) => { args.expectedScheduleSourceHandle = "unrelated.weekly"; }],
    ["neighboring weekly row", (_f, args) => { args.expectedScheduleRow = "Subota 17.10; DJIR"; }],
    ["wrong local caption date", (_f, args) => { args.expectedScheduleCaptionLine = "Subota 17.10 - @djir.bg"; }],
    ["wrong mentioned promoter", (_f, args) => { args.expectedScheduleCaptionLine = "Nedelja 18.10 - @other.promoter"; }],
    ["arbitrary replacement title", (_f, args) => { args.nextTitle = "Unrelated Event"; }],
    ["unrelated claimed program", (_f, args) => { args.programTitle = "Unrelated Event"; }],
    ["missing review evidence", (_f, args) => { args.moderationNote = ""; }],
    ["different event dates", (f) => { f.harness.tables.events.get(f.duplicate._id).date = "2026-10-19"; }],
    ["confirmed time cannot silently become TBD", (f) => { f.harness.tables.events.get(f.primary._id).time = "22:00"; }],
    ["ungrounded promoter source", (f) => { f.harness.tables.scrapedPosts.clear(); }],
    ["crossed occurrence binding", (f) => { f.harness.tables.sourceOccurrences.get(f.duplicateOccurrence._id).canonicalEventId = f.primary._id; }],
    ["ambiguous source receipt", (f) => { const receipt = clone(f.primaryReceipt); receipt._id = "extra-receipt"; f.harness.tables.instagramSourceOccurrenceReceipts.set(receipt._id, receipt); }],
    ["unretired expired weekly row blocks publication", (f) => { f.harness.tables.sourceOccurrences.get(f.scheduleOccurrences[0]._id).state = "expected"; }, /publication/iu],
    ["another approved same-date program", (f) => { const other = clone(f.duplicate); other._id = "another-approved-program"; f.harness.tables.events.set(other._id, other); }],
  ];
  for (const [label, mutate, error = /./u] of cases) {
    const fixture = promoterScheduleFoldFixture();
    const args = promoterScheduleFoldArgs(fixture);
    mutate(fixture, args);
    const before = fixture.harness.snapshot();
    await assert.rejects(invokeAtomically(foldReviewedPromoterScheduleDuplicate, fixture.harness, args), error, label);
    assert.deepEqual(fixture.harness.snapshot(), before, `${label} must leave the full transaction unchanged.`);
  }
}

async function qaSourceContracts() {
  const eventsSource = await readFile(new URL("../convex/events.ts", import.meta.url), "utf8");
  const protectedDomainSource = (
    await Promise.all(
      [
        "../convex/eventDomain/eventUpdates.ts",
        "../convex/eventDomain/lifecycleCommands.ts",
        "../convex/eventDomain/sourceOccurrenceCompatibility.ts",
        "../convex/internal/eventRepairs/reviewedContinuationFold.ts",
        "../convex/internal/eventRepairs/reviewedPromotionFold.ts",
        "../convex/internal/eventRepairs/reviewedScheduleFold.ts",
        "../convex/internal/eventRepairs/reviewedStructuredCorrections.ts",
      ].map((filePath) => readFile(new URL(filePath, import.meta.url), "utf8")),
    )
  ).join("\n");
  const receiptSource = await readFile(
    new URL("../convex/internal/sourceOccurrenceReceipts.ts", import.meta.url),
    "utf8",
  );
  const lineageSource = await readFile(
    new URL(
      "../lib/events/cross-post-campaign-aggregate-attestation.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const operatorSource = await readFile(
    new URL("./apply-reviewed-poster-venue-learning.mjs", import.meta.url),
    "utf8",
  );

  for (const exportName of [
    "foldReviewedCrossPostScheduleDuplicate",
    "foldReviewedStructuredPromotionVariant",
    "foldReviewedStructuredSameSourceContinuation",
  ]) {
    assert.match(
      eventsSource,
      new RegExp(`export const ${exportName} = mutation\\(`, "u"),
      `${exportName} must remain a dedicated mutation.`,
    );
  }
  for (const requiredContract of [
    "expectedPrimaryUpdatedAt",
    "expectedPrimaryNormalizedFieldsJson",
    "expectedPrimarySourceLinkId",
    "expectedPrimarySourceLinkUpdatedAt",
    "expectedContinuationUpdatedAt",
    "expectedContinuationNormalizedFieldsJson",
    "expectedContinuationSourceLinkId",
    "expectedContinuationSourceLinkUpdatedAt",
    "expectedIndependentUpdatedAt",
    "expectedIndependentNormalizedFieldsJson",
    "expectedIndependentSourceLinkId",
    "expectedIndependentSourceLinkUpdatedAt",
    "expectedReceiptId",
    "expectedReceiptUpdatedAt",
    "expectedSourceIdentity",
    "expectedSourceFingerprint",
    "expectedTargetVenueUpdatedAt",
    "expectedTargetVenueHandle",
    "nextIndependentTime",
    "independentPosterVenueEvidence",
    "independentPosterTimeEvidence",
    "independentPosterArtistEvidence",
  ]) {
    assert.match(
      eventsSource,
      new RegExp(`\\b${requiredContract}\\b`, "u"),
      `Missing reviewed-fold contract field ${requiredContract}.`,
    );
  }

  assert.match(lineageSource, /REVIEWED_PROMOTION_VARIANT_FOLD_FIELD/u);
  assert.match(lineageSource, /reviewedPromotionVariantFold/u);
  assert.match(lineageSource, /reviewedSameSourceContinuationFold/u);
  assert.match(lineageSource, /\[reviewed_promotion_variant:/u);
  assert.match(lineageSource, /\[reviewed_same_source_continuation:/u);

  const lineageGuardUses =
    protectedDomainSource.match(/isCrossPostCampaignLineageEvent\(/gu) ?? [];
  assert.ok(
    lineageGuardUses.length >= 8,
    "Reviewed-fold lineage must stay protected across generic update/delete/merge/backfill/receipt paths.",
  );
  assert.match(
    receiptSource,
    /Campaign occurrence receipts may only change through a dedicated re-attestation operation\./u,
  );
  assert.match(
    protectedDomainSource,
    /Campaign lineage events may only change through a dedicated re-attestation operation\./u,
  );
  assert.match(
    protectedDomainSource,
    /Campaign aggregates are retained with their audited source lineage and cannot be hard-deleted\./u,
  );
  assert.match(
    operatorSource,
    /operation\.kind === "reviewed_venue_repair"\s*\? operation\.before\s*: operation\.before\[key\]/u,
    "Reviewed venue repairs must compare the live full correction context with the full planned preimage.",
  );
  assert.match(
    operatorSource,
    /exactJson\(contextProjection\(context\), expectedPreimage\)/u,
    "Reviewed event-operation admission must use the kind-aware expected preimage.",
  );

  const queryRetryStart = operatorSource.indexOf(
    "const READ_QUERY_MAX_ATTEMPTS",
  );
  const queryRetryEnd = operatorSource.indexOf(
    "function normalizeText",
    queryRetryStart,
  );
  assert.ok(
    queryRetryStart >= 0 && queryRetryEnd > queryRetryStart,
    "The reviewed operator must retain one bounded read-query retry boundary.",
  );
  const queryRetrySource = operatorSource.slice(
    queryRetryStart,
    queryRetryEnd,
  );
  assert.equal(
    (operatorSource.match(/client\.query\(/gu) ?? []).length,
    1,
    "Every Convex query must pass through the centralized retry helper.",
  );
  assert.equal(
    (operatorSource.match(/\bqueryWithTransientRetry\(/gu) ?? []).length,
    9,
    "The retry helper must cover all eight reviewed-operator query sites.",
  );
  assert.match(queryRetrySource, /READ_QUERY_MAX_ATTEMPTS = 3/u);
  assert.match(queryRetrySource, /READ_QUERY_RETRY_BASE_DELAY_MS = 150/u);
  for (const transientSignal of [
    "server error",
    "terminated",
    "network",
    "socket",
    "fetch",
    "timeout",
    "aborterror",
    "aborted",
  ]) {
    assert.match(
      queryRetrySource,
      new RegExp(transientSignal, "iu"),
      `Missing transient query signal ${transientSignal}.`,
    );
  }
  assert.match(
    queryRetrySource,
    /if \(!text \|\| DETERMINISTIC_QUERY_ERROR_PATTERN\.test\(text\)\) return false;\s*return TRANSIENT_QUERY_ERROR_PATTERN\.test\(text\);/u,
    "Deterministic Convex application errors must always dominate transient-looking text.",
  );
  assert.match(
    queryRetrySource,
    /attempt >= READ_QUERY_MAX_ATTEMPTS/u,
    "Read-query retries must stop at the exact attempt cap.",
  );
  assert.match(
    queryRetrySource,
    /READ_QUERY_RETRY_BASE_DELAY_MS \* 2 \*\* \(attempt - 1\)/u,
    "Read-query retries must retain short bounded backoff.",
  );
  assert.doesNotMatch(
    queryRetrySource,
    /client\.mutation\(/u,
    "The read-query retry helper must never invoke mutations.",
  );
  assert.equal(
    (operatorSource.match(/client\.mutation\(/gu) ?? []).length,
    3,
    "The three reviewed mutation sites must remain direct and single-shot.",
  );
  assert.doesNotMatch(
    operatorSource,
    /(?:retry\w*mutation|mutation\w*retry)/iu,
    "Reviewed mutations must never acquire retry semantics.",
  );
}

try {
  await qaSourceContracts();
  await qaReviewedCrossPostScheduleAdversarialCases();
  await qaReviewedCrossPostScheduleFold();
  await qaSkiAdversarialCases();
  await qaSkiFold();
  await qaBenAdversarialCases();
  await qaBenFold();
  await qaReviewedPromoterScheduleFoldAdversarialCases();
  await qaReviewedPromoterScheduleFold();
  console.log(
    "QA passed: reviewed folds preserve receipt keys, source links, optimistic revisions, grounding, saves, and immutable lineage.",
  );
} finally {
  Date.now = originalDateNow;
  if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousCronSecret;
  if (previousAdminIds === undefined) delete process.env.ADMIN_CLERK_USER_IDS;
  else process.env.ADMIN_CLERK_USER_IDS = previousAdminIds;
}
