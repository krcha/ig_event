import assert from "node:assert/strict";

import {
  coalesceApprovedNightlifeLineupOccurrences,
  createEvent,
  getInstagramSourceOccurrenceReceipt,
  mergeApprovedEvents,
  recordInstagramSourceOccurrenceSatisfaction,
} from "../convex/events.ts";
import { classifyApprovalOccurrenceRelation } from "../lib/events/approval-occurrence-conflict.ts";
import {
  bindSourceOccurrenceMetadata,
  prepareEventsForInsert,
} from "../lib/pipeline/run-instagram-ingestion.ts";

process.env.ADMIN_CLERK_USER_IDS = "qa-merge-admin";
process.env.CRON_SECRET = "qa-lineup-service-secret";

// Keep the dated event-evidence fixtures deterministic. `isFutureIsoDate` intentionally
// treats same-day events as eligible, so this suite must not start failing as wall time
// moves past the fixture dates.
const QA_NOW_MS = new Date("2026-08-22T12:00:00.000Z").getTime();
Date.now = () => QA_NOW_MS;

function approvedEvent(id, overrides = {}) {
  return {
    _id: id,
    _creationTime: 1,
    title: "Canonical concert",
    date: "2026-08-07",
    time: "20:00",
    venue: "Occurrence Venue",
    venueId: "venue-occurrence",
    venueInstagramHandle: "occurrence_venue",
    artists: ["Canonical Artist"],
    eventType: "music",
    instagramPostId: "shared-post",
    instagramPostUrl: "https://www.instagram.com/p/shared-post/",
    sourceOccurrenceKey: "shared-occurrence",
    status: "approved",
    createdAt: 1,
    updatedAt: 10,
    ...overrides,
  };
}

function makeDb({
  events: eventRows,
  links = [],
  receipts = [],
  scrapedPosts = [],
  venues = [],
  mediaAssets = [],
  savedEvents = [],
  userSavedEvents = [],
}) {
  const tables = {
    events: new Map(eventRows.map((row) => [row._id, structuredClone(row)])),
    instagramEventSources: new Map(links.map((row) => [row._id, structuredClone(row)])),
    instagramSourceOccurrenceReceipts: new Map(
      receipts.map((row) => [row._id, structuredClone(row)]),
    ),
    scrapedPosts: new Map(scrapedPosts.map((row) => [row._id, structuredClone(row)])),
    venues: new Map(venues.map((row) => [row._id, structuredClone(row)])),
    mediaAssets: new Map(mediaAssets.map((row) => [row._id, structuredClone(row)])),
    userSavedEvents: new Map(
      userSavedEvents.map((row) => [row._id, structuredClone(row)]),
    ),
    savedEvents: new Map(savedEvents.map((row) => [row._id, structuredClone(row)])),
    eventAuditLog: new Map(),
  };
  const insertCounters = new Map();
  const rows = (table) => [...(tables[table]?.values() ?? [])];
  const queryResult = (table, filters = []) => {
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
    ...queryResult(table),
    withIndex(_index, configure) {
      const filters = [];
      const builder = {
        eq(field, value) {
          filters.push([field, value]);
          return builder;
        },
      };
      configure(builder);
      return queryResult(table, filters);
    },
  });
  return {
    tables,
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
          table.set(id, { ...table.get(id), ...patch });
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
        assert.ok(tables[table], `Unexpected insert table ${table}.`);
        const nextCounter = (insertCounters.get(table) ?? 0) + 1;
        insertCounters.set(table, nextCounter);
        const id = `${table}-insert-${nextCounter}`;
        tables[table].set(id, { _id: id, _creationTime: Date.now(), ...structuredClone(value) });
        return id;
      },
    },
  };
}

function adminCtx(state) {
  return {
    auth: { getUserIdentity: async () => ({ subject: "qa-merge-admin" }) },
    db: state.db,
  };
}

function processingPost(overrides = {}) {
  return {
    _id: "scraped-empty-venue",
    handle: "unknown_venue_source",
    postId: "UNKNOWNVENUEPOST",
    instagramPostUrl: "https://www.instagram.com/p/UNKNOWNVENUEPOST/",
    username: "unknown_venue_source",
    processingStatus: "processing",
    processingLeaseOwner: "qa-empty-venue-owner",
    processingLeaseExpiresAt: Date.now() + 60_000,
    sourceRevision: 1,
    ...overrides,
  };
}

function emptyVenueOccurrenceFixture(overrides = {}) {
  const post = processingPost(overrides.post);
  const key = overrides.key ?? "instagram-occurrence-v2:empty-venue";
  const event = {
    title: "Canonical concert",
    date: "2026-08-17",
    time: "20:00",
    venue: "",
    artists: ["Canonical Artist"],
    eventType: "music",
    instagramPostId: post.postId,
    instagramPostUrl: post.instagramPostUrl,
    sourceOccurrenceKey: key,
    status: "approved",
    ...overrides.event,
  };
  const plan = {
    sourceIdentity: "instagram-source-identity-v1:empty-venue",
    sourceFingerprint: "instagram-source-v2:empty-venue",
    expectedKeys: [key],
    expectedOccurrences: [
      {
        key,
        date: event.date,
        time: event.time,
        venue: event.venue,
        title: event.title,
        artists: event.artists,
      },
    ],
    deferredChildCount: 0,
    deferredChildKeys: [],
    observedChildKeys: [key],
    ...overrides.plan,
  };
  const processingFence = {
    scrapedPostId: post._id,
    handle: post.handle,
    postId: post.postId,
    instagramPostUrl: post.instagramPostUrl,
    owner: post.processingLeaseOwner,
    sourceRevision: post.sourceRevision,
  };
  return { event, key, plan, post, processingFence };
}

const distinctState = makeDb({
  events: [
    approvedEvent("distinct-primary", { sourceOccurrenceKey: "occurrence-20" }),
    approvedEvent("distinct-later", {
      time: "22:00",
      sourceOccurrenceKey: "occurrence-22",
      updatedAt: 11,
    }),
  ],
});
await assert.rejects(
  mergeApprovedEvents._handler(
    { auth: { getUserIdentity: async () => ({ subject: "qa-merge-admin" }) }, db: distinctState.db },
    {
      primaryId: "distinct-primary",
      duplicateIds: ["distinct-later"],
      patch: {},
    },
  ),
  /every pair to be a proven duplicate/i,
);
assert.equal(distinctState.tables.events.has("distinct-later"), true);

