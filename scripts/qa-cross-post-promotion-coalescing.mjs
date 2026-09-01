import assert from "node:assert/strict";

import {
  backfillEventVenueIdentityBatch,
  coalesceApprovedCrossPostPromotionOccurrences,
  deleteApprovedEvent,
  deleteExpiredEvents,
  getCrossPostPromotionCoalescingContext,
  getInstagramSourceOccurrenceReceipt,
  getPublicApprovedEvent,
  mergeApprovedEvents,
  reconcileInstagramSourceOccurrenceReceipt,
  recordInstagramSourceOccurrenceSatisfaction,
  updateEvent,
  updateSourceOccurrenceExpectedCount,
} from "../convex/events.ts";
import {
  refreshAndAttach,
  removeMissingAsset,
} from "../convex/mediaAssets.ts";
import { isCanonicallyGroundedApprovedEvent } from "../convex/publicEventGrounding.ts";
import {
  buildCrossPostPromotionCoalescingPlan,
  deriveExclusiveHashtagCrossPostCampaignIdentity,
} from "../lib/events/cross-post-promotion-coalescing.ts";
import { exactJsonValue } from "../lib/events/exact-json-value.ts";
import { buildInstagramSourceOccurrenceFingerprint } from "../lib/domain/occurrences/source-fingerprint.ts";
import { reattestCampaignLineageBatch } from "../convex/internal/migrations/campaignLineage.ts";
import {
  backfillEventVenueBindingsBatch,
  backfillSourceOccurrencesBatch,
} from "../convex/internal/migrations/eventDomain.ts";

process.env.CRON_SECRET = "qa-cross-post-promotion-secret";
process.env.ADMIN_CLERK_USER_IDS = "qa-merge-admin";

const QA_NOW_MS = new Date("2026-08-25T12:00:00.000Z").getTime();
Date.now = () => QA_NOW_MS;

function canonicalizeJsonObjectKeyOrder(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonObjectKeyOrder);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeJsonObjectKeyOrder(value[key])]),
    );
  }
  return value;
}

assert.equal(
  exactJsonValue(
    { beta: [{ key: "same", eventId: "event-1" }], alpha: 1 },
    { alpha: 1, beta: [{ eventId: "event-1", key: "same" }] },
  ),
  true,
  "Exact JSON equality must ignore object member order at every depth.",
);
assert.equal(
  exactJsonValue(
    { beta: [{ key: "same", eventId: "event-1" }], alpha: 1 },
    { alpha: 1, beta: [{ eventId: "event-2", key: "same" }] },
  ),
  false,
  "Exact JSON equality must still reject a changed scalar value.",
);

const venue = {
  _id: "venue-kc-grad",
  _creationTime: 1,
  name: "KC Grad",
  instagramHandle: "kcgrad",
  normalizedInstagramHandle: "kcgrad",
  category: "nightlife",
  location: "Brace Krsmanovic 4, Beograd",
  publicStatus: "published",
  scrapeActive: true,
  createdAt: 1,
  updatedAt: 700,
};

const wrongVenue = {
  ...venue,
  _id: "venue-wrong-target",
  name: "Wrong Target Venue",
  instagramHandle: "wrong_target_venue",
  normalizedInstagramHandle: "wrong_target_venue",
  updatedAt: 701,
};

const arianaRows = [
  {
    id: "j57ca0raa1kwb5jn9h6d9m2j3d8cxqs0",
    postId: "3967911301089596424",
    shortcode: "DcQ2k4xtBQI",
    title: "Ariana Grande theme party",
    venue: "KC Grad",
    venueId: venue._id,
    venueInstagramHandle: "kcgrad",
    artists: ["Aleksandarscala"],
    description: 'Theme party celebrating Ariana Grande\'s new album "Petal".',
    ticketPrice: "Prvih sat vremena ulaz: 500 din | nakon toga: 700 din",
    imageUrl:
      "https://convex-events.ineedtofeedmyrabbit.com/api/storage/04ee0990-2f81-4691-a7a2-f9e9501be0ed",
    imageStorageId: "storage-primary-ariana-poster",
    caption:
      "ARIANA GRANDE THEME PARTY | 26. avgust | KC Grad | Start 20h\n#1by1 #kcgrad #arianagrande #petal #party",
  },
  {
    id: "j57dj4519x0nht30daj7wchag98d49af",
    postId: "3970947426305708478",
    shortcode: "Dcbo6UutBG-",
    title: "Wednesday Night at KC Gradu",
    venue: "KC Gradu",
    artists: [],
    description: "Ariana Grande fan party/gathering.",
    caption:
      "Ako si i ti Ari fan, vidimo se u sredu 26.avgusta od 20h u KC Gradu. #1by1 #arianagrande #petal",
  },
  {
    id: "j57a40ecfr5k7jx7rb529f62n98d6xsj",
    postId: "3971716841827286414",
    shortcode: "DceX2yxjT2O",
    title: "Choose your fav Ari era fit",
    venue: "JEDNA PO JEDNA",
    venueId: "venue-promoter",
    venueInstagramHandle: "1by1.party",
    artists: [],
    description: "Ari-era themed party.",
    caption:
      "Izaberi fit iz svoje omiljene Ari ere i vidimo se sutra od 20h @kcgrad. #1by1 #arianagrande #petal",
  },
  {
    id: "j57cct77x5x10ye8r47jyedcnd8cynj1",
    postId: "3968674081415192233",
    shortcode: "DcTkAzUDV6p",
    title: "Ariana Grande zurku",
    venue: "JEDNA PO JEDNA",
    venueId: "venue-promoter",
    venueInstagramHandle: "1by1.party",
    artists: [],
    description: "Giveaway and Ariana Grande themed party.",
    caption:
      "Petal giveaway: dodjite na Ariana Grande zurku 26. avgusta od 20h. #1by1 #kcgrad #arianagrande #petal",
  },
  {
    id: "j57710qswq1wzhvwkz2anpwws58d1w9t",
    postId: "3969372526868878572",
    shortcode: "DcWC0hVNtTs",
    title: "Ariana zurku",
    venue: "",
    artists: [],
    description: "Ariana zurku sa novim albumom.",
    caption:
      "Trazili ste Ariana zurku i dobili ste je. Vidimo se @kcgrad 26.avgusta od 20h! #1by1 #arianagrande #petal",
    imageUrl:
      "https://convex-events.ineedtofeedmyrabbit.com/api/storage/ef7456d9-5fe8-4b96-96f3-81d7c8b49c64",
    imageStorageId: "storage-ariana-poster",
  },
];

function normalizedFields(row) {
  return JSON.stringify({
    extractionContractVersion: "legacy_qa_fixture_v1",
    dateEvidenceVerified: true,
    dateSuspiciousYear: false,
    humanReviewedLegacySourcePolicyVersion: 1,
    moderationPendingReasons: ["requires_human_approval"],
    normalizedIsValid: true,
    timeEvidenceVerified: true,
    sourceGroundingEvidence: "instagram_caption",
    sourceGroundingInstagramHandle: "1by1.party",
    sourceGroundingInstagramPostId: row.postId,
    sourceGroundingInstagramPostUrl: `https://www.instagram.com/p/${row.shortcode}/`,
    sourceGroundingSourceCaption: row.caption,
    sourceGroundingSourceKind: "caption",
    sourceGroundingVersion: 4,
    title: row.title,
    titleUsedFallback: false,
    normalizedDate: "2026-08-26",
    time: "20:00",
    normalizedVenue: row.venue,
    artists: row.artists,
  });
}

function buildEvent(row, index) {
  const occurrenceKey = `instagram-occurrence-v2:ariana-${index}`;
  return {
    _id: row.id,
    _creationTime: 10 + index,
    title: row.title,
    date: "2026-08-26",
    time: "20:00",
    timeSource: "caption",
    timeEvidenceText: "od 20h",
    timeConfidence: 0.95,
    timeStatus: "confirmed",
    timeEvidenceKind: "start_time_stated",
    dateEvidenceText: "26. avgusta",
    dateEvidenceSource: "caption",
    dateEvidenceIsRelative: false,
    dateEvidenceResolvedDate: "2026-08-26",
    sourceConflictFields: [],
    venue: row.venue,
    venueId: row.venueId,
    venueInstagramHandle: row.venueInstagramHandle,
    artists: row.artists,
    description: row.description,
    ticketPrice: row.ticketPrice,
    imageUrl: row.imageUrl,
    imageStorageId: row.imageStorageId,
    instagramPostId: row.postId,
    instagramPostUrl: `https://www.instagram.com/p/${row.shortcode}/`,
    sourceCaption: row.caption,
    sourcePostedAt: `2026-08-${20 + index}T12:00:00.000Z`,
    rawExtractionJson: JSON.stringify({
      extraction_contract_version: "legacy_qa_fixture_v1",
      is_event: true,
    }),
    humanReviewedLegacySourcePolicyVersion: 1,
    reviewedAt: 250 + index,
    reviewedBy: "QA moderator",
    moderationNote: "Human reviewed this exact persisted Instagram campaign post.",
    normalizedFieldsJson: normalizedFields(row),
    sourceOccurrenceKey: occurrenceKey,
    eventType: "nightlife",
    status: "approved",
    createdAt: 100 + index,
    updatedAt: 300 + index,
  };
}

function buildLink(event, row, index) {
  return {
    _id: `ariana-link-${index}`,
    eventId: event._id,
    sourceIdentity: `instagram-source-identity-v1:${row.shortcode}`,
    sourceFingerprint: `instagram-source-v2:ariana-${index}`,
    sourceOccurrenceKey: event.sourceOccurrenceKey,
    instagramPostId: event.instagramPostId,
    instagramPostUrl: event.instagramPostUrl,
    canonicalSourceUrl: event.instagramPostUrl,
    sourceOccurrenceId: `ariana-source-occurrence-${index}`,
    sourceHandle: "1by1.party",
    linkedAt: 50 + index,
    updatedAt: 100 + index,
  };
}

function buildReceipt(event, link, index) {
  return {
    _id: `ariana-receipt-${index}`,
    sourceIdentity: link.sourceIdentity,
    sourceFingerprint: link.sourceFingerprint,
    expectedKeys: [event.sourceOccurrenceKey],
    expectedOccurrences: [
      {
        key: event.sourceOccurrenceKey,
        date: event.date,
        time: event.time,
        venue: event.venue,
        title: event.title,
        artists: event.artists,
      },
    ],
    satisfiedKeys: [event.sourceOccurrenceKey],
    deferredChildCount: 0,
    deferredChildKeys: [],
    satisfiedOccurrences: [{ key: event.sourceOccurrenceKey, eventId: event._id }],
    createdAt: 200 + index,
    updatedAt: 200 + index,
  };
}

