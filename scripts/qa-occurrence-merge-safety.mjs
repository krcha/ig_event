import assert from "node:assert/strict";

import {
  createEvent,
  getInstagramSourceOccurrenceReceipt,
  mergeApprovedEvents,
  recordInstagramSourceOccurrenceSatisfaction,
} from "../convex/events.ts";
import { classifyApprovalOccurrenceRelation } from "../lib/events/approval-occurrence-conflict.ts";

process.env.ADMIN_CLERK_USER_IDS = "qa-merge-admin";

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
}) {
  const tables = {
    events: new Map(eventRows.map((row) => [row._id, structuredClone(row)])),
    instagramEventSources: new Map(links.map((row) => [row._id, structuredClone(row)])),
    instagramSourceOccurrenceReceipts: new Map(
      receipts.map((row) => [row._id, structuredClone(row)]),
    ),
    scrapedPosts: new Map(scrapedPosts.map((row) => [row._id, structuredClone(row)])),
    venues: new Map(venues.map((row) => [row._id, structuredClone(row)])),
    userSavedEvents: new Map(),
    savedEvents: new Map(),
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

console.log(
  "Occurrence merge safety QA passed: distinct rows survive, duplicate ledgers rewire, empty-venue receipts persist, and unknown-venue approvals fail closed.",
);