const duplicateState = makeDb({
  events: [approvedEvent("duplicate-primary"), approvedEvent("duplicate-row", { updatedAt: 11 })],
  links: [
    {
      _id: "source-link-duplicate",
      eventId: "duplicate-row",
      sourceIdentity: "instagram:occurrence_venue:shared-post",
      sourceFingerprint: "fingerprint-1",
      sourceOccurrenceKey: "shared-occurrence",
      instagramPostId: "shared-post",
      instagramPostUrl: "https://www.instagram.com/p/shared-post/",
      sourceHandle: "occurrence_venue",
      linkedAt: 1,
      updatedAt: 1,
    },
  ],
  receipts: [
    {
      _id: "receipt-1",
      sourceIdentity: "instagram:occurrence_venue:shared-post",
      sourceFingerprint: "fingerprint-1",
      expectedKeys: ["shared-occurrence"],
      expectedOccurrences: [
        {
          key: "shared-occurrence",
          date: "2026-08-07",
          time: "20:00",
          venue: "Occurrence Venue",
          title: "Canonical concert",
          artists: ["Canonical Artist"],
        },
      ],
      satisfiedKeys: ["shared-occurrence"],
      deferredChildCount: 0,
      deferredChildKeys: [],
      satisfiedOccurrences: [{ key: "shared-occurrence", eventId: "duplicate-row" }],
      createdAt: 1,
      updatedAt: 1,
    },
  ],
});
const merged = await mergeApprovedEvents._handler(
  { auth: { getUserIdentity: async () => ({ subject: "qa-merge-admin" }) }, db: duplicateState.db },
  {
    primaryId: "duplicate-primary",
    duplicateIds: ["duplicate-row"],
    patch: {},
  },
);
assert.deepEqual(merged, { primaryId: "duplicate-primary", deletedDuplicateCount: 1 });
assert.equal(duplicateState.tables.events.has("duplicate-row"), false);
assert.equal(
  duplicateState.tables.instagramEventSources.get("source-link-duplicate").eventId,
  "duplicate-primary",
);
assert.deepEqual(
  duplicateState.tables.instagramSourceOccurrenceReceipts.get("receipt-1").satisfiedOccurrences,
  [{ key: "shared-occurrence", eventId: "duplicate-primary" }],
);

const dateEvidenceMergeState = makeDb({
  events: [
    approvedEvent("date-evidence-primary", {
      dateEvidenceText: "7. avgust",
      dateEvidenceSource: "caption",
      dateEvidenceIsRelative: false,
      dateEvidenceResolvedDate: "2026-08-07",
      sourceConflictFields: [],
    }),
    approvedEvent("date-evidence-duplicate", {
      date: "2026-08-08",
      updatedAt: 11,
    }),
  ],
});
await mergeApprovedEvents._handler(adminCtx(dateEvidenceMergeState), {
  primaryId: "date-evidence-primary",
  duplicateIds: ["date-evidence-duplicate"],
  patch: { date: "2026-08-08" },
});
const dateEvidenceMergedPrimary = dateEvidenceMergeState.tables.events.get(
  "date-evidence-primary",
);
for (const key of [
  "dateEvidenceText",
  "dateEvidenceSource",
  "dateEvidenceIsRelative",
  "dateEvidenceResolvedDate",
  "sourceConflictFields",
]) {
  assert.equal(
    dateEvidenceMergedPrimary[key],
    undefined,
    `A merge date change must atomically clear stale ${key}.`,
  );
}

const partialDateEvidenceState = makeDb({
  events: [
    approvedEvent("partial-date-primary"),
    approvedEvent("partial-date-duplicate", { updatedAt: 11 }),
  ],
});
await assert.rejects(
  mergeApprovedEvents._handler(adminCtx(partialDateEvidenceState), {
    primaryId: "partial-date-primary",
    duplicateIds: ["partial-date-duplicate"],
    patch: { dateEvidenceText: "8. avgust" },
  }),
  /must be replaced or cleared together/i,
);

const unknownVenueRelationBase = {
  candidate: {
    title: "Canonical concert",
    time: "20:00",
    artists: ["Canonical Artist"],
    sourceOccurrenceKey: "cross-source-candidate",
  },
  existing: {
    title: "Canonical concert",
    time: "20:00",
    artists: ["Canonical Artist"],
    sourceOccurrenceKey: "cross-source-existing",
  },
  sameVenue: false,
  sameSource: false,
};
assert.equal(
  classifyApprovalOccurrenceRelation({
    ...unknownVenueRelationBase,
    unknownVenue: true,
  }),
  "proven_duplicate",
  "Unknown-venue cross-source rows with the same identity and reliable time must be duplicates.",
);
assert.equal(
  classifyApprovalOccurrenceRelation({
    ...unknownVenueRelationBase,
    candidate: { ...unknownVenueRelationBase.candidate, time: undefined },
    existing: { ...unknownVenueRelationBase.existing, time: undefined },
    unknownVenue: true,
  }),
  "ambiguous",
  "Unknown-venue cross-source rows with matching identity but no reliable time must fail closed.",
);
assert.equal(
  classifyApprovalOccurrenceRelation({
    ...unknownVenueRelationBase,
    unknownVenue: false,
  }),
  "unrelated",
  "Known distinct venues and sources must not collapse merely because title and time match.",
);
assert.equal(
  classifyApprovalOccurrenceRelation({
    ...unknownVenueRelationBase,
    candidate: {
      ...unknownVenueRelationBase.candidate,
      title: "Different concert",
      artists: ["Different Artist"],
    },
    unknownVenue: true,
  }),
  "unrelated",
  "Missing venue alone must not conflate unrelated same-time events.",
);

assert.equal(
  classifyApprovalOccurrenceRelation({
    candidate: { title: "SAZVEŽĐE PSA", artists: [] },
    existing: { title: "Bioskopska premijera", artists: [] },
    sameVenue: true,
    sameSource: false,
  }),
  "proven_distinct",
  "Strong disjoint titles at one venue/date must remain separate events.",
);
assert.equal(
  classifyApprovalOccurrenceRelation({
    candidate: { title: "MAGAZIN", artists: [] },
    existing: { title: "KONCERT GRUPE MAGAZIN U BEOGRADU", artists: [] },
    sameVenue: true,
    sameSource: false,
  }),
  "proven_duplicate",
  "A distinctive contained title at one venue/date must resolve as a duplicate.",
);

