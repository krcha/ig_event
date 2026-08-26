import assert from "node:assert/strict";

import {
  coalesceApprovedCrossPostPromotionOccurrences,
  getCrossPostPromotionCoalescingContext,
  getInstagramSourceOccurrenceReceipt,
} from "../convex/events.ts";
import { buildCrossPostPromotionCoalescingPlan } from "../lib/events/cross-post-promotion-coalescing.ts";

process.env.CRON_SECRET = "qa-cross-post-promotion-secret";

const QA_NOW_MS = new Date("2026-08-25T12:00:00.000Z").getTime();
Date.now = () => QA_NOW_MS;

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
      "Ako si i ti Ari fan, vidimo se u sredu 26.avgusta od 20h u KC Gradu. #arianagrande #petal",
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
      "Izaberi fit iz svoje omiljene Ari ere i vidimo se sutra od 20h @kcgrad. #arianagrande #petal",
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
      "Petal giveaway: dodjite na Ariana Grande zurku 26. avgusta od 20h. #kcgrad #arianagrande #petal",
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
      "Trazili ste Ariana zurku i dobili ste je. Vidimo se @kcgrad 26.avgusta od 20h! #arianagrande #petal",
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
    eventAuditLog: new Map(),
  };
  let auditCounter = 0;
  const rows = (table) => [...(tables[table]?.values() ?? [])];
  const result = (table, filters = []) => {
    const matches = () =>
      rows(table).filter((row) => filters.every(([field, value]) => row[field] === value));
    return {
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
    };
  };
  const query = (table) => ({
    ...result(table),
    withIndex(_index, configure) {
      const filters = [];
      const builder = {
        eq(field, value) {
          filters.push([field, value]);
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
      async get(id) {
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
await assert.rejects(
  () =>
    coalesceApprovedCrossPostPromotionOccurrences._handler(
      serviceCtx(aggregateMismatchState),
      validArgs(aggregateMismatchState),
    ),
  /aggregate must match the primary immutable snapshot/i,
  "An artist found only in a variant must not silently rewrite the retained immutable binding.",
);

const missingPrimarySourceState = makeDb();
missingPrimarySourceState.tables.scrapedPosts.delete("ariana-scraped-post-0");
await assert.rejects(
  () =>
    coalesceApprovedCrossPostPromotionOccurrences._handler(
      serviceCtx(missingPrimarySourceState),
      validArgs(missingPrimarySourceState),
    ),
  /publicly source-grounded/i,
  "A missing canonical persisted source must block the retained public event.",
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
  assert.equal(
    state.tables.events.get(row.id).normalizedFieldsJson,
    state.events[index].normalizedFieldsJson,
    "Campaign coalescing must not rewrite any immutable source-evidence snapshot.",
  );
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

console.log(
  "Cross-post promotion coalescing QA passed: the five Ariana/KC Grad promos leave one approved event, source links retain post-specific evidence lineage, every receipt remains live-satisfied by the primary, rollback data is exact, saves survive, and stale versions/time/venue/theme/anchor conflicts fail closed.",
);