function makeDb() {
  const events = arianaRows.map(buildEvent);
  const links = events.map((event, index) => buildLink(event, arianaRows[index], index));
  const receipts = events.map((event, index) => buildReceipt(event, links[index], index));
  const sourceOccurrences = events.map((event, index) => ({
    _id: `ariana-source-occurrence-${index}`,
    _creationTime: 1,
    provider: "instagram",
    sourceDocumentId: `ariana-scraped-post-${index}`,
    sourceIdentity: links[index].sourceIdentity,
    canonicalSourceUrl: event.instagramPostUrl,
    sourceFingerprint: links[index].sourceFingerprint,
    sourceRevision: 1,
    sourceOccurrenceKey: event.sourceOccurrenceKey,
    occurrenceOrdinal: 0,
    factsJson: "{}",
    normalizedOccurrenceJson: "{}",
    venueResolutionStatus: "resolved",
    canonicalEventId: event._id,
    state: "satisfied",
    createdAt: 1,
    updatedAt: 1,
  }));
  const tables = {
    events: new Map(events.map((row) => [row._id, structuredClone(row)])),
    instagramEventSources: new Map(links.map((row) => [row._id, structuredClone(row)])),
    instagramSourceOccurrenceReceipts: new Map(
      receipts.map((row) => [row._id, structuredClone(row)]),
    ),
    scrapedPosts: new Map(
      events.map((event, index) => [
        `ariana-scraped-post-${index}`,
        {
          _id: `ariana-scraped-post-${index}`,
          _creationTime: 1,
          handle: "1by1.party",
          username: "1by1.party",
          postId: event.instagramPostId,
          instagramPostUrl: event.instagramPostUrl,
          caption: event.sourceCaption,
          postedAt: event.sourcePostedAt,
          sourceRevision: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    ),
    venues: new Map([
      [venue._id, structuredClone(venue)],
      [wrongVenue._id, structuredClone(wrongVenue)],
    ]),
    mediaAssets: new Map(),
    savedEvents: new Map([
      [
        "saved-primary",
        { _id: "saved-primary", userId: "same-user", eventId: events[0]._id, createdAt: 1 },
      ],
      [
        "saved-dedupe",
        { _id: "saved-dedupe", userId: "same-user", eventId: events[1]._id, createdAt: 2 },
      ],
      [
        "saved-move",
        { _id: "saved-move", userId: "move-user", eventId: events[2]._id, createdAt: 3 },
      ],
    ]),
    userSavedEvents: new Map([
      [
        "legacy-primary",
        { _id: "legacy-primary", userId: "legacy-same", eventId: events[0]._id, savedAt: 1 },
      ],
      [
        "legacy-dedupe",
        { _id: "legacy-dedupe", userId: "legacy-same", eventId: events[3]._id, savedAt: 2 },
      ],
      [
        "legacy-move",
        { _id: "legacy-move", userId: "legacy-move", eventId: events[4]._id, savedAt: 3 },
      ],
    ]),
    sourceOccurrences: new Map(
      sourceOccurrences.map((row) => [row._id, structuredClone(row)]),
    ),
    sourceOccurrenceTopologyEpoch: new Map([
      [
        "cross-post-source-occurrence-topology-epoch",
        {
          _id: "cross-post-source-occurrence-topology-epoch",
          key: "source-occurrence-topology-v1",
          currentEpoch: 0,
          verifiedEpoch: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    ]),
    eventAuditLog: new Map(),
    campaignLineageReattestations: new Map(),
    eventDomainMigrationState: new Map([
      [
        "venue-identities-v1",
        {
          _id: "venue-identities-v1",
          _creationTime: 1,
          completedAt: 1,
          createdAt: 1,
          errorCount: 0,
          isDone: true,
          key: "venue-identities-v1",
          mismatchCount: 0,
          phase: "venue_identities",
          scannedCount: 1,
          updatedAt: 1,
          updatedCount: 1,
        },
      ],
    ]),
    venueIdentities: new Map([
      [
        "kc-grad-canonical-identity",
        {
          _id: "kc-grad-canonical-identity",
          _creationTime: 1,
          active: true,
          createdAt: 1,
          kind: "canonical_name",
          normalizedValue: "kc grad",
          rawValue: "KC Grad",
          source: "venue_record",
          updatedAt: 1,
          venueId: venue._id,
        },
      ],
      [
        "kc-grad-provider-identity",
        {
          _id: "kc-grad-provider-identity",
          _creationTime: 1,
          active: true,
          createdAt: 1,
          kind: "provider_account",
          normalizedValue: "kcgrad",
          provider: "instagram",
          rawValue: "kcgrad",
          source: "venue_record",
          updatedAt: 1,
          venueId: venue._id,
        },
      ],
    ]),
  };
  let auditCounter = 0;
  let sourceOccurrenceCounter = 0;
  let migrationCounter = 0;
  const rows = (table) => [...(tables[table]?.values() ?? [])];
  const result = (table, filters = []) => {
    const matches = () =>
      rows(table).filter((row) => filters.every((filter) => filter(row)));
    return {
      order() {
        return this;
      },
      async collect() {
        return matches();
      },
      async take(limit) {
        return matches().slice(0, limit);
      },
      async unique() {
        const found = matches();
        if (found.length > 1) throw new Error(`Expected unique ${table} row.`);
        return found[0] ?? null;
      },
      async first() {
        return matches()[0] ?? null;
      },
      async paginate(options) {
        const page = matches().slice(0, options.numItems);
        return {
          page,
          isDone: page.length === matches().length,
          continueCursor: page.length === matches().length ? "" : "qa-next-cursor",
        };
      },
    };
  };
  const query = (table) => ({
    ...result(table),
    withIndex(_index, configure) {
      const filters = [];
      const builder = {
        eq(field, value) {
          filters.push((row) => row[field] === value);
          return builder;
        },
        lt(field, value) {
          filters.push((row) => row[field] < value);
          return builder;
        },
        gte(field, value) {
          filters.push((row) => row[field] >= value);
          return builder;
        },
      };
      configure(builder);
      return result(table, filters);
    },
  });
  return {
    tables,
    events,
    links,
    receipts,
    db: {
      normalizeId(table, id) {
        return tables[table]?.has(id) ? id : null;
      },
      async get(id) {
        if (id === "not-a-convex-id") {
          throw new Error("The fake Convex DB rejects malformed document IDs.");
        }
        for (const table of Object.values(tables)) {
          if (table.has(id)) return table.get(id);
        }
        return null;
      },
      query,
      async patch(id, patch) {
        for (const table of Object.values(tables)) {
          if (!table.has(id)) continue;
          table.set(id, { ...table.get(id), ...structuredClone(patch) });
          return;
        }
        throw new Error(`Missing row ${id}.`);
      },
      async delete(id) {
        for (const table of Object.values(tables)) {
          if (table.delete(id)) return;
        }
        throw new Error(`Missing row ${id}.`);
      },
      async insert(table, value) {
        if (table === "sourceOccurrences") {
          sourceOccurrenceCounter += 1;
          const id = `cross-post-source-occurrence-${sourceOccurrenceCounter}`;
          tables.sourceOccurrences.set(id, {
            _id: id,
            _creationTime: Date.now(),
            ...structuredClone(value),
          });
          return id;
        }
        if (
          table === "campaignLineageReattestations" ||
          table === "eventDomainMigrationState"
        ) {
          migrationCounter += 1;
          const id = `${table}-${migrationCounter}`;
          tables[table].set(id, {
            _id: id,
            _creationTime: Date.now(),
            ...structuredClone(value),
          });
          return id;
        }
        assert.equal(table, "eventAuditLog");
        auditCounter += 1;
        const id = `cross-post-audit-${auditCounter}`;
        tables.eventAuditLog.set(id, {
          _id: id,
          _creationTime: Date.now(),
          ...structuredClone(value),
        });
        return id;
      },
    },
  };
}

function serviceCtx(state) {
  return {
    auth: { getUserIdentity: async () => null },
    db: state.db,
  };
}

function canonicalizePersistedCrossPostSourceRows(state) {
  for (const table of [
    "instagramEventSources",
    "instagramSourceOccurrenceReceipts",
  ]) {
    for (const [id, row] of state.tables[table]) {
      state.tables[table].set(id, canonicalizeJsonObjectKeyOrder(row));
    }
  }
}

function candidateVersion(state, index) {
  const event = state.events[index];
  const link = state.links[index];
  const receipt = state.receipts[index];
  return {
    id: event._id,
    expectedUpdatedAt: event.updatedAt,
    expectedNormalizedFieldsJson: event.normalizedFieldsJson,
    expectedSourceLinkId: link._id,
    expectedSourceLinkUpdatedAt: link.updatedAt,
    expectedSourceIdentity: link.sourceIdentity,
    expectedSourceFingerprint: link.sourceFingerprint,
    expectedOccurrenceKey: event.sourceOccurrenceKey,
    expectedReceiptId: receipt._id,
    expectedReceiptUpdatedAt: receipt.updatedAt,
  };
}

function liveCandidateVersion(state, eventId) {
  const event = state.tables.events.get(eventId);
  const link = [...state.tables.instagramEventSources.values()].find(
    (candidate) => candidate.eventId === eventId,
  );
  const receipt = [...state.tables.instagramSourceOccurrenceReceipts.values()].find(
    (candidate) => candidate.sourceIdentity === link?.sourceIdentity,
  );
  assert.ok(event && link && receipt);
  return {
    id: event._id,
    expectedUpdatedAt: event.updatedAt,
    expectedNormalizedFieldsJson: event.normalizedFieldsJson,
    expectedSourceLinkId: link._id,
    expectedSourceLinkUpdatedAt: link.updatedAt,
    expectedSourceIdentity: link.sourceIdentity,
    expectedSourceFingerprint: link.sourceFingerprint,
    expectedOccurrenceKey: event.sourceOccurrenceKey,
    expectedReceiptId: receipt._id,
    expectedReceiptUpdatedAt: receipt.updatedAt,
  };
}

function validArgs(state) {
  return {
    operationId: "cross-post-promotion:ariana-kc-grad-2026-08-26",
    primary: candidateVersion(state, 0),
    duplicates: [1, 2, 3, 4].map((index) => candidateVersion(state, index)),
    targetVenueId: venue._id,
    expectedTargetVenueUpdatedAt: venue.updatedAt,
    sharedEvidenceAnchors: ["arianagrande", "petal"],
    moderationNote:
      "Reviewed five posts from one promoter: same Ariana party, KC Grad, date, and start time.",
    serviceSecret: process.env.CRON_SECRET,
  };
}

function exclusiveCampaignIdentity(state, eventIds) {
  const events = eventIds.map((eventId) => state.tables.events.get(eventId));
  return deriveExclusiveHashtagCrossPostCampaignIdentity({
    sourceHandle: "1by1.party",
    targetVenueId: venue._id,
    date: "2026-08-26",
    time: "20:00",
    eventType: "nightlife",
    anchors: ["arianagrande", "petal"],
    candidatePostIds: events.map((event) => event.instagramPostId),
    historyPosts: [...state.tables.scrapedPosts.values()].map((post) => ({
      handle: post.handle,
      postId: post.postId,
      caption: post.caption,
      postedAt: post.postedAt,
    })),
    historyComplete: true,
  });
}

async function makeLegacyMarkerOnlyAggregateState(options = {}) {
  const legacyState = makeDb();
  if (options.missingHashtagOnlyVenue) {
    const index = 3;
    const event = structuredClone(legacyState.events[index]);
    event.venue = "";
    delete event.venueId;
    delete event.venueInstagramHandle;
    event.normalizedFieldsJson = JSON.stringify({
      ...JSON.parse(event.normalizedFieldsJson),
      normalizedVenue: "",
    });
    legacyState.events[index] = event;
    legacyState.tables.events.set(event._id, structuredClone(event));
    const receipt = structuredClone(legacyState.receipts[index]);
    receipt.expectedOccurrences[0].venue = "";
    legacyState.receipts[index] = receipt;
    legacyState.tables.instagramSourceOccurrenceReceipts.set(
      receipt._id,
      structuredClone(receipt),
    );
  }
  await coalesceApprovedCrossPostPromotionOccurrences._handler(
    serviceCtx(legacyState),
    validArgs(legacyState),
  );
  const primary = legacyState.tables.events.get(arianaRows[0].id);
  const primaryFields = JSON.parse(primary.normalizedFieldsJson);
  delete primaryFields.crossPostCampaignAggregateAttestation;
  legacyState.tables.events.set(primary._id, {
    ...primary,
    normalizedFieldsJson: JSON.stringify(primaryFields),
  });
  for (const [auditId, audit] of legacyState.tables.eventAuditLog) {
    const patch = JSON.parse(audit.patchJson);
    delete patch.sourceGroundingVerifiedAtCoalescing;
    delete patch.aggregateAttestation;
    legacyState.tables.eventAuditLog.set(auditId, {
      ...audit,
      patchJson: JSON.stringify(patch),
    });
  }
  canonicalizePersistedCrossPostSourceRows(legacyState);
  return legacyState;
}

function purePlanCandidates(overrides = {}) {
  return arianaRows.map((row, index) => ({
    id: row.id,
    sourceHandle: "1by1.party",
    sourceIdentity: `identity-${index}`,
    sourceOccurrenceKey: `key-${index}`,
    instagramPostId: row.postId,
    instagramPostUrl: `https://www.instagram.com/p/${row.shortcode}/`,
    title: row.title,
    date: "2026-08-26",
    time: "20:00",
    timeStatus: "confirmed",
    timeEvidenceKind: "start_time_stated",
    timeConfidence: 0.95,
    dateEvidenceVerified: true,
    timeEvidenceVerified: true,
    venueEvidenceText: row.caption,
    eventType: "nightlife",
    sourceConflictFields: [],
    artists: row.artists,
    description: row.description,
    ticketPrice: row.ticketPrice,
    imageUrl: row.imageUrl,
    imageStorageId: row.imageStorageId,
    ...(overrides[index] ?? {}),
  }));
}

const pureOptions = {
  candidates: purePlanCandidates(),
  canonicalVenueName: venue.name,
  canonicalVenueHandle: venue.instagramHandle,
  sharedAnchors: ["arianagrande", "petal"],
  preferredImageCandidateId: arianaRows[4].id,
};
const purePlan = buildCrossPostPromotionCoalescingPlan(pureOptions);
assert.ok(purePlan, "The five reviewed Ariana/KC Grad posts must form one exact plan.");
assert.deepEqual(purePlan.artists, ["Aleksandarscala"]);
assert.equal(purePlan.ticketPrice, arianaRows[0].ticketPrice);
assert.equal(purePlan.imageSourceCandidateId, arianaRows[4].id);

assert.equal(
  buildCrossPostPromotionCoalescingPlan({
    ...pureOptions,
    candidates: purePlanCandidates({ 4: { time: "21:00" } }),
  }),
  null,
  "A different start time must remain distinct.",
);
assert.equal(
  buildCrossPostPromotionCoalescingPlan({
    ...pureOptions,
    candidates: purePlanCandidates({
      4: { venueEvidenceText: "Ariana Grande Petal party at a different location." },
    }),
  }),
  null,
  "A post without target-venue evidence must remain distinct.",
);
assert.equal(
  buildCrossPostPromotionCoalescingPlan({
    ...pureOptions,
    candidates: purePlanCandidates({
      4: {
        venueEvidenceText:
          "Ariana Grande Petal party at @kcgradnja on 26 August at 20h.",
      },
    }),
  }),
  null,
  "A longer near-match handle must not satisfy exact @kcgrad evidence.",
);
assert.equal(
  buildCrossPostPromotionCoalescingPlan({
    ...pureOptions,
    candidates: purePlanCandidates({
      4: { venueEvidenceText: "BTS Arirang party at @kcgrad on 26 August at 20h." },
    }),
  }),
  null,
  "A different theme must not join merely because venue, date, and time match.",
);
assert.equal(
  buildCrossPostPromotionCoalescingPlan({
    ...pureOptions,
    sharedAnchors: ["arianagrande"],
  }),
  null,
  "One shared anchor is insufficient proof.",
);

const staleState = makeDb();
const staleBefore = structuredClone(
  Object.fromEntries(
    Object.entries(staleState.tables).map(([table, rows]) => [table, [...rows.values()]]),
  ),
);
const staleArgs = validArgs(staleState);
await assert.rejects(
  () =>
    coalesceApprovedCrossPostPromotionOccurrences._handler(serviceCtx(staleState), {
      ...staleArgs,
      primary: {
        ...staleArgs.primary,
        expectedUpdatedAt: staleArgs.primary.expectedUpdatedAt + 1,
      },
    }),
  /event precondition failed/i,
);
assert.deepEqual(
  Object.fromEntries(
    Object.entries(staleState.tables).map(([table, rows]) => [table, [...rows.values()]]),
  ),
  staleBefore,
  "A stale event version must fail before any write.",
);

for (const staleSourceVersion of ["link", "receipt"]) {
  const staleSourceState = makeDb();
  const before = structuredClone(
    Object.fromEntries(
      Object.entries(staleSourceState.tables).map(([table, rows]) => [
        table,
        [...rows.values()],
      ]),
    ),
  );
  const args = validArgs(staleSourceState);
  const duplicate = args.duplicates[0];
  const staleDuplicate =
    staleSourceVersion === "link"
      ? {
          ...duplicate,
          expectedSourceLinkUpdatedAt: duplicate.expectedSourceLinkUpdatedAt + 1,
        }
      : {
          ...duplicate,
          expectedReceiptUpdatedAt: duplicate.expectedReceiptUpdatedAt + 1,
        };
  await assert.rejects(
    () =>
      coalesceApprovedCrossPostPromotionOccurrences._handler(
        serviceCtx(staleSourceState),
        {
          ...args,
          duplicates: [staleDuplicate, ...args.duplicates.slice(1)],
        },
      ),
    staleSourceVersion === "link"
      ? /source-link precondition failed/i
      : /receipt precondition failed/i,
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(staleSourceState.tables).map(([table, rows]) => [
        table,
        [...rows.values()],
      ]),
    ),
    before,
    `A stale ${staleSourceVersion} version must fail before any write.`,
  );
}

const aggregateMismatchState = makeDb();
const aggregateMismatchEvent = structuredClone(aggregateMismatchState.events[1]);
aggregateMismatchEvent.artists = ["Unexpected Guest"];
aggregateMismatchEvent.normalizedFieldsJson = JSON.stringify({
  ...JSON.parse(aggregateMismatchEvent.normalizedFieldsJson),
  artists: aggregateMismatchEvent.artists,
});
aggregateMismatchState.events[1] = aggregateMismatchEvent;
aggregateMismatchState.tables.events.set(
  aggregateMismatchEvent._id,
  structuredClone(aggregateMismatchEvent),
);
const aggregateMismatchReceipt = structuredClone(aggregateMismatchState.receipts[1]);
aggregateMismatchReceipt.expectedOccurrences[0].artists = ["Unexpected Guest"];
aggregateMismatchState.receipts[1] = aggregateMismatchReceipt;
aggregateMismatchState.tables.instagramSourceOccurrenceReceipts.set(
  aggregateMismatchReceipt._id,
  structuredClone(aggregateMismatchReceipt),
);
await coalesceApprovedCrossPostPromotionOccurrences._handler(
  serviceCtx(aggregateMismatchState),
  validArgs(aggregateMismatchState),
);
const distinctArtistAggregate = aggregateMismatchState.tables.events.get(
  arianaRows[0].id,
);
assert.deepEqual(distinctArtistAggregate.artists, [
  "Aleksandarscala",
  "Unexpected Guest",
]);
assert.equal(
  await isCanonicallyGroundedApprovedEvent(
    serviceCtx(aggregateMismatchState),
    distinctArtistAggregate,
  ),
  true,
  "Exact candidate source snapshots and audits must ground a public multi-source artist union.",
);
for (const originalReceipt of aggregateMismatchState.receipts) {
  const live = await getInstagramSourceOccurrenceReceipt._handler(
    serviceCtx(aggregateMismatchState),
    {
      sourceIdentity: originalReceipt.sourceIdentity,
      serviceSecret: process.env.CRON_SECRET,
    },
  );
  assert.deepEqual(live.satisfiedKeys, originalReceipt.expectedKeys);
  assert.equal(live.satisfiedOccurrences[0]?.eventId, arianaRows[0].id);
}

const canonicalPersistenceState = makeDb();
await coalesceApprovedCrossPostPromotionOccurrences._handler(
  serviceCtx(canonicalPersistenceState),
  validArgs(canonicalPersistenceState),
);
canonicalizePersistedCrossPostSourceRows(canonicalPersistenceState);
const canonicalPersistencePrimary =
  canonicalPersistenceState.tables.events.get(arianaRows[0].id);
assert.equal(
  await isCanonicallyGroundedApprovedEvent(
    serviceCtx(canonicalPersistenceState),
    canonicalPersistencePrimary,
  ),
  true,
  "Convex object-key canonicalization must not invalidate an exact aggregate audit.",
);
assert.equal(
  (
    await getCrossPostPromotionCoalescingContext._handler(
      serviceCtx(canonicalPersistenceState),
      {
        operationId: validArgs(canonicalPersistenceState).operationId,
        eventIds: arianaRows.map((row) => row.id),
        targetVenueId: venue._id,
        serviceSecret: process.env.CRON_SECRET,
      },
    )
  ).state,
  "already_coalesced",
  "Stored key order must not invalidate an exact completed coalescing state.",
);

const missingPrimarySourceState = makeDb();
missingPrimarySourceState.tables.scrapedPosts.delete("ariana-scraped-post-0");
await assert.rejects(
  () =>
    coalesceApprovedCrossPostPromotionOccurrences._handler(
      serviceCtx(missingPrimarySourceState),
      validArgs(missingPrimarySourceState),
    ),
  /individually source-grounded/i,
  "A missing canonical persisted source must block the retained public event.",
);

const legacyMarkerState = await makeLegacyMarkerOnlyAggregateState({
  missingHashtagOnlyVenue: true,
});
const migrationOperationId =
  "auto-cross-post-v1:7777777777777777777777777777777777777777";
const legacyOperationId = validArgs(legacyMarkerState).operationId;
const migrationIdentity = exclusiveCampaignIdentity(
  legacyMarkerState,
  arianaRows.map((row) => row.id),
);
assert.match(
  migrationIdentity ?? "",
  /^instagram-exclusive-hashtag-campaign-v1:/,
);
const migrationContextArgs = {
  operationId: migrationOperationId,
  legacyMigrationOperationId: legacyOperationId,
  eventIds: arianaRows.map((row) => row.id),
  targetVenueId: venue._id,
  serviceSecret: process.env.CRON_SECRET,
};
assert.equal(
  (
    await getCrossPostPromotionCoalescingContext._handler(
      serviceCtx(legacyMarkerState),
      migrationContextArgs,
    )
  ).state,
  "legacy_migration_ready",
  "The service context must expose an exact, bounded R1 marker-only migration after proving every original audit/link/receipt.",
);
const legacyLinksBeforeMigration = structuredClone([
  ...legacyMarkerState.tables.instagramEventSources.values(),
]);
const legacyEventsBeforeMigration = structuredClone([
  ...legacyMarkerState.tables.events.values(),
]);
const legacyReceiptsBeforeMigration = structuredClone([
  ...legacyMarkerState.tables.instagramSourceOccurrenceReceipts.values(),
]);
const legacyAuditsBeforeMigration = new Map(
  [...legacyMarkerState.tables.eventAuditLog].map(([id, audit]) => [
    id,
    structuredClone(audit),
  ]),
);
await coalesceApprovedCrossPostPromotionOccurrences._handler(
  serviceCtx(legacyMarkerState),
  {
    operationId: migrationOperationId,
    legacyMigrationOperationId: legacyOperationId,
    primary: liveCandidateVersion(legacyMarkerState, arianaRows[0].id),
    duplicates: arianaRows
      .slice(1)
      .map((row) => liveCandidateVersion(legacyMarkerState, row.id)),
    targetVenueId: venue._id,
    expectedTargetVenueUpdatedAt: venue.updatedAt,
    sharedEvidenceAnchors: ["arianagrande", "petal"],
    automaticCampaignIdentity: migrationIdentity,
    moderationNote:
      "Audit-backed migration of the exact five-row R1 Ariana campaign into the durable automatic aggregate.",
    serviceSecret: process.env.CRON_SECRET,
  },
);
const migratedPrimary = legacyMarkerState.tables.events.get(arianaRows[0].id);
const migratedAttestation = JSON.parse(
  migratedPrimary.normalizedFieldsJson,
).crossPostCampaignAggregateAttestation;
assert.equal(migratedAttestation.lineageDepth, 1);
assert.equal(migratedAttestation.totalSourceCount, 5);
assert.equal(migratedAttestation.automaticCampaignIdentity, migrationIdentity);
for (const field of [
  "title",
  "date",
  "time",
  "venue",
  "venueId",
  "venueInstagramHandle",
  "artists",
  "description",
  "ticketPrice",
  "imageUrl",
  "imageStorageId",
  "status",
  "reviewedAt",
  "reviewedBy",
  "moderationNote",
]) {
  assert.deepEqual(
    migratedPrimary[field],
    legacyEventsBeforeMigration[0][field],
    `R1 migration may not change primary public/review field ${field}.`,
  );
}
assert.deepEqual(
  [...legacyMarkerState.tables.instagramEventSources.values()],
  legacyLinksBeforeMigration,
  "R1 migration must not rewrite any post-specific source link.",
);
assert.deepEqual(
  [...legacyMarkerState.tables.events.values()].slice(1),
  legacyEventsBeforeMigration.slice(1),
  "R1 migration must not rewrite a rejected evidence variant or its original marker/version.",
);
assert.deepEqual(
  [...legacyMarkerState.tables.instagramSourceOccurrenceReceipts.values()],
  legacyReceiptsBeforeMigration,
  "R1 migration must not rewrite already-satisfied source receipts.",
);
for (const [auditId, auditBefore] of legacyAuditsBeforeMigration) {
  assert.deepEqual(
    legacyMarkerState.tables.eventAuditLog.get(auditId),
    auditBefore,
    "R1 migration must preserve every original rollback audit byte-for-byte.",
  );
}
assert.equal(
  [...legacyMarkerState.tables.eventAuditLog.values()].filter(
    (audit) => audit.action === "cross_post_campaign_attestation_migrated",
  ).length,
  5,
  "Migration must add one dedicated source-grounding audit per exact campaign row.",
);
for (const receipt of legacyMarkerState.tables.instagramSourceOccurrenceReceipts.values()) {
  assert.equal(receipt.satisfiedOccurrences[0]?.eventId, arianaRows[0].id);
}
assert.equal(
  await isCanonicallyGroundedApprovedEvent(
    serviceCtx(legacyMarkerState),
    migratedPrimary,
  ),
  true,
  "The migrated R1 keeper must be publicly grounded by the new exact audit-backed attestation.",
);
assert.equal(
  (
    await getCrossPostPromotionCoalescingContext._handler(
      serviceCtx(legacyMarkerState),
      {
        operationId: migrationOperationId,
        eventIds: arianaRows.map((row) => row.id),
        targetVenueId: venue._id,
        serviceSecret: process.env.CRON_SECRET,
      },
    )
  ).state,
  "already_coalesced",
  "An uncertain R1 migration retry must read back the exact completed R2 state.",
);

const tamperedLegacyMarkerState = await makeLegacyMarkerOnlyAggregateState();
const tamperedLegacyAudit = [...tamperedLegacyMarkerState.tables.eventAuditLog.values()].find(
  (audit) =>
    audit.eventId === arianaRows[1].id &&
    audit.action === "cross_post_campaign_variant_rejected",
);
assert.ok(tamperedLegacyAudit);
const tamperedLegacyAuditPatch = JSON.parse(tamperedLegacyAudit.patchJson);
tamperedLegacyAuditPatch.receiptAfter.updatedAt += 1;
tamperedLegacyMarkerState.tables.eventAuditLog.set(tamperedLegacyAudit._id, {
  ...tamperedLegacyAudit,
  patchJson: JSON.stringify(tamperedLegacyAuditPatch),
});
const tamperedLegacyVersionsBefore = new Map(
  [...tamperedLegacyMarkerState.tables.events.values()].map((event) => [
    event._id,
    event.updatedAt,
  ]),
);
await assert.rejects(
  () =>
    coalesceApprovedCrossPostPromotionOccurrences._handler(
      serviceCtx(tamperedLegacyMarkerState),
      {
        operationId: migrationOperationId,
        legacyMigrationOperationId: legacyOperationId,
        primary: liveCandidateVersion(
          tamperedLegacyMarkerState,
          arianaRows[0].id,
        ),
        duplicates: arianaRows
          .slice(1)
          .map((row) => liveCandidateVersion(tamperedLegacyMarkerState, row.id)),
        targetVenueId: venue._id,
        expectedTargetVenueUpdatedAt: venue.updatedAt,
        sharedEvidenceAnchors: ["arianagrande", "petal"],
        automaticCampaignIdentity: migrationIdentity,
        moderationNote:
          "This exact migration must fail closed because one prior R1 receipt audit was tampered.",
        serviceSecret: process.env.CRON_SECRET,
      },
    ),
  /individually source-grounded/i,
  "A stale or tampered R1 audit must fail before the migration writes anything.",
);
assert.deepEqual(
  new Map(
    [...tamperedLegacyMarkerState.tables.events.values()].map((event) => [
      event._id,
      event.updatedAt,
    ]),
  ),
  tamperedLegacyVersionsBefore,
);

const legacyMissingHandleState = makeDb();
for (const link of legacyMissingHandleState.links) {
  delete link.sourceHandle;
  const storedLink = legacyMissingHandleState.tables.instagramEventSources.get(
    link._id,
  );
  delete storedLink.sourceHandle;
}
const legacyLinksBefore = structuredClone([
  ...legacyMissingHandleState.tables.instagramEventSources.values(),
]);
const legacyResult = await coalesceApprovedCrossPostPromotionOccurrences._handler(
  serviceCtx(legacyMissingHandleState),
  validArgs(legacyMissingHandleState),
);
assert.equal(legacyResult.primaryId, arianaRows[0].id);
assert.deepEqual(
  [...legacyMissingHandleState.tables.instagramEventSources.values()],
  legacyLinksBefore,
  "Legacy links may omit sourceHandle only when immutable source grounding supplies it, and the mutation must not rewrite lineage.",
);
const legacyPrimary = legacyMissingHandleState.tables.events.get(arianaRows[0].id);
assert.equal(
  await isCanonicallyGroundedApprovedEvent(
    serviceCtx(legacyMissingHandleState),
    legacyPrimary,
  ),
  true,
  "An aggregate backed by audit-pinned legacy links must use the immutable source handle without rewriting those links.",
);
const legacyMissingHandleReattestation =
  await reattestCampaignLineageBatch._handler(
    serviceCtx(legacyMissingHandleState),
    { cursor: null, dryRun: false, limit: 16 },
  );
assert.equal(legacyMissingHandleReattestation.quarantinedCount, 0);
assert.equal(legacyMissingHandleReattestation.reattestedCount, 1);
const legacyMissingHandleVenueCoverage =
  await backfillEventVenueBindingsBatch._handler(
    serviceCtx(legacyMissingHandleState),
    { cursor: null, dryRun: false, limit: 16 },
  );
assert.equal(legacyMissingHandleVenueCoverage.skippedCount, 0);
assert.equal(
  legacyMissingHandleVenueCoverage.quarantinedLineageMarkerCount,
  0,
);
assert.equal(
  legacyMissingHandleVenueCoverage.unchangedCount,
  arianaRows.length,
);
assert.ok(
  [...legacyMissingHandleState.tables.instagramEventSources.values()].every(
    (link) => link.sourceHandle === undefined,
  ),
  "Versioned lineage proof must preserve omitted legacy link handles and use the immutable audited handle.",
);
const legacyLinkBeforeMismatch = structuredClone(
  legacyMissingHandleState.tables.instagramEventSources.get("ariana-link-1"),
);
legacyMissingHandleState.tables.instagramEventSources.set("ariana-link-1", {
  ...legacyLinkBeforeMismatch,
  sourceHandle: "different.promoter",
});
assert.equal(
  await isCanonicallyGroundedApprovedEvent(
    serviceCtx(legacyMissingHandleState),
    legacyPrimary,
  ),
  false,
  "A present legacy-link handle that conflicts with the audited immutable source must hide the aggregate.",
);
const conflictingLegacyHandleCoverage =
  await backfillEventVenueBindingsBatch._handler(
    serviceCtx(legacyMissingHandleState),
    { cursor: null, dryRun: false, limit: 16, restart: true },
  );
assert.equal(conflictingLegacyHandleCoverage.skippedCount, arianaRows.length);
assert.equal(
  conflictingLegacyHandleCoverage.quarantinedLineageMarkerCount,
  arianaRows.length,
  "An explicit legacy-link handle conflict must remain quarantined.",
);
const mismatchedHandleState = makeDb();
mismatchedHandleState.links[0].sourceHandle = "different.promoter";
mismatchedHandleState.tables.instagramEventSources.get(
  mismatchedHandleState.links[0]._id,
).sourceHandle = "different.promoter";
await assert.rejects(
  () =>
    coalesceApprovedCrossPostPromotionOccurrences._handler(
      serviceCtx(mismatchedHandleState),
      validArgs(mismatchedHandleState),
    ),
  /source-link precondition failed/i,
  "A present sourceHandle that conflicts with immutable source grounding must remain blocked.",
);

const state = makeDb();
const contextArgs = {
  operationId: validArgs(state).operationId,
  eventIds: arianaRows.map((row) => row.id),
  targetVenueId: venue._id,
  serviceSecret: process.env.CRON_SECRET,
};
const beforeContext = await getCrossPostPromotionCoalescingContext._handler(
  serviceCtx(state),
  contextArgs,
);
assert.equal(beforeContext.state, "ready");
assert.equal(beforeContext.targetVenue.updatedAt, venue.updatedAt);
assert.equal(beforeContext.candidates.length, 5);
const sourceLinksBefore = structuredClone([
  ...state.tables.instagramEventSources.values(),
]);
const receiptsBefore = structuredClone([
  ...state.tables.instagramSourceOccurrenceReceipts.values(),
]);
const result = await coalesceApprovedCrossPostPromotionOccurrences._handler(
  serviceCtx(state),
  validArgs(state),
);
assert.equal(result.primaryId, arianaRows[0].id);
assert.deepEqual(result.foldedVariantIds, arianaRows.slice(1).map((row) => row.id));
assert.equal(result.movedSaveCount, 2);
assert.equal(result.dedupedSaveCount, 2);
assert.deepEqual(
  result.variantReceiptUpdatedAts.map(({ eventId, receiptId }) => ({
    eventId,
    receiptId,
  })),
  arianaRows.slice(1).map((row, index) => ({
    eventId: row.id,
    receiptId: `ariana-receipt-${index + 1}`,
  })),
);
assert.deepEqual([...state.tables.events.keys()], arianaRows.map((row) => row.id));
assert.equal(state.tables.events.get(arianaRows[0].id).status, "approved");
for (const row of arianaRows.slice(1)) {
  const variant = state.tables.events.get(row.id);
  assert.equal(variant.status, "rejected");
  assert.match(variant.moderationNote, /^\[cross_post_campaign_variant:v1\]/);
}
for (const [index, row] of arianaRows.entries()) {
  const currentNormalized = JSON.parse(
    state.tables.events.get(row.id).normalizedFieldsJson,
  );
  const originalNormalized = JSON.parse(state.events[index].normalizedFieldsJson);
  if (index === 0) {
    assert.ok(currentNormalized.crossPostCampaignAggregateAttestation);
    delete currentNormalized.crossPostCampaignAggregateAttestation;
    assert.deepEqual(
      currentNormalized,
      originalNormalized,
      "The primary aggregate attestation must not alter its source snapshot.",
    );
  } else {
    assert.deepEqual(
      currentNormalized,
      originalNormalized,
      "Rejected variants must retain their immutable source-evidence snapshots.",
    );
  }
}
const afterContext = await getCrossPostPromotionCoalescingContext._handler(
  serviceCtx(state),
  contextArgs,
);
assert.equal(
  afterContext.state,
  "already_coalesced",
  "An uncertain operator retry must recognize the exact completed after-state.",
);
await assert.rejects(
  () =>
    getCrossPostPromotionCoalescingContext._handler(serviceCtx(state), {
      ...contextArgs,
      targetVenueId: wrongVenue._id,
    }),
  /neither ready nor an exact after-state/i,
  "An idempotent retry must remain bound to the exact audited target venue.",
);
const exactAfterReceipt = structuredClone(
  state.tables.instagramSourceOccurrenceReceipts.get("ariana-receipt-1"),
);
state.tables.instagramSourceOccurrenceReceipts.set("ariana-receipt-1", {
  ...structuredClone(exactAfterReceipt),
  expectedOccurrences: [
    {
      ...structuredClone(exactAfterReceipt.expectedOccurrences[0]),
      title: "Tampered semantic binding",
    },
  ],
});
await assert.rejects(
  () =>
    getCrossPostPromotionCoalescingContext._handler(
      serviceCtx(state),
      contextArgs,
    ),
  /neither ready nor an exact after-state/i,
  "Idempotent context must reject a marker-only after-state with a tampered receipt.",
);
state.tables.instagramSourceOccurrenceReceipts.set(
  "ariana-receipt-1",
  exactAfterReceipt,
);

const canonicalEvent = state.tables.events.get(arianaRows[0].id);
assert.equal(
  await isCanonicallyGroundedApprovedEvent(serviceCtx(state), canonicalEvent),
  true,
  "The exact audited cross-post aggregate must remain publicly grounded.",
);
const editablePersistedPost = state.tables.scrapedPosts.get("ariana-scraped-post-2");
const exactPersistedPostBeforeEdit = structuredClone(editablePersistedPost);
state.tables.scrapedPosts.set(editablePersistedPost._id, {
  ...editablePersistedPost,
  caption: `${editablePersistedPost.caption} Instagram-edited follow-up text.`,
  sourceRevision: 2,
  updatedAt: editablePersistedPost.updatedAt + 1,
});
assert.equal(
  await isCanonicallyGroundedApprovedEvent(serviceCtx(state), canonicalEvent),
  true,
  "A later mutable Instagram caption revision must not erase the exact service-audited aggregate lineage.",
);
state.tables.scrapedPosts.set(editablePersistedPost._id, exactPersistedPostBeforeEdit);

const canonicalFieldsBeforeMalformedId = JSON.parse(canonicalEvent.normalizedFieldsJson);
const malformedIdAttestation = structuredClone(
  canonicalFieldsBeforeMalformedId.crossPostCampaignAggregateAttestation,
);
malformedIdAttestation.sources[1].eventId = "not-a-convex-id";
const malformedIdEvent = {
  ...canonicalEvent,
  normalizedFieldsJson: JSON.stringify({
    ...canonicalFieldsBeforeMalformedId,
    crossPostCampaignAggregateAttestation: malformedIdAttestation,
  }),
};
const primaryAuditEntry = [...state.tables.eventAuditLog.values()].find(
  (audit) =>
    audit.eventId === canonicalEvent._id &&
    audit.action === "cross_post_campaign_coalesced",
);
assert.ok(primaryAuditEntry);
const primaryAuditBeforeMalformedId = structuredClone(primaryAuditEntry);
const malformedIdAuditPatch = JSON.parse(primaryAuditEntry.patchJson);
malformedIdAuditPatch.aggregateAttestation = malformedIdAttestation;
state.tables.eventAuditLog.set(primaryAuditEntry._id, {
  ...primaryAuditEntry,
  patchJson: JSON.stringify(malformedIdAuditPatch),
});
state.tables.events.set(canonicalEvent._id, malformedIdEvent);
assert.equal(
  await getPublicApprovedEvent._handler(serviceCtx(state), {
    id: canonicalEvent._id,
  }),
  null,
  "A reserved attestation containing a malformed Convex ID must hide only that event instead of throwing the public query.",
);
state.tables.events.set(canonicalEvent._id, canonicalEvent);
state.tables.eventAuditLog.set(primaryAuditEntry._id, primaryAuditBeforeMalformedId);
assert.equal(
  await isCanonicallyGroundedApprovedEvent(serviceCtx(state), {
    ...canonicalEvent,
    artists: [...canonicalEvent.artists, "Unaudited Artist"],
  }),
  false,
  "The aggregate path must not authorize an artist absent from the exact source union.",
);
state.tables.events.set(canonicalEvent._id, {
  ...canonicalEvent,
  artists: [...canonicalEvent.artists, "Unaudited Artist"],
});
assert.equal(
  await getPublicApprovedEvent._handler(serviceCtx(state), {
    id: canonicalEvent._id,
  }),
  null,
  "Legacy-compatible public projection must not bypass a tampered v4 aggregate attestation.",
);
state.tables.events.set(canonicalEvent._id, canonicalEvent);
const adminContext = {
  auth: { getUserIdentity: async () => ({ subject: "qa-merge-admin" }) },
  db: state.db,
};
const canonicalUpdatedAtBeforeLifecycleChecks = canonicalEvent.updatedAt;
assert.deepEqual(
  await updateEvent._handler(adminContext, {
    id: canonicalEvent._id,
    patch: { title: canonicalEvent.title },
    expectedStatus: "approved",
    expectedUpdatedAt: canonicalEvent.updatedAt,
  }),
  { updatedAt: canonicalEvent.updatedAt },
  "An exact aggregate replay must be a true event-version no-op.",
);
await assert.rejects(
  () =>
    updateEvent._handler(adminContext, {
      id: canonicalEvent._id,
      patch: { title: "Material aggregate rewrite" },
      expectedStatus: "approved",
      expectedUpdatedAt: canonicalEvent.updatedAt,
    }),
  /dedicated re-attestation operation/i,
);
assert.equal(
  state.tables.events.get(canonicalEvent._id).updatedAt,
  canonicalUpdatedAtBeforeLifecycleChecks,
);
await assert.rejects(
  () =>
    deleteApprovedEvent._handler(adminContext, {
      id: canonicalEvent._id,
      expectedUpdatedAt: canonicalEvent.updatedAt,
    }),
  /retained with their audited source lineage/i,
);

const primaryLinkForReplay = state.tables.instagramEventSources.get("ariana-link-0");
const primaryReceiptForReplay =
  state.tables.instagramSourceOccurrenceReceipts.get("ariana-receipt-0");
const primaryPostForReplay = state.tables.scrapedPosts.get("ariana-scraped-post-0");
Object.assign(primaryPostForReplay, {
  processingStatus: "processing",
  processingLeaseOwner: "qa-campaign-replay",
  processingLeaseExpiresAt: QA_NOW_MS + 60_000,
  sourceRevision: 1,
});
const primaryReplayPlan = {
  sourceIdentity: primaryReceiptForReplay.sourceIdentity,
  sourceFingerprint: primaryReceiptForReplay.sourceFingerprint,
  expectedKeys: [...primaryReceiptForReplay.expectedKeys],
  expectedOccurrences: structuredClone(primaryReceiptForReplay.expectedOccurrences),
  deferredChildCount: primaryReceiptForReplay.deferredChildCount,
  deferredChildKeys: [...primaryReceiptForReplay.deferredChildKeys],
  observedChildKeys: [...primaryReceiptForReplay.expectedKeys],
};
const primaryReplayFence = {
  scrapedPostId: primaryPostForReplay._id,
  handle: primaryPostForReplay.handle,
  postId: primaryPostForReplay.postId,
  instagramPostUrl: primaryPostForReplay.instagramPostUrl,
  owner: primaryPostForReplay.processingLeaseOwner,
  sourceRevision: 1,
};
const exactPrimaryReceiptBeforeReplay = structuredClone(primaryReceiptForReplay);
const exactPrimaryLinkBeforeReplay = structuredClone(primaryLinkForReplay);
await assert.rejects(
  () =>
    recordInstagramSourceOccurrenceSatisfaction._handler(serviceCtx(state), {
      plan: primaryReplayPlan,
      satisfiedKey: primaryLinkForReplay.sourceOccurrenceKey,
      representativeEventId: canonicalEvent._id,
      processingFence: primaryReplayFence,
      serviceSecret: process.env.CRON_SECRET,
    }),
  /dedicated re-attestation operation/i,
);
assert.deepEqual(
  state.tables.instagramSourceOccurrenceReceipts.get(primaryReceiptForReplay._id),
  exactPrimaryReceiptBeforeReplay,
  "Campaign source replay must be rejected before bumping an attested receipt version.",
);
assert.deepEqual(
  state.tables.instagramEventSources.get(primaryLinkForReplay._id),
  exactPrimaryLinkBeforeReplay,
  "Campaign source replay must be rejected before bumping an attested source-link version.",
);
await assert.rejects(
  () =>
    recordInstagramSourceOccurrenceSatisfaction._handler(serviceCtx(state), {
      plan: {
        ...primaryReplayPlan,
        previousSourceFingerprint: primaryReplayPlan.sourceFingerprint,
        sourceFingerprint: "materially-changed-campaign-fingerprint",
      },
      satisfiedKey: primaryLinkForReplay.sourceOccurrenceKey,
      representativeEventId: canonicalEvent._id,
      processingFence: primaryReplayFence,
      serviceSecret: process.env.CRON_SECRET,
    }),
  /dedicated re-attestation operation/i,
);
assert.deepEqual(
  state.tables.instagramSourceOccurrenceReceipts.get(primaryReceiptForReplay._id),
  exactPrimaryReceiptBeforeReplay,
);

const variantReceiptForReconcile =
  state.tables.instagramSourceOccurrenceReceipts.get("ariana-receipt-1");
const variantPostForReconcile = state.tables.scrapedPosts.get("ariana-scraped-post-1");
Object.assign(variantPostForReconcile, {
  processingStatus: "processing",
  processingLeaseOwner: "qa-campaign-reconcile",
  processingLeaseExpiresAt: QA_NOW_MS + 60_000,
  sourceRevision: 1,
});
const exactVariantReceiptBeforeReconcile = structuredClone(
  variantReceiptForReconcile,
);
const currentVariantSourceFingerprint =
  buildInstagramSourceOccurrenceFingerprint({
    altText: variantPostForReconcile.altText,
    caption: variantPostForReconcile.caption,
    locationName: variantPostForReconcile.locationName,
  });
await assert.rejects(
  () =>
    reconcileInstagramSourceOccurrenceReceipt._handler(serviceCtx(state), {
      plan: {
        sourceIdentity: variantReceiptForReconcile.sourceIdentity,
        previousSourceFingerprint: variantReceiptForReconcile.sourceFingerprint,
        sourceFingerprint: currentVariantSourceFingerprint,
        expectedKeys: [],
        expectedOccurrences: [],
        deferredChildCount: 0,
        deferredChildKeys: [],
        observedChildKeys: [...variantReceiptForReconcile.expectedKeys],
        confirmedPastKeys: [...variantReceiptForReconcile.expectedKeys],
      },
      processingFence: {
        scrapedPostId: variantPostForReconcile._id,
        handle: variantPostForReconcile.handle,
        postId: variantPostForReconcile.postId,
        instagramPostUrl: variantPostForReconcile.instagramPostUrl,
        owner: variantPostForReconcile.processingLeaseOwner,
        sourceRevision: 1,
      },
      serviceSecret: process.env.CRON_SECRET,
    }),
  /dedicated re-attestation operation/i,
);
assert.deepEqual(
  state.tables.instagramSourceOccurrenceReceipts.get(
    variantReceiptForReconcile._id,
  ),
  exactVariantReceiptBeforeReconcile,
);

const completenessFixture = {
  ...structuredClone(canonicalEvent),
  _id: "campaign-completeness-fixture",
  sourceOccurrenceKey: "campaign-completeness-key",
  normalizedFieldsJson: JSON.stringify({
    sourceOccurrenceKey: "campaign-completeness-key",
    sourceOccurrenceExpectedCount: 1,
    sourceOccurrenceExpectedKeys: ["campaign-completeness-key"],
    sourceOccurrenceDeferredChildCount: 0,
    sourceOccurrenceSourceFingerprint: "campaign-completeness-fingerprint",
    crossPostCampaignAggregateAttestation: { reserved: true },
  }),
  updatedAt: 1_000,
};
state.tables.events.set(completenessFixture._id, completenessFixture);
const completenessPost = {
  ...structuredClone(primaryPostForReplay),
  _id: "campaign-completeness-post",
  processingLeaseOwner: "qa-campaign-completeness",
};
state.tables.scrapedPosts.set(completenessPost._id, completenessPost);
await assert.rejects(
  () =>
    updateSourceOccurrenceExpectedCount._handler(serviceCtx(state), {
      id: completenessFixture._id,
      sourceOccurrenceKey: completenessFixture.sourceOccurrenceKey,
      expectedCurrentCount: 1,
      expectedCurrentKeys: [completenessFixture.sourceOccurrenceKey],
      expectedCurrentDeferredChildCount: 0,
      expectedCurrentSourceFingerprint: "campaign-completeness-fingerprint",
      nextExpectedCount: 2,
      nextExpectedKeys: [completenessFixture.sourceOccurrenceKey, "new-child"],
      nextDeferredChildCount: 0,
      nextSourceFingerprint: "campaign-completeness-fingerprint",
      confirmedPastKeys: [],
      processingFence: {
        scrapedPostId: completenessPost._id,
        handle: completenessPost.handle,
        postId: completenessPost.postId,
        instagramPostUrl: completenessPost.instagramPostUrl,
        owner: completenessPost.processingLeaseOwner,
        sourceRevision: 1,
      },
      serviceSecret: process.env.CRON_SECRET,
    }),
  /dedicated re-attestation operation/i,
);
assert.equal(
  state.tables.events.get(completenessFixture._id).updatedAt,
  completenessFixture.updatedAt,
);
state.tables.events.delete(completenessFixture._id);
state.tables.scrapedPosts.delete(completenessPost._id);

const lineageVersionsBeforeBackfill = new Map(
  [...state.tables.events.values()].map((event) => [event._id, event.updatedAt]),
);
await assert.rejects(
  () =>
    backfillEventVenueIdentityBatch._handler(serviceCtx(state), {
      cursor: null,
      limit: 100,
      serviceSecret: process.env.CRON_SECRET,
    }),
  /unsafe compatibility backfill is retired/i,
);
assert.deepEqual(
  new Map(
    [...state.tables.events.values()].map((event) => [event._id, event.updatedAt]),
  ),
  lineageVersionsBeforeBackfill,
  "Generic venue backfill must skip every primary and variant lineage row.",
);

const variantForMedia = state.tables.events.get(arianaRows[1].id);
const variantVersionBeforeMedia = variantForMedia.updatedAt;
state.tables.mediaAssets.set("campaign-media-variant", {
  _id: "campaign-media-variant",
  _creationTime: 1,
  sourceKey: `instagram-post:${variantForMedia.instagramPostId}`,
  sourceKind: "instagram_post",
  instagramPostId: variantForMedia.instagramPostId,
  normalizedInstagramPostUrl: variantForMedia.instagramPostUrl,
  storageId: "campaign-media-storage",
  url: "https://images.example/old-campaign-media.jpg",
  upstreamUrl: "https://images.example/upstream-campaign-media.jpg",
  mimeType: "image/jpeg",
  byteLength: 1,
  checksumSha256: "a".repeat(64),
  createdAt: 1,
  updatedAt: 1,
  lastAttachedAt: 1,
});
await assert.rejects(
  () =>
    refreshAndAttach._handler(serviceCtx(state), {
      postId: variantForMedia.instagramPostId,
      instagramPostUrl: variantForMedia.instagramPostUrl,
      assetId: "campaign-media-variant",
      storageId: "campaign-media-storage",
      url: "https://images.example/new-campaign-media.jpg",
      actor: "qa-campaign-media",
    }),
  /dedicated re-attestation operation/i,
);
assert.equal(
  state.tables.events.get(variantForMedia._id).updatedAt,
  variantVersionBeforeMedia,
);

state.tables.mediaAssets.set("campaign-media-primary", {
  _id: "campaign-media-primary",
  _creationTime: 1,
  sourceKey: `instagram-post:${canonicalEvent.instagramPostId}`,
  sourceKind: "instagram_post",
  instagramPostId: canonicalEvent.instagramPostId,
  normalizedInstagramPostUrl: canonicalEvent.instagramPostUrl,
  storageId: canonicalEvent.imageStorageId,
  url: canonicalEvent.imageUrl,
  upstreamUrl: "https://images.example/upstream-primary.jpg",
  mimeType: "image/jpeg",
  byteLength: 1,
  checksumSha256: "b".repeat(64),
  createdAt: 1,
  updatedAt: 1,
  lastAttachedAt: 1,
});
await assert.rejects(
  () =>
    removeMissingAsset._handler(serviceCtx(state), {
      postId: canonicalEvent.instagramPostId,
      instagramPostUrl: canonicalEvent.instagramPostUrl,
      assetId: "campaign-media-primary",
      expectedStorageId: canonicalEvent.imageStorageId,
      actor: "qa-campaign-media",
    }),
  /dedicated re-attestation operation/i,
);
assert.equal(
  state.tables.events.get(canonicalEvent._id).updatedAt,
  canonicalUpdatedAtBeforeLifecycleChecks,
);

const retentionResult = await deleteExpiredEvents._handler(serviceCtx(state), {
  batchSize: 100,
  beforeDate: "2026-08-27",
});
assert.equal(retentionResult.deletedEventCount, 0);
assert.equal(retentionResult.retainedCampaignEventCount, arianaRows.length);
assert.deepEqual([...state.tables.events.keys()], arianaRows.map((row) => row.id));
const genericMergeCandidate = {
  ...structuredClone(canonicalEvent),
  _id: "generic-merge-candidate",
  _creationTime: QA_NOW_MS + 1,
  normalizedFieldsJson: state.events[0].normalizedFieldsJson,
  moderationNote: "Independently approved exact duplicate fixture.",
  updatedAt: canonicalEvent.updatedAt + 1,
};
state.tables.events.set(genericMergeCandidate._id, genericMergeCandidate);
await assert.rejects(
  () =>
    mergeApprovedEvents._handler(
      adminContext,
      {
      primaryId: genericMergeCandidate._id,
      duplicateIds: [canonicalEvent._id],
      expectedPrimaryUpdatedAt: genericMergeCandidate.updatedAt,
      expectedDuplicateVersions: [
        { id: canonicalEvent._id, expectedUpdatedAt: canonicalEvent.updatedAt },
      ],
      patch: {},
      },
    ),
  /dedicated receipt-aware coalescing path/i,
  "Generic merge must not delete an aggregate whose variant receipts point at it.",
);
assert.ok(state.tables.events.has(canonicalEvent._id));
state.tables.events.delete(genericMergeCandidate._id);
assert.deepEqual(
  {
    title: canonicalEvent.title,
    venue: canonicalEvent.venue,
    venueId: canonicalEvent.venueId,
    venueInstagramHandle: canonicalEvent.venueInstagramHandle,
    artists: canonicalEvent.artists,
    description: canonicalEvent.description,
    ticketPrice: canonicalEvent.ticketPrice,
    imageUrl: canonicalEvent.imageUrl,
    imageStorageId: canonicalEvent.imageStorageId,
  },
  {
    title: "Ariana Grande theme party",
    venue: "KC Grad",
    venueId: venue._id,
    venueInstagramHandle: "kcgrad",
    artists: ["Aleksandarscala"],
    description: arianaRows[0].description,
    ticketPrice: arianaRows[0].ticketPrice,
    imageUrl: arianaRows[0].imageUrl,
    imageStorageId: arianaRows[0].imageStorageId,
  },
);

assert.deepEqual(
  [...state.tables.instagramEventSources.values()],
  sourceLinksBefore,
  "Every post-specific source link must remain attached to its original evidence row.",
);
assert.deepEqual(
  [...state.tables.instagramEventSources.values()].map((link) => ({
    eventId: link.eventId,
    sourceIdentity: link.sourceIdentity,
    sourceFingerprint: link.sourceFingerprint,
    sourceOccurrenceKey: link.sourceOccurrenceKey,
    instagramPostId: link.instagramPostId,
    instagramPostUrl: link.instagramPostUrl,
  })),
  sourceLinksBefore.map((link) => ({
    eventId: link.eventId,
    sourceIdentity: link.sourceIdentity,
    sourceFingerprint: link.sourceFingerprint,
    sourceOccurrenceKey: link.sourceOccurrenceKey,
    instagramPostId: link.instagramPostId,
    instagramPostUrl: link.instagramPostUrl,
  })),
  "Distinct source-link identity, fingerprint, occurrence key, post, and evidence-row lineage must survive.",
);

const primaryExpectedOccurrence = receiptsBefore[0].expectedOccurrences[0];
assert.deepEqual(
  state.tables.instagramSourceOccurrenceReceipts.get(receiptsBefore[0]._id),
  receiptsBefore[0],
  "The primary receipt must remain byte-for-byte unchanged.",
);
for (let index = 1; index < receiptsBefore.length; index += 1) {
  const original = receiptsBefore[index];
  const current = state.tables.instagramSourceOccurrenceReceipts.get(original._id);
  const originalKey = original.expectedKeys[0];
  assert.equal(current.sourceIdentity, original.sourceIdentity);
  assert.equal(current.sourceFingerprint, original.sourceFingerprint);
  assert.deepEqual(current.expectedKeys, [originalKey]);
  assert.deepEqual(current.satisfiedKeys, [originalKey]);
  assert.deepEqual(current.deferredChildKeys, []);
  assert.equal(current.deferredChildCount, 0);
  assert.deepEqual(current.expectedOccurrences, [
    {
      ...structuredClone(primaryExpectedOccurrence),
      key: originalKey,
    },
  ]);
  assert.deepEqual(current.satisfiedOccurrences, [
    { key: originalKey, eventId: arianaRows[0].id },
  ]);

  const liveReceipt = await getInstagramSourceOccurrenceReceipt._handler(serviceCtx(state), {
    sourceIdentity: original.sourceIdentity,
    serviceSecret: process.env.CRON_SECRET,
  });
  assert.deepEqual(
    liveReceipt.satisfiedKeys,
    [originalKey],
    `Source ${original.sourceIdentity} must remain fully satisfied after coalescing.`,
  );
  assert.deepEqual(liveReceipt.satisfiedOccurrences, [
    { key: originalKey, eventId: arianaRows[0].id },
  ]);
}
const livePrimaryReceipt = await getInstagramSourceOccurrenceReceipt._handler(
  serviceCtx(state),
  {
    sourceIdentity: receiptsBefore[0].sourceIdentity,
    serviceSecret: process.env.CRON_SECRET,
  },
);
assert.deepEqual(livePrimaryReceipt.satisfiedKeys, [receiptsBefore[0].expectedKeys[0]]);
assert.deepEqual(livePrimaryReceipt.satisfiedOccurrences, [
  { key: receiptsBefore[0].expectedKeys[0], eventId: arianaRows[0].id },
]);

assert.deepEqual(
  [...state.tables.savedEvents.values()].map((save) => [save.userId, save.eventId]),
  [
    ["same-user", arianaRows[0].id],
    ["move-user", arianaRows[0].id],
  ],
);
assert.deepEqual(
  [...state.tables.userSavedEvents.values()].map((save) => [save.userId, save.eventId]),
  [
    ["legacy-same", arianaRows[0].id],
    ["legacy-move", arianaRows[0].id],
  ],
);

const audits = [...state.tables.eventAuditLog.values()];
assert.equal(audits.length, 5);
assert.deepEqual(
  audits.map((audit) => audit.action),
  [
    "cross_post_campaign_variant_rejected",
    "cross_post_campaign_variant_rejected",
    "cross_post_campaign_variant_rejected",
    "cross_post_campaign_variant_rejected",
    "cross_post_campaign_coalesced",
  ],
);
for (const audit of audits) {
  const payload = JSON.parse(audit.patchJson);
  assert.equal(payload.operationId, validArgs(state).operationId);
  assert.equal(payload.policyVersion, 1);
  assert.ok(payload.eventBefore, "Every fold audit must retain exact event rollback data.");
  assert.ok(payload.sourceLinkBefore, "Every fold audit must retain source-link rollback data.");
  assert.ok(payload.receiptBefore, "Every fold audit must retain receipt rollback data.");
  const sourceIndex = arianaRows.findIndex((row) => row.id === payload.eventBefore._id);
  assert.ok(sourceIndex >= 0);
  assert.deepEqual(payload.sourceLinkBefore, sourceLinksBefore[sourceIndex]);
  assert.deepEqual(payload.receiptBefore, receiptsBefore[sourceIndex]);
  if (audit.action === "cross_post_campaign_variant_rejected") {
    assert.deepEqual(
      payload.receiptAfter,
      state.tables.instagramSourceOccurrenceReceipts.get(receiptsBefore[sourceIndex]._id),
      "Variant audit must attest the exact replay-safe receipt after-state.",
    );
  }
}

const reattested = await reattestCampaignLineageBatch._handler(
  serviceCtx(state),
  { cursor: null, dryRun: false, limit: 16 },
);
assert.equal(reattested.quarantinedCount, 0);
assert.equal(reattested.reattestedCount, 1);
const reattestedPrimary = state.tables.events.get(arianaRows[0].id);
assert.equal(
  await isCanonicallyGroundedApprovedEvent(serviceCtx(state), reattestedPrimary),
  true,
  "An approved audited campaign must remain canonically grounded after first-class lineage re-attestation.",
);
assert.equal(
  reattestedPrimary.publicationState,
  "publishable",
  "The proof must exist before publication refresh so re-attestation cannot hide the campaign.",
);
assert.ok(
  [...state.tables.sourceOccurrences.values()].every(
    (occurrence) =>
      Number.isSafeInteger(occurrence.occurrenceOrdinal) &&
      occurrence.canonicalEventId === arianaRows[0].id,
  ),
  "Every campaign source must retain its exact expected-occurrence ordinal and canonical representative.",
);
const campaignVenueCoverage = await backfillEventVenueBindingsBatch._handler(
  serviceCtx(state),
  { cursor: null, dryRun: false, limit: 16 },
);
assert.equal(campaignVenueCoverage.skippedCount, 0);
assert.equal(campaignVenueCoverage.quarantinedLineageMarkerCount, 0);
assert.equal(campaignVenueCoverage.unchangedCount, arianaRows.length);
const campaignOccurrenceCoverage = await backfillSourceOccurrencesBatch._handler(
  serviceCtx(state),
  { cursor: null, dryRun: false, limit: 16 },
);
assert.equal(campaignOccurrenceCoverage.skippedCount, 0);
assert.equal(campaignOccurrenceCoverage.quarantinedLineageMarkerCount, 0);
assert.equal(campaignOccurrenceCoverage.unchangedCount, arianaRows.length);
assert.ok(
  [...state.tables.eventDomainMigrationState.values()]
    .filter((row) =>
      ["event-venue-bindings-v1", "source-occurrences-generic-v2"].includes(
        row.key,
      ),
    )
    .every(
      (row) =>
        row.isDone === true &&
        row.completedAt !== undefined &&
        row.mismatchCount === 0 &&
        (row.skippedCount ?? 0) === 0,
    ),
  "A verified campaign must complete the generic venue/occurrence readiness gates instead of remaining permanently quarantined.",
);

{
  const appendState = makeDb();
  const initialOperationId =
    "auto-cross-post-v1:2222222222222222222222222222222222222222";
  const initialExclusiveIdentity = exclusiveCampaignIdentity(
    appendState,
    arianaRows.map((row) => row.id),
  );
  assert.match(
    initialExclusiveIdentity ?? "",
    /^instagram-exclusive-hashtag-campaign-v1:/,
    "The exact five live no-URL captions must derive one bounded history-exclusive campaign identity.",
  );
  await coalesceApprovedCrossPostPromotionOccurrences._handler(
    serviceCtx(appendState),
    {
      ...validArgs(appendState),
      operationId: initialOperationId,
      automaticCampaignIdentity: initialExclusiveIdentity,
    },
  );

  const lateRow = {
    id: "j57-late-ariana-campaign-post",
    postId: "3979999999999999999",
    shortcode: "DlateAriana",
    title: "Late Ariana guest reveal",
    venue: "KC Grad",
    venueId: venue._id,
    venueInstagramHandle: venue.instagramHandle,
    artists: ["Late Guest DJ"],
    description: "Late guest reveal for the same Ariana Petal party.",
    caption:
      "Late Guest DJ joins the same 26 August 20h party at @kcgrad. #1by1 #arianagrande #petal",
  };
  const lateEvent = buildEvent(lateRow, 5);
  const lateLink = buildLink(lateEvent, lateRow, 5);
  const lateReceipt = buildReceipt(lateEvent, lateLink, 5);
  appendState.events.push(lateEvent);
  appendState.links.push(lateLink);
  appendState.receipts.push(lateReceipt);
  appendState.tables.events.set(lateEvent._id, structuredClone(lateEvent));
  appendState.tables.instagramEventSources.set(
    lateLink._id,
    structuredClone(lateLink),
  );
  appendState.tables.instagramSourceOccurrenceReceipts.set(
    lateReceipt._id,
    structuredClone(lateReceipt),
  );
  appendState.tables.scrapedPosts.set("ariana-scraped-post-5", {
    _id: "ariana-scraped-post-5",
    _creationTime: 1,
    handle: "1by1.party",
    username: "1by1.party",
    postId: lateEvent.instagramPostId,
    instagramPostUrl: lateEvent.instagramPostUrl,
    caption: lateEvent.sourceCaption,
    postedAt: lateEvent.sourcePostedAt,
    sourceRevision: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  const appendExclusiveIdentity = exclusiveCampaignIdentity(appendState, [
    ...arianaRows.map((row) => row.id),
    lateEvent._id,
  ]);
  assert.equal(
    appendExclusiveIdentity,
    initialExclusiveIdentity,
    "A later post must re-prove the same stable occurrence identity against the expanded exact history.",
  );

  const appendOperationId =
    "auto-cross-post-v1:3333333333333333333333333333333333333333";
  const appendContextArgs = {
    operationId: appendOperationId,
    eventIds: [arianaRows[0].id, lateEvent._id],
    targetVenueId: venue._id,
    serviceSecret: process.env.CRON_SECRET,
  };
  assert.equal(
    (
      await getCrossPostPromotionCoalescingContext._handler(
        serviceCtx(appendState),
        appendContextArgs,
      )
    ).state,
    "ready",
  );
  await coalesceApprovedCrossPostPromotionOccurrences._handler(
    serviceCtx(appendState),
    {
      operationId: appendOperationId,
      primary: liveCandidateVersion(appendState, arianaRows[0].id),
      duplicates: [liveCandidateVersion(appendState, lateEvent._id)],
      targetVenueId: venue._id,
      expectedTargetVenueUpdatedAt: venue.updatedAt,
      sharedEvidenceAnchors: ["arianagrande", "petal"],
      automaticCampaignIdentity: appendExclusiveIdentity,
      moderationNote:
        "Automatic append of one later post with the same exact campaign identity and occurrence.",
      serviceSecret: process.env.CRON_SECRET,
    },
  );
  const appendedPrimary = appendState.tables.events.get(arianaRows[0].id);
  const appendedAttestation = JSON.parse(
    appendedPrimary.normalizedFieldsJson,
  ).crossPostCampaignAggregateAttestation;
  assert.equal(appendedAttestation.lineageDepth, 2);
  assert.equal(appendedAttestation.totalSourceCount, 6);
  assert.deepEqual(appendedPrimary.artists, [
    "Aleksandarscala",
    "Late Guest DJ",
  ]);
  assert.equal(
    await isCanonicallyGroundedApprovedEvent(
      serviceCtx(appendState),
      appendedPrimary,
    ),
    true,
    "A bounded day-two append must remain grounded through the prior aggregate audit.",
  );
  for (const receipt of appendState.tables.instagramSourceOccurrenceReceipts.values()) {
    assert.equal(receipt.satisfiedOccurrences.length, 1);
    assert.equal(
      receipt.satisfiedOccurrences[0].eventId,
      arianaRows[0].id,
      "Every old and new campaign receipt must remain satisfied by the same primary.",
    );
  }
  assert.equal(
    (
      await getCrossPostPromotionCoalescingContext._handler(
        serviceCtx(appendState),
        appendContextArgs,
      )
    ).state,
    "already_coalesced",
  );

  const secondLateRow = {
    id: "j57-second-late-ariana-campaign-post",
    postId: "3980000000000000000",
    shortcode: "DsecondLateAriana",
    title: "Second late Ariana guest reveal",
    venue: "KC Grad",
    venueId: venue._id,
    venueInstagramHandle: venue.instagramHandle,
    artists: ["Second Late Guest DJ"],
    description: "A second late guest reveal for the same Ariana Petal party.",
    caption:
      "Second Late Guest DJ joins the same 26 August 20h party at @kcgrad. #1by1 #arianagrande #petal",
  };
  const secondLateEvent = buildEvent(secondLateRow, 6);
  const secondLateLink = buildLink(secondLateEvent, secondLateRow, 6);
  const secondLateReceipt = buildReceipt(secondLateEvent, secondLateLink, 6);
  appendState.events.push(secondLateEvent);
  appendState.links.push(secondLateLink);
  appendState.receipts.push(secondLateReceipt);
  appendState.tables.events.set(
    secondLateEvent._id,
    structuredClone(secondLateEvent),
  );
  appendState.tables.instagramEventSources.set(
    secondLateLink._id,
    structuredClone(secondLateLink),
  );
  appendState.tables.instagramSourceOccurrenceReceipts.set(
    secondLateReceipt._id,
    structuredClone(secondLateReceipt),
  );
  appendState.tables.scrapedPosts.set("ariana-scraped-post-6", {
    _id: "ariana-scraped-post-6",
    _creationTime: 1,
    handle: "1by1.party",
    username: "1by1.party",
    postId: secondLateEvent.instagramPostId,
    instagramPostUrl: secondLateEvent.instagramPostUrl,
    caption: secondLateEvent.sourceCaption,
    postedAt: secondLateEvent.sourcePostedAt,
    sourceRevision: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  const secondAppendIdentity = exclusiveCampaignIdentity(appendState, [
    ...arianaRows.map((row) => row.id),
    lateEvent._id,
    secondLateEvent._id,
  ]);
  assert.equal(secondAppendIdentity, initialExclusiveIdentity);
  const secondAppendOperationId =
    "auto-cross-post-v1:5555555555555555555555555555555555555555";
  const secondAppendContextArgs = {
    operationId: secondAppendOperationId,
    eventIds: [arianaRows[0].id, secondLateEvent._id],
    targetVenueId: venue._id,
    serviceSecret: process.env.CRON_SECRET,
  };
  assert.equal(
    (
      await getCrossPostPromotionCoalescingContext._handler(
        serviceCtx(appendState),
        secondAppendContextArgs,
      )
    ).state,
    "ready",
  );
  await coalesceApprovedCrossPostPromotionOccurrences._handler(
    serviceCtx(appendState),
    {
      operationId: secondAppendOperationId,
      primary: liveCandidateVersion(appendState, arianaRows[0].id),
      duplicates: [liveCandidateVersion(appendState, secondLateEvent._id)],
      targetVenueId: venue._id,
      expectedTargetVenueUpdatedAt: venue.updatedAt,
      sharedEvidenceAnchors: ["arianagrande", "petal"],
      automaticCampaignIdentity: secondAppendIdentity,
      moderationNote:
        "Automatic second append of one later post with the same exact no-URL campaign identity.",
      serviceSecret: process.env.CRON_SECRET,
    },
  );
  const twiceAppendedPrimary = appendState.tables.events.get(arianaRows[0].id);
  const twiceAppendedAttestation = JSON.parse(
    twiceAppendedPrimary.normalizedFieldsJson,
  ).crossPostCampaignAggregateAttestation;
  assert.equal(twiceAppendedAttestation.lineageDepth, 3);
  assert.equal(twiceAppendedAttestation.totalSourceCount, 7);
  assert.deepEqual(twiceAppendedAttestation.campaignPostIds, [
    ...arianaRows.map((row) => row.postId),
    lateRow.postId,
    secondLateRow.postId,
  ]);
  assert.deepEqual(twiceAppendedPrimary.artists, [
    "Aleksandarscala",
    "Late Guest DJ",
    "Second Late Guest DJ",
  ]);
  assert.equal(
    await isCanonicallyGroundedApprovedEvent(
      serviceCtx(appendState),
      twiceAppendedPrimary,
    ),
    true,
    "A second no-URL append must remain recursively audit-grounded.",
  );
}

{
  const conflictingHistoryState = makeDb();
  conflictingHistoryState.tables.scrapedPosts.set("unrelated-matching-post", {
    _id: "unrelated-matching-post",
    _creationTime: 1,
    handle: "1by1.party",
    username: "1by1.party",
    postId: "unrelated-ariana-petal-post",
    instagramPostUrl: "https://www.instagram.com/p/unrelated/",
    caption: "A separate occurrence using #arianagrande #petal",
    postedAt: "2026-08-10T12:00:00.000Z",
    sourceRevision: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  const eventVersionsBeforeConflict = new Map(
    [...conflictingHistoryState.tables.events.values()].map((event) => [
      event._id,
      event.updatedAt,
    ]),
  );
  await assert.rejects(
    () =>
      coalesceApprovedCrossPostPromotionOccurrences._handler(
        serviceCtx(conflictingHistoryState),
        {
          ...validArgs(conflictingHistoryState),
          operationId:
            "auto-cross-post-v1:4444444444444444444444444444444444444444",
          automaticCampaignIdentity:
            "instagram-exclusive-hashtag-campaign-v1:stale-runner-proof",
        },
      ),
    /source-exclusive hashtag campaign/i,
    "A new matching persisted post outside the candidate set must invalidate stale no-URL runner proof before writes.",
  );
  assert.deepEqual(
    new Map(
      [...conflictingHistoryState.tables.events.values()].map((event) => [
        event._id,
        event.updatedAt,
      ]),
    ),
    eventVersionsBeforeConflict,
  );
}

{
  const overflowHistoryState = makeDb();
  for (let index = 0; index < 508; index += 1) {
    const id = `overflow-history-${index}`;
    overflowHistoryState.tables.scrapedPosts.set(id, {
      _id: id,
      _creationTime: 1,
      handle: "1by1.party",
      username: "1by1.party",
      postId: id,
      instagramPostUrl: `https://www.instagram.com/p/${id}/`,
      caption: `Unrelated bounded-history post ${index}.`,
      postedAt: "2026-08-01T12:00:00.000Z",
      sourceRevision: 1,
      createdAt: 1,
      updatedAt: 1,
    });
  }
  await assert.rejects(
    () =>
      coalesceApprovedCrossPostPromotionOccurrences._handler(
        serviceCtx(overflowHistoryState),
        {
          ...validArgs(overflowHistoryState),
          operationId:
            "auto-cross-post-v1:6666666666666666666666666666666666666666",
          automaticCampaignIdentity:
            "instagram-exclusive-hashtag-campaign-v1:truncated-history",
        },
      ),
    /source-exclusive hashtag campaign/i,
    "A source history beyond the exact 512-post mutation bound must fail closed.",
  );
  assert.equal(
    [...overflowHistoryState.tables.events.values()].filter(
      (event) => event.status === "approved",
    ).length,
    arianaRows.length,
  );
}

console.log(
  "Cross-post promotion coalescing QA passed: the five Ariana/KC Grad promos leave one approved event, source links retain post-specific evidence lineage, every receipt remains live-satisfied by the primary, rollback data is exact, saves survive, and stale versions/time/venue/theme/anchor conflicts fail closed.",
);