const emptyVenueFixture = emptyVenueOccurrenceFixture();
const emptyVenueCreateState = makeDb({
  events: [],
  scrapedPosts: [emptyVenueFixture.post],
});
const emptyVenueCreate = await createEvent._handler(adminCtx(emptyVenueCreateState), {
  ...emptyVenueFixture.event,
  sourceOccurrencePlan: emptyVenueFixture.plan,
  processingFence: emptyVenueFixture.processingFence,
  returnCreateDisposition: true,
});
assert.equal(emptyVenueCreate.created, true);
assert.equal(
  emptyVenueCreateState.tables.events.get(emptyVenueCreate.eventId).venue,
  "",
  "The real Convex create handler must persist the intentional empty venue.",
);
const [emptyVenueReceipt] = [
  ...emptyVenueCreateState.tables.instagramSourceOccurrenceReceipts.values(),
];
assert.ok(emptyVenueReceipt, "The empty-venue create must write its occurrence receipt.");
assert.equal(emptyVenueReceipt.expectedOccurrences[0].venue, "");
assert.deepEqual(emptyVenueReceipt.satisfiedKeys, [emptyVenueFixture.key]);
assert.deepEqual(emptyVenueReceipt.satisfiedOccurrences, [
  { key: emptyVenueFixture.key, eventId: emptyVenueCreate.eventId },
]);
const [emptyVenueSourceLink] = [
  ...emptyVenueCreateState.tables.instagramEventSources.values(),
];
assert.equal(emptyVenueSourceLink.eventId, emptyVenueCreate.eventId);
assert.equal(emptyVenueSourceLink.sourceOccurrenceKey, emptyVenueFixture.key);

const invalidPlanCases = [
  ["source identity", { sourceIdentity: "" }],
  ["source fingerprint", { sourceFingerprint: "" }],
  [
    "date",
    {
      expectedOccurrences: [
        { ...emptyVenueFixture.plan.expectedOccurrences[0], date: "" },
      ],
    },
  ],
  [
    "title",
    {
      expectedOccurrences: [
        { ...emptyVenueFixture.plan.expectedOccurrences[0], title: "" },
      ],
    },
  ],
  [
    "key binding",
    {
      expectedOccurrences: [
        { ...emptyVenueFixture.plan.expectedOccurrences[0], key: "different-key" },
      ],
    },
  ],
  [
    "venue type",
    {
      expectedOccurrences: [
        { ...emptyVenueFixture.plan.expectedOccurrences[0], venue: undefined },
      ],
    },
  ],
];
for (const [label, planPatch] of invalidPlanCases) {
  await assert.rejects(
    () =>
      recordInstagramSourceOccurrenceSatisfaction._handler(adminCtx(emptyVenueCreateState), {
        plan: { ...emptyVenueFixture.plan, ...planPatch },
        satisfiedKey: emptyVenueFixture.key,
        representativeEventId: emptyVenueCreate.eventId,
        processingFence: emptyVenueFixture.processingFence,
      }),
    /Source occurrence receipt plan is invalid/,
    `Allowing an empty venue must retain the ${label} receipt check.`,
  );
}

const crossSourceDuplicateFixture = emptyVenueOccurrenceFixture({
  key: "instagram-occurrence-v2:cross-source-candidate",
  plan: {
    sourceIdentity: "instagram-source-identity-v1:cross-source-candidate",
    sourceFingerprint: "instagram-source-v2:cross-source-candidate",
  },
});
const crossSourceDuplicateState = makeDb({
  events: [
    approvedEvent("unknown-venue-existing", {
      date: crossSourceDuplicateFixture.event.date,
      venue: "",
      venueId: undefined,
      venueInstagramHandle: undefined,
      instagramPostId: "OTHERUNKNOWNVENUEPOST",
      instagramPostUrl: "https://www.instagram.com/p/OTHERUNKNOWNVENUEPOST/",
      sourceOccurrenceKey: "instagram-occurrence-v2:cross-source-existing",
    }),
  ],
  scrapedPosts: [crossSourceDuplicateFixture.post],
});
await assert.rejects(
  () =>
    createEvent._handler(adminCtx(crossSourceDuplicateState), {
      ...crossSourceDuplicateFixture.event,
      sourceOccurrencePlan: crossSourceDuplicateFixture.plan,
      processingFence: crossSourceDuplicateFixture.processingFence,
      returnCreateDisposition: true,
    }),
  /approved event already exists for this canonical occurrence/i,
  "A second cross-source unknown-venue approval with the same identity/time must be rejected.",
);
assert.equal(crossSourceDuplicateState.tables.events.size, 1);
assert.equal(crossSourceDuplicateState.tables.instagramSourceOccurrenceReceipts.size, 0);

const vrtoglavicaSourceIdentity = "instagram-source-identity-v1:qa-vrtoglavica";
const vrtoglavicaOldFingerprint = "instagram-source-v2:qa-vrtoglavica-old";
const vrtoglavicaNextFingerprint = "instagram-source-v2:qa-vrtoglavica-next";
const vrtoglavicaKeys = {
  bodies: "instagram-occurrence-v2:qa-vrtoglavica-bodies",
  chillout: "instagram-occurrence-v2:qa-vrtoglavica-chillout",
  infected: "instagram-occurrence-v2:qa-vrtoglavica-infected",
};
const vrtoglavicaBindings = {
  bodies: {
    key: vrtoglavicaKeys.bodies,
    date: "2026-09-26",
    time: "TBD",
    venue: "Vrtoglavica",
    title: "Bodies Hit The Floor",
    artists: ["DJ Hellspawn", "DJ Kedlavi", "DJ Sirivs"],
  },
  chillout: {
    key: vrtoglavicaKeys.chillout,
    date: "2026-09-26",
    time: "TBD",
    venue: "Vrtoglavica",
    title: "Chillout Zone",
    artists: [],
  },
  infected: {
    key: vrtoglavicaKeys.infected,
    date: "2026-09-26",
    time: "TBD",
    venue: "Vrtoglavica",
    title: "INFECTED",
    artists: [],
  },
};
const vrtoglavicaPost = processingPost({
  _id: "scraped-vrtoglavica",
  handle: "vrtoglavicaklub",
  postId: "QA-VRTOGLAVICA",
  instagramPostUrl: "https://www.instagram.com/p/QA-VRTOGLAVICA/",
  processingLeaseOwner: "qa-vrtoglavica-owner",
});
const vrtoglavicaProcessingFence = {
  scrapedPostId: vrtoglavicaPost._id,
  handle: vrtoglavicaPost.handle,
  postId: vrtoglavicaPost.postId,
  instagramPostUrl: vrtoglavicaPost.instagramPostUrl,
  owner: vrtoglavicaPost.processingLeaseOwner,
  sourceRevision: vrtoglavicaPost.sourceRevision,
};

