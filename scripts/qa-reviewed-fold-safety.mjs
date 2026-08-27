import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import * as eventFunctions from "../convex/events.ts";
import { isCanonicallyGroundedApprovedEvent } from "../convex/publicEventGrounding.ts";
import { isCrossPostCampaignLineageEvent } from "../lib/events/cross-post-campaign-aggregate-attestation.ts";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../lib/events/source-occurrence-representation.ts";

const {
  deleteApprovedEvent,
  foldReviewedStructuredPromotionVariant,
  foldReviewedStructuredSameSourceContinuation,
  mergeApprovedEvents,
  updateEvent,
} = eventFunctions;

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
    "scrapedPosts",
    "mediaAssets",
    "venues",
    "savedEvents",
    "userSavedEvents",
    "eventAuditLog",
    "eventRetentionCursors",
  ];
  const tables = Object.fromEntries(
    tableNames.map((table) => [
      table,
      new Map((seed[table] ?? []).map((row) => [row._id, clone(row)])),
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

async function qaSourceContracts() {
  const eventsSource = await readFile(new URL("../convex/events.ts", import.meta.url), "utf8");
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

  const lineageGuardUses = eventsSource.match(/isCrossPostCampaignLineageEvent\(/gu) ?? [];
  assert.ok(
    lineageGuardUses.length >= 8,
    "Reviewed-fold lineage must stay protected across generic update/delete/merge/backfill/receipt paths.",
  );
  assert.match(
    eventsSource,
    /Campaign occurrence receipts may only change through a dedicated re-attestation operation\./u,
  );
  assert.match(
    eventsSource,
    /Campaign lineage events may only change through a dedicated re-attestation operation\./u,
  );
  assert.match(
    eventsSource,
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
}

try {
  await qaSourceContracts();
  await qaSkiAdversarialCases();
  await qaSkiFold();
  await qaBenAdversarialCases();
  await qaBenFold();
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