function vrtoglavicaEvent(id, key, binding) {
  return approvedEvent(id, {
    title: binding.title,
    date: binding.date,
    time: binding.time,
    venue: binding.venue,
    artists: binding.artists,
    instagramPostId: vrtoglavicaPost.postId,
    instagramPostUrl: vrtoglavicaPost.instagramPostUrl,
    sourceOccurrenceKey: key,
    normalizedFieldsJson: JSON.stringify({
      sourceOccurrenceKey: key,
      sourceOccurrenceSourceFingerprint: vrtoglavicaOldFingerprint,
      sourceOccurrenceAmbiguousProvenance: true,
      title: binding.title,
      normalizedDate: binding.date,
      time: binding.time,
      normalizedVenue: binding.venue,
      artists: binding.artists,
    }),
  });
}

const wrongBodiesEvent = vrtoglavicaEvent(
  "vrtoglavica-wrong-bodies",
  vrtoglavicaKeys.bodies,
  vrtoglavicaBindings.chillout,
);
const chilloutEvent = vrtoglavicaEvent(
  "vrtoglavica-chillout",
  vrtoglavicaKeys.chillout,
  vrtoglavicaBindings.chillout,
);
const infectedEvent = vrtoglavicaEvent(
  "vrtoglavica-infected",
  vrtoglavicaKeys.infected,
  vrtoglavicaBindings.infected,
);
const vrtoglavicaSatisfiedOccurrences = [
  { key: vrtoglavicaKeys.bodies, eventId: wrongBodiesEvent._id },
  { key: vrtoglavicaKeys.chillout, eventId: chilloutEvent._id },
  { key: vrtoglavicaKeys.infected, eventId: infectedEvent._id },
];

function makeVrtoglavicaState({ sourceFingerprint, bodiesExpectedBinding }) {
  return makeDb({
    events: [wrongBodiesEvent, chilloutEvent, infectedEvent],
    scrapedPosts: [vrtoglavicaPost],
    links: vrtoglavicaSatisfiedOccurrences.map((occurrence, index) => ({
      _id: `vrtoglavica-link-${index + 1}`,
      eventId: occurrence.eventId,
      sourceIdentity: vrtoglavicaSourceIdentity,
      sourceFingerprint,
      sourceOccurrenceKey: occurrence.key,
      instagramPostId: vrtoglavicaPost.postId,
      instagramPostUrl: vrtoglavicaPost.instagramPostUrl,
      linkedAt: 1,
      updatedAt: 1,
    })),
    receipts: [
      {
        _id: "vrtoglavica-receipt",
        sourceIdentity: vrtoglavicaSourceIdentity,
        sourceFingerprint,
        expectedKeys: Object.values(vrtoglavicaKeys),
        expectedOccurrences: [
          { ...bodiesExpectedBinding, key: vrtoglavicaKeys.bodies },
          vrtoglavicaBindings.chillout,
          vrtoglavicaBindings.infected,
        ],
        satisfiedKeys: Object.values(vrtoglavicaKeys),
        satisfiedOccurrences: vrtoglavicaSatisfiedOccurrences,
        deferredChildCount: 0,
        deferredChildKeys: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });
}

const vrtoglavicaNextPlan = {
  sourceIdentity: vrtoglavicaSourceIdentity,
  sourceFingerprint: vrtoglavicaNextFingerprint,
  expectedKeys: Object.values(vrtoglavicaKeys),
  expectedOccurrences: Object.values(vrtoglavicaBindings),
  deferredChildCount: 0,
  deferredChildKeys: [],
  observedChildKeys: Object.values(vrtoglavicaKeys),
  previousSourceFingerprint: vrtoglavicaOldFingerprint,
};

// Recording one valid sibling must not carry an old K->event mapping into a
// plan whose K now means a different event. Convex must abort before changing
// the receipt, link ledger, or event row.
const vrtoglavicaTransitionState = makeVrtoglavicaState({
  sourceFingerprint: vrtoglavicaOldFingerprint,
  bodiesExpectedBinding: vrtoglavicaBindings.chillout,
});
const beforeVrtoglavicaTransition = structuredClone({
  events: [...vrtoglavicaTransitionState.tables.events.values()],
  links: [...vrtoglavicaTransitionState.tables.instagramEventSources.values()],
  receipts: [
    ...vrtoglavicaTransitionState.tables.instagramSourceOccurrenceReceipts.values(),
  ],
});
await assert.rejects(
  () =>
    recordInstagramSourceOccurrenceSatisfaction._handler(
      adminCtx(vrtoglavicaTransitionState),
      {
        plan: vrtoglavicaNextPlan,
        satisfiedKey: vrtoglavicaKeys.infected,
        representativeEventId: infectedEvent._id,
        processingFence: vrtoglavicaProcessingFence,
      },
    ),
  /Retained source occurrence representative does not match/i,
);
assert.deepEqual(
  {
    events: [...vrtoglavicaTransitionState.tables.events.values()],
    links: [...vrtoglavicaTransitionState.tables.instagramEventSources.values()],
    receipts: [
      ...vrtoglavicaTransitionState.tables.instagramSourceOccurrenceReceipts.values(),
    ],
  },
  beforeVrtoglavicaTransition,
  "a retained-binding conflict must leave every provenance table unchanged",
);

// If a previous release already persisted the false-complete receipt, reads
// must derive liveness from the immutable representative snapshot and expose K
// as incomplete instead of trusting its collision key.
const persistedCorruptVrtoglavicaState = makeVrtoglavicaState({
  sourceFingerprint: vrtoglavicaNextFingerprint,
  bodiesExpectedBinding: vrtoglavicaBindings.bodies,
});
const liveVrtoglavicaReceipt = await getInstagramSourceOccurrenceReceipt._handler(
  adminCtx(persistedCorruptVrtoglavicaState),
  { sourceIdentity: vrtoglavicaSourceIdentity },
);
assert.deepEqual(liveVrtoglavicaReceipt.satisfiedKeys, [
  vrtoglavicaKeys.chillout,
  vrtoglavicaKeys.infected,
]);
assert.deepEqual(
  liveVrtoglavicaReceipt.satisfiedOccurrences.map((occurrence) => occurrence.key),
  [vrtoglavicaKeys.chillout, vrtoglavicaKeys.infected],
);

const lineupImageUrl = "https://example.com/para-lineup-poster.jpg";
const lineupStorageId = "storage-para-lineup-poster";
const lineupPost = {
  caption: "Male izmene i nova imena u klubu.",
  altText: null,
  locationName: null,
  username: "para_klub",
  handle: "para_klub",
  postId: "3968476210920527048",
  instagramPostUrl: "https://www.instagram.com/p/DcS3BaDgZTI/",
  postedAt: "2026-08-21T08:02:52.000Z",
  imageUrl: lineupImageUrl,
  imageUrls: [lineupImageUrl],
  postType: "image",
};
const lineupDateEvidence = {
  exact_text: "August 23rd 2026",
  source: "poster",
  is_relative: false,
  resolved_date: "2026-08-23",
};
const lineupSlot = (time, title, artists) => ({
  date: "23.08.2026",
  time,
  venue: "Para klub Beograd",
  title,
  artists,
  description: `${title} DJ set.`,
  source_text: `${time.replace("-", " - ")} - ${title}`,
  date_evidence: lineupDateEvidence,
  time_evidence: {
    status: "start_time_stated",
    exact_text: time.replace("-", " - "),
    source: "poster",
  },
});
const lineupSlots = [
  lineupSlot("14:00-17:00", "Anshi b2b Cvayn", ["Anshi", "Cvayn"]),
  lineupSlot("17:00-19:30", "Madji", ["Madji"]),
  lineupSlot("19:30-22:00", "Vagabond", ["Vagabond"]),
];
const lineupExtraction = {
  extraction_contract_version: "event_evidence_v2",
  is_event: true,
  non_event_reason: "",
  title: "",
  date: "",
  time: "",
  venue: "Para klub Beograd",
  city: "Belgrade",
  country: "Serbia",
  price: "",
  currency: "RSD",
  artists: [],
  category: "nightlife",
  description: "Three DJ sets featuring Anshi b2b Cvayn, Madji and Vagabond.",
  confidence: 0.95,
  reasoning_notes: "",
  source_caption: lineupPost.caption,
  source_url: lineupPost.instagramPostUrl,
  date_evidence: {
    exact_text: "",
    source: "unknown",
    is_relative: false,
    resolved_date: "",
  },
  time_evidence: {
    status: "not_stated",
    exact_text: "",
    source: "unknown",
  },
  source_conflicts: [],
  shared_schedule_context: {
    venue: {
      applies_to_all: true,
      value: "Para klub Beograd",
      evidence: "para (logo/header) on poster",
      source: "poster",
    },
    time: {
      applies_to_all: true,
      value: "14:00 - 22:00",
      evidence: "August 23rd 2026 14:00 - 22:00",
      source: "poster",
    },
  },
  schedule_entries: lineupSlots,
  field_confirmation: Object.fromEntries(
    [
      "title",
      "location",
      "location_name",
      "price",
      "start_time",
      "short_description",
      "artists",
    ].map((key) => [
      key,
      {
        confidence: 0.95,
        found_in: ["poster"],
        evidence: key,
        evidence_snippets: [{ source: "poster", text: key }],
        notes: "",
      },
    ]),
  ),
};
const preparedLineupResults = bindSourceOccurrenceMetadata(
  lineupPost,
  prepareEventsForInsert(
    lineupPost,
    lineupExtraction,
    lineupImageUrl,
    { para_klub: "Para klub Beograd" },
    {},
    { para_klub: "Para klub Beograd" },
    {
      eventDateFilterNow: new Date("2026-08-22T12:00:00.000Z"),
      sourceRolesByHandle: { para_klub: "venue" },
    },
  ),
);
assert.equal(preparedLineupResults.length, 1);
const preparedLineup = preparedLineupResults[0];
assert.equal(preparedLineup?.kind, "ok");
if (!preparedLineup || preparedLineup.kind !== "ok") {
  throw new Error("The Para timetable fixture must produce one aggregate event.");
}
assert.equal(preparedLineup.event.status, "approved");
assert.equal(preparedLineup.normalizedFields.lineupScheduleCoalesced, true);

const lineupSourceIdentity = "instagram-source-identity-v1:qa-para-lineup";
const lineupOldFingerprint = "instagram-source-v2:qa-para-lineup-old";
const lineupNextFingerprint =
  preparedLineup.normalizedFields.sourceOccurrenceSourceFingerprint;
const lineupPrimaryKey = preparedLineup.event.sourceOccurrenceKey;
assert.equal(typeof lineupNextFingerprint, "string");
assert.equal(typeof lineupPrimaryKey, "string");
assert.notEqual(lineupNextFingerprint, lineupOldFingerprint);
const lineupOccurrenceKeys = [
  lineupPrimaryKey,
  "instagram-occurrence-v2:qa-para-madji",
  "instagram-occurrence-v2:qa-para-vagabond",
];
const lineupEventIds = ["lineup-anshi", "lineup-madji", "lineup-vagabond"];
const lineupLinkIds = ["lineup-link-anshi", "lineup-link-madji", "lineup-link-vagabond"];

function legacyLineupNormalizedFields(slot, index) {
  const fields = structuredClone(preparedLineup.normalizedFields);
  delete fields.lineupScheduleCoalesced;
  delete fields.lineupScheduleCoalescingPolicyVersion;
  delete fields.lineupScheduleTimingMode;
  delete fields.lineupScheduleSourceRowCount;
  delete fields.lineupScheduleSourceEvidence;
  delete fields.lineupScheduleSlots;
  return {
    ...fields,
    title: slot.title,
    normalizedDate: "2026-08-23",
    time: slot.time,
    normalizedVenue: slot.venue,
    artists: slot.artists,
    description: slot.description,
    multiEventSplitDetected: true,
    multiEventSplitCount: 3,
    splitEventIndex: index + 1,
    splitEventTotal: 3,
    splitSourceLine: slot.source_text,
    rowSourceText: slot.source_text,
    sourceOccurrenceKey: lineupOccurrenceKeys[index],
    sourceOccurrenceSourceFingerprint: lineupOldFingerprint,
    sourceOccurrenceExpectedCount: 3,
    sourceOccurrenceExpectedKeys: lineupOccurrenceKeys,
    sourceOccurrenceDeferredChildCount: 0,
  };
}

const legacyLineupFields = lineupSlots.map(legacyLineupNormalizedFields);
const legacyLineupEvents = lineupSlots.map((slot, index) => ({
  ...preparedLineup.event,
  _id: lineupEventIds[index],
  _creationTime: index + 1,
  title: slot.title,
  time: slot.time,
  venueInstagramHandle: lineupPost.handle,
  timeSource: "poster",
  timeEvidenceText: slot.time_evidence.exact_text,
  timeConfidence: 0.95,
  timeStatus: "confirmed",
  timeEvidenceKind: "start_time_stated",
  artists: slot.artists,
  description: slot.description,
  imageUrl: lineupImageUrl,
  imageStorageId: lineupStorageId,
  sourceOccurrenceKey: lineupOccurrenceKeys[index],
  normalizedFieldsJson: JSON.stringify(legacyLineupFields[index]),
  status: "approved",
  createdAt: 100 + index,
  updatedAt: 200 + index,
}));
const lineupExpectedOccurrences = legacyLineupEvents.map((event) => ({
  key: event.sourceOccurrenceKey,
  date: event.date,
  time: event.time,
  venue: event.venue,
  title: event.title,
  artists: event.artists,
}));

function makeLineupState(options = {}) {
  return makeDb({
    events: legacyLineupEvents,
    links: legacyLineupEvents.map((event, index) => ({
      _id: lineupLinkIds[index],
      eventId: event._id,
      sourceIdentity: lineupSourceIdentity,
      sourceFingerprint: lineupOldFingerprint,
      sourceOccurrenceKey: event.sourceOccurrenceKey,
      instagramPostId: lineupPost.postId,
      instagramPostUrl: lineupPost.instagramPostUrl,
      ...(options.includeSourceLinkHandles === false
        ? {}
        : { sourceHandle: lineupPost.handle }),
      linkedAt: 300 + index,
      updatedAt: 400 + index,
    })),
    receipts: [
      {
        _id: "lineup-receipt",
        sourceIdentity: lineupSourceIdentity,
        sourceFingerprint: lineupOldFingerprint,
        expectedKeys: lineupOccurrenceKeys,
        expectedOccurrences:
          options.receiptExpectedOccurrences ?? lineupExpectedOccurrences,
        satisfiedKeys: lineupOccurrenceKeys,
        satisfiedOccurrences: legacyLineupEvents.map((event) => ({
          key: event.sourceOccurrenceKey,
          eventId: event._id,
        })),
        deferredChildCount: 0,
        deferredChildKeys: [],
        createdAt: 500,
        updatedAt: 501,
      },
    ],
    scrapedPosts: [
      {
        _id: "lineup-scraped-post",
        ...lineupPost,
        imageStorageId: lineupStorageId,
        analysisResultJson: preparedLineup.event.rawExtractionJson,
        analysisRevision: 1,
        analysisContractVersion: "event_evidence_v2",
        analysisIsEvent: true,
        analysisModel: "gpt-5-mini-2026-08-01",
        analysisImageSourceUrl: lineupImageUrl,
        analysisImageChecksumSha256: "a".repeat(64),
        sourceRevision: 1,
      },
    ],
    mediaAssets: [
      {
        _id: "lineup-media-asset",
        sourceKey: `instagram-post:${lineupPost.postId}`,
        sourceKind: "instagram_post",
        instagramPostId: lineupPost.postId,
        normalizedInstagramPostUrl: lineupPost.instagramPostUrl,
        storageId: lineupStorageId,
        url: lineupImageUrl,
        upstreamUrl: lineupImageUrl,
        mimeType: "image/jpeg",
        byteLength: 1234,
        checksumSha256: "a".repeat(64),
        createdAt: 1,
        updatedAt: 1,
        lastAttachedAt: 1,
      },
    ],
    userSavedEvents: [
      {
        _id: "legacy-save-primary",
        userId: "legacy-user-dedupe",
        eventId: lineupEventIds[0],
        savedAt: 1,
      },
      {
        _id: "legacy-save-dedupe",
        userId: "legacy-user-dedupe",
        eventId: lineupEventIds[1],
        savedAt: 2,
      },
      {
        _id: "legacy-save-move",
        userId: "legacy-user-move",
        eventId: lineupEventIds[2],
        savedAt: 3,
      },
    ],
    savedEvents: [
      {
        _id: "save-primary",
        userId: "clerk-user-dedupe",
        eventId: lineupEventIds[0],
        createdAt: 1,
      },
      {
        _id: "save-dedupe",
        userId: "clerk-user-dedupe",
        eventId: lineupEventIds[1],
        createdAt: 2,
      },
      {
        _id: "save-move",
        userId: "clerk-user-move",
        eventId: lineupEventIds[2],
        createdAt: 3,
      },
    ],
  });
}

function lineupCandidateVersion(eventIndex) {
  return {
    id: lineupEventIds[eventIndex],
    expectedUpdatedAt: legacyLineupEvents[eventIndex].updatedAt,
    expectedNormalizedFieldsJson: legacyLineupEvents[eventIndex].normalizedFieldsJson,
    expectedSourceLinkId: lineupLinkIds[eventIndex],
    expectedSourceLinkUpdatedAt: 400 + eventIndex,
  };
}

function validLineupArgs() {
  return {
    primary: lineupCandidateVersion(0),
    duplicates: [lineupCandidateVersion(1), lineupCandidateVersion(2)],
    expectedSourceIdentity: lineupSourceIdentity,
    expectedSourceFingerprint: lineupOldFingerprint,
    expectedOccurrenceKeys: lineupOccurrenceKeys,
    expectedReceiptId: "lineup-receipt",
    expectedReceiptUpdatedAt: 501,
    patch: {
      title: preparedLineup.event.title,
      time: preparedLineup.event.time,
      timeSource: preparedLineup.event.timeSource,
      timeEvidenceText: preparedLineup.event.timeEvidenceText,
      timeConfidence: preparedLineup.event.timeConfidence,
      timeStatus: preparedLineup.event.timeStatus,
      timeEvidenceKind: preparedLineup.event.timeEvidenceKind,
      artists: preparedLineup.event.artists,
      description: preparedLineup.event.description,
      normalizedFieldsJson: preparedLineup.event.normalizedFieldsJson,
      sourceOccurrenceKey: preparedLineup.event.sourceOccurrenceKey,
      sourceFingerprint: lineupNextFingerprint,
    },
    moderationNote:
      "Reviewed source timetable: consolidate the three consecutive Para Klub DJ slots.",
    serviceSecret: process.env.CRON_SECRET,
  };
}

function serviceCtx(state) {
  return {
    auth: { getUserIdentity: async () => null },
    db: state.db,
  };
}

function snapshotLineupState(state) {
  return structuredClone(
    Object.fromEntries(
      Object.entries(state.tables).map(([table, rows]) => [table, [...rows.values()]]),
    ),
  );
}

const adminLineupState = makeLineupState();
await assert.rejects(
  () =>
    coalesceApprovedNightlifeLineupOccurrences._handler(adminCtx(adminLineupState), {
      ...validLineupArgs(),
      serviceSecret: "wrong-secret",
    }),
  /requires service authentication/i,
  "An administrator must not bypass the service-only migration boundary.",
);

const nonFirstPrimaryState = makeLineupState();
const nonFirstPrimaryArgs = validLineupArgs();
await assert.rejects(
  () =>
    coalesceApprovedNightlifeLineupOccurrences._handler(
      serviceCtx(nonFirstPrimaryState),
      {
        ...nonFirstPrimaryArgs,
        primary: lineupCandidateVersion(1),
        duplicates: [lineupCandidateVersion(0), lineupCandidateVersion(2)],
      },
    ),
  /patch does not match the verified timetable plan/i,
  "Only the chronologically first source slot may be retained as the canonical row.",
);

const staleReceiptState = makeLineupState();
const staleReceiptBefore = snapshotLineupState(staleReceiptState);
await assert.rejects(
  () =>
    coalesceApprovedNightlifeLineupOccurrences._handler(
      serviceCtx(staleReceiptState),
      { ...validLineupArgs(), expectedReceiptUpdatedAt: 502 },
    ),
  /receipt precondition failed/i,
);
assert.deepEqual(snapshotLineupState(staleReceiptState), staleReceiptBefore);

const staleLinkState = makeLineupState();
const staleLinkBefore = snapshotLineupState(staleLinkState);
const staleLinkArgs = validLineupArgs();
await assert.rejects(
  () =>
    coalesceApprovedNightlifeLineupOccurrences._handler(serviceCtx(staleLinkState), {
      ...staleLinkArgs,
      primary: {
        ...staleLinkArgs.primary,
        expectedSourceLinkUpdatedAt: staleLinkArgs.primary.expectedSourceLinkUpdatedAt + 1,
      },
    }),
  /link precondition failed/i,
);
assert.deepEqual(snapshotLineupState(staleLinkState), staleLinkBefore);

const inconsistentSourceHandleState = makeLineupState();
inconsistentSourceHandleState.tables.instagramEventSources.set(lineupLinkIds[1], {
  ...inconsistentSourceHandleState.tables.instagramEventSources.get(lineupLinkIds[1]),
  sourceHandle: "different_handle",
});
const inconsistentSourceHandleBefore = snapshotLineupState(inconsistentSourceHandleState);
await assert.rejects(
  () =>
    coalesceApprovedNightlifeLineupOccurrences._handler(
      serviceCtx(inconsistentSourceHandleState),
      validLineupArgs(),
    ),
  /source handles are inconsistent/i,
  "A conflicting persisted source-link handle must remain fail-closed.",
);
assert.deepEqual(snapshotLineupState(inconsistentSourceHandleState), inconsistentSourceHandleBefore);

const unattestedMissingSourceHandleState = makeLineupState({
  includeSourceLinkHandles: false,
});
for (const eventId of lineupEventIds) {
  unattestedMissingSourceHandleState.tables.events.set(eventId, {
    ...unattestedMissingSourceHandleState.tables.events.get(eventId),
    venueInstagramHandle: undefined,
  });
}
const unattestedMissingSourceHandleBefore = snapshotLineupState(
  unattestedMissingSourceHandleState,
);
await assert.rejects(
  () =>
    coalesceApprovedNightlifeLineupOccurrences._handler(
      serviceCtx(unattestedMissingSourceHandleState),
      validLineupArgs(),
    ),
  /source handles are inconsistent/i,
  "A missing legacy link handle must have matching immutable and canonical handle attestations.",
);
assert.deepEqual(
  snapshotLineupState(unattestedMissingSourceHandleState),
  unattestedMissingSourceHandleBefore,
);

const conflictingVenueReceiptState = makeLineupState({
  receiptExpectedOccurrences: lineupExpectedOccurrences.map((occurrence, index) => ({
    ...occurrence,
    venue: index === 0 ? "Different Venue" : occurrence.venue,
  })),
});
const conflictingVenueReceiptBefore = snapshotLineupState(conflictingVenueReceiptState);
await assert.rejects(
  () =>
    coalesceApprovedNightlifeLineupOccurrences._handler(
      serviceCtx(conflictingVenueReceiptState),
      validLineupArgs(),
    ),
  /link precondition failed/i,
  "A nonblank conflicting receipt venue must remain fail-closed.",
);
assert.deepEqual(
  snapshotLineupState(conflictingVenueReceiptState),
  conflictingVenueReceiptBefore,
);

for (const nonemptyVenue of ["   ", "---"]) {
  const malformedVenueReceiptState = makeLineupState({
    receiptExpectedOccurrences: lineupExpectedOccurrences.map((occurrence) => ({
      ...occurrence,
      venue: nonemptyVenue,
    })),
  });
  const malformedVenueReceiptBefore = snapshotLineupState(malformedVenueReceiptState);
  await assert.rejects(
    () =>
      coalesceApprovedNightlifeLineupOccurrences._handler(
        serviceCtx(malformedVenueReceiptState),
        validLineupArgs(),
      ),
    /link precondition failed/i,
    "Only the exact legacy empty string may use the canonical venue fallback.",
  );
  assert.deepEqual(
    snapshotLineupState(malformedVenueReceiptState),
    malformedVenueReceiptBefore,
  );
}

const tamperedVenueCohortState = makeLineupState({
  receiptExpectedOccurrences: lineupExpectedOccurrences.map((occurrence) => ({
    ...occurrence,
    venue: "",
  })),
});
tamperedVenueCohortState.tables.events.set(lineupEventIds[1], {
  ...tamperedVenueCohortState.tables.events.get(lineupEventIds[1]),
  venue: "Different Venue",
});
const tamperedVenueCohortBefore = snapshotLineupState(tamperedVenueCohortState);
await assert.rejects(
  () =>
    coalesceApprovedNightlifeLineupOccurrences._handler(
      serviceCtx(tamperedVenueCohortState),
      validLineupArgs(),
    ),
  /rows do not share one exact source occurrence/i,
  "A blank legacy receipt must not bypass the exact common-venue cohort proof.",
);
assert.deepEqual(snapshotLineupState(tamperedVenueCohortState), tamperedVenueCohortBefore);

const blankLegacyVenueReceiptState = makeLineupState({
  includeSourceLinkHandles: false,
  receiptExpectedOccurrences: lineupExpectedOccurrences.map((occurrence) => ({
    ...occurrence,
    venue: "",
  })),
});
const blankLegacyVenueMergeResult =
  await coalesceApprovedNightlifeLineupOccurrences._handler(
    serviceCtx(blankLegacyVenueReceiptState),
    validLineupArgs(),
  );
assert.equal(blankLegacyVenueMergeResult.deletedDuplicateCount, 2);
assert.deepEqual([...blankLegacyVenueReceiptState.tables.events.keys()], [
  lineupEventIds[0],
]);
assert.equal(
  blankLegacyVenueReceiptState.tables.events.get(lineupEventIds[0]).venue,
  "Para klub Beograd",
);
assert.equal(
  blankLegacyVenueReceiptState.tables.instagramSourceOccurrenceReceipts.get(
    "lineup-receipt",
  ).expectedOccurrences[0].venue,
  "Para klub Beograd",
);
assert.equal(
  blankLegacyVenueReceiptState.tables.instagramEventSources.get(lineupLinkIds[0])
    .sourceHandle,
  lineupPost.handle,
);

const successfulLineupState = makeLineupState();
const lineupMergeResult = await coalesceApprovedNightlifeLineupOccurrences._handler(
  serviceCtx(successfulLineupState),
  validLineupArgs(),
);
assert.deepEqual(
  {
    primaryId: lineupMergeResult.primaryId,
    deletedDuplicateCount: lineupMergeResult.deletedDuplicateCount,
    movedSaveCount: lineupMergeResult.movedSaveCount,
    dedupedSaveCount: lineupMergeResult.dedupedSaveCount,
  },
  {
    primaryId: lineupEventIds[0],
    deletedDuplicateCount: 2,
    movedSaveCount: 2,
    dedupedSaveCount: 2,
  },
);
assert.deepEqual([...successfulLineupState.tables.events.keys()], [lineupEventIds[0]]);
assert.deepEqual(
  {
    title: successfulLineupState.tables.events.get(lineupEventIds[0]).title,
    time: successfulLineupState.tables.events.get(lineupEventIds[0]).time,
    artists: successfulLineupState.tables.events.get(lineupEventIds[0]).artists,
    description: successfulLineupState.tables.events.get(lineupEventIds[0]).description,
    sourceOccurrenceKey:
      successfulLineupState.tables.events.get(lineupEventIds[0]).sourceOccurrenceKey,
  },
  {
    title: "Anshi b2b Cvayn, Madji & Vagabond",
    time: "14:00-22:00",
    artists: ["Anshi", "Cvayn", "Madji", "Vagabond"],
    description:
      "14:00–17:00 Anshi b2b Cvayn; 17:00–19:30 Madji; 19:30–22:00 Vagabond.",
    sourceOccurrenceKey: lineupPrimaryKey,
  },
);
assert.deepEqual(
  [...successfulLineupState.tables.instagramEventSources.values()].map((link) => ({
    eventId: link.eventId,
    key: link.sourceOccurrenceKey,
    fingerprint: link.sourceFingerprint,
  })),
  [
    {
      eventId: lineupEventIds[0],
      key: lineupPrimaryKey,
      fingerprint: lineupNextFingerprint,
    },
  ],
);
const contractedLineupReceipt =
  successfulLineupState.tables.instagramSourceOccurrenceReceipts.get("lineup-receipt");
assert.equal(contractedLineupReceipt.sourceFingerprint, lineupNextFingerprint);
assert.deepEqual(contractedLineupReceipt.expectedKeys, [lineupPrimaryKey]);
assert.deepEqual(contractedLineupReceipt.satisfiedKeys, [lineupPrimaryKey]);
assert.deepEqual(contractedLineupReceipt.satisfiedOccurrences, [
  { key: lineupPrimaryKey, eventId: lineupEventIds[0] },
]);
assert.deepEqual(
  [...successfulLineupState.tables.userSavedEvents.values()].map((save) => [
    save.userId,
    save.eventId,
  ]),
  [
    ["legacy-user-dedupe", lineupEventIds[0]],
    ["legacy-user-move", lineupEventIds[0]],
  ],
);
assert.deepEqual(
  [...successfulLineupState.tables.savedEvents.values()].map((save) => [
    save.userId,
    save.eventId,
  ]),
  [
    ["clerk-user-dedupe", lineupEventIds[0]],
    ["clerk-user-move", lineupEventIds[0]],
  ],
);
assert.deepEqual(
  [...successfulLineupState.tables.eventAuditLog.values()].map((entry) => ({
    eventId: entry.eventId,
    action: entry.action,
    actor: entry.actor,
  })),
  [
    {
      eventId: lineupEventIds[1],
      action: "lineup_occurrence_folded",
      actor: "service:cron",
    },
    {
      eventId: lineupEventIds[2],
      action: "lineup_occurrence_folded",
      actor: "service:cron",
    },
    {
      eventId: lineupEventIds[0],
      action: "lineup_occurrences_coalesced",
      actor: "service:cron",
    },
  ],
);

console.log(
  "Occurrence merge safety QA passed: distinct rows survive, duplicate ledgers rewire, lineup receipts contract atomically, saves are preserved, and stale provenance fails closed.",
);
