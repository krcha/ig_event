import assert from "node:assert/strict";

import {
  executeCanonicalConsolidation,
  verifyCanonicalConsolidationCapability,
} from "../convex/internal/reconciliationCanonicalExecutor.ts";
import { authorizeServerVerifiedReconciliationRollout } from "../convex/internal/reconciliationRollout.ts";
import {
  buildOccurrenceSignature,
  toOccurrenceCandidateIndexFields,
} from "../lib/domain/occurrences/signature.ts";
import {
  classifyOccurrenceRelationshipInvariant,
  reconciliationOutcomesHaveSameFinalState,
  reconcileOccurrence,
  RECONCILIATION_POLICY_VERSION,
  sha256Hex,
} from "../lib/domain/reconciliation/index.ts";
import { classifyApprovalOccurrenceRelation } from "../lib/events/approval-occurrence-conflict.ts";

const QA_NOW = new Date("2026-08-28T12:00:00.000Z").getTime();
Date.now = () => QA_NOW;

assert.equal(
  sha256Hex("abc"),
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "Server evidence digests must be runtime-portable SHA-256.",
);

const relationFixtures = [
  {
    candidate: { artists: ["Artist"], time: "20:00", title: "Artist Live" },
    existing: { artists: ["Artist"], time: "20:00", title: "Artist Live" },
    sameSource: false,
    sameVenue: true,
    expected: "proven_duplicate",
  },
  {
    candidate: { artists: ["Artist"], time: "23:00", title: "Artist Live" },
    existing: { artists: ["Artist"], time: "20:00", title: "Artist Live" },
    sameSource: false,
    sameVenue: true,
    expected: "proven_distinct",
  },
  {
    candidate: { sourceOccurrenceKey: "child-a", title: "First Show" },
    existing: { sourceOccurrenceKey: "child-b", title: "Second Show" },
    sameSource: true,
    sameVenue: true,
    expected: "proven_distinct",
  },
  {
    candidate: {
      normalizedFieldsJson: JSON.stringify({
        sourceGroundingInstagramHandle: "promoter",
      }),
      sourceAccountHandle: "promoter",
      title: "Chapter IV",
    },
    existing: {
      artists: ["Artist"],
      normalizedFieldsJson: JSON.stringify({
        sourceGroundingInstagramHandle: "promoter",
      }),
      sourceAccountHandle: "promoter",
      time: "20:00",
      title: "Artist Live",
    },
    sameSource: false,
    sameVenue: true,
    expected: "ambiguous",
  },
];
for (const fixture of relationFixtures) {
  const { expected, ...input } = fixture;
  assert.equal(
    classifyOccurrenceRelationshipInvariant(input),
    expected,
    "The extracted domain invariant must retain the characterized relationship behavior.",
  );
  assert.equal(
    classifyApprovalOccurrenceRelation(input),
    classifyOccurrenceRelationshipInvariant(input),
    "The legacy approval API must remain a behavior-preserving wrapper over the domain invariant.",
  );
}

function occurrence(id, overrides = {}) {
  return {
    artists: ["Artist"],
    date: "2026-08-29",
    eventId: `event-${id}`,
    id,
    normalizedVenueIdentity: "id:venue-1",
    time: "20:00",
    title: "Artist Live",
    updatedAt: 10,
    venue: "KC Grad",
    venueId: "venue-1",
    ...overrides,
  };
}
const planned = reconcileOccurrence({
  candidates: [occurrence("candidate")],
  incoming: occurrence("incoming", { eventId: undefined }),
  intent: "ingest_occurrence",
  occurrenceTopologyEpoch: 1,
  sourceDocumentId: "post-1",
  sourceFingerprint: "fingerprint-1",
  sourceOccurrenceUpdatedAt: 10,
  sourceRevision: 1,
  venueResolutionStatus: "resolved",
});
const changedCandidate = reconcileOccurrence({
  candidates: [occurrence("candidate", { time: "23:00", updatedAt: 11 })],
  incoming: occurrence("incoming", { eventId: undefined }),
  intent: "ingest_occurrence",
  occurrenceTopologyEpoch: 1,
  sourceDocumentId: "post-1",
  sourceFingerprint: "fingerprint-1",
  sourceOccurrenceUpdatedAt: 10,
  sourceRevision: 1,
  venueResolutionStatus: "resolved",
});
assert.equal(
  reconciliationOutcomesHaveSameFinalState(planned, changedCandidate),
  false,
  "A changed candidate relationship/version must stale the complete outcome.",
);

function indexCriteria(configure) {
  const criteria = [];
  const builder = {
    eq(field, value) {
      criteria.push(["eq", field, value]);
      return builder;
    },
    gte(field, value) {
      criteria.push(["gte", field, value]);
      return builder;
    },
  };
  configure(builder);
  return criteria;
}

function makeDb(seed) {
  const tables = Object.fromEntries(
    Object.entries(seed).map(([table, values]) => [
      table,
      new Map(values.map((value) => [value._id, structuredClone(value)])),
    ]),
  );
  for (const table of ["eventAuditLog", "reconciliationAudits"]) {
    tables[table] ??= new Map();
  }
  let nextId = 1;
  const rows = (table) => [...(tables[table]?.values() ?? [])];
  const queryResult = (table, criteria = []) => {
    const matches = () =>
      rows(table).filter((row) =>
        criteria.every(([operator, field, value]) =>
          operator === "gte" ? row[field] >= value : row[field] === value,
        ),
      );
    return {
      async first() {
        return matches()[0] ?? null;
      },
      async take(limit) {
        return matches().slice(0, limit);
      },
      async unique() {
        const found = matches();
        if (found.length > 1) throw new Error(`Expected unique ${table} row.`);
        return found[0] ?? null;
      },
    };
  };
  return {
    tables,
    async delete(id) {
      for (const table of Object.values(tables)) {
        if (table.delete(id)) return;
      }
      throw new Error(`Missing delete target ${id}`);
    },
    async get(id) {
      for (const table of Object.values(tables)) {
        if (table.has(id)) return table.get(id);
      }
      return null;
    },
    async insert(table, value) {
      tables[table] ??= new Map();
      const id = `${table}-new-${nextId++}`;
      tables[table].set(id, {
        _creationTime: QA_NOW,
        _id: id,
        ...structuredClone(value),
      });
      return id;
    },
    async patch(id, patch) {
      for (const table of Object.values(tables)) {
        const row = table.get(id);
        if (row) {
          Object.assign(row, structuredClone(patch));
          return;
        }
      }
      throw new Error(`Missing patch target ${id}`);
    },
    query(table) {
      return {
        ...queryResult(table),
        withIndex(_indexName, configure) {
          return queryResult(table, indexCriteria(configure));
        },
      };
    },
  };
}

const signatureFields = toOccurrenceCandidateIndexFields(
  buildOccurrenceSignature({
    artists: ["Artist"],
    eventType: "music",
    localDate: "2026-08-29",
    time: "20:00",
    title: "Artist Live",
    venueId: "venue-1",
  }),
);
const normalizedFieldsJson = JSON.stringify({
  artists: ["Artist"],
  normalizedDate: "2026-08-29",
  normalizedVenue: "KC Grad",
  time: "20:00",
  title: "Artist Live",
});
const primaryEvent = {
  _creationTime: 1,
  _id: "event-primary",
  artists: ["Artist"],
  createdAt: 1,
  date: "2026-08-29",
  eventType: "music",
  normalizedFieldsJson,
  normalizedVenueIdentity: "id:venue-1",
  publicationEvaluatedAt: 1,
  publicationPolicyVersion: 1,
  publicationReason: "moderation_not_approved",
  publicationState: "hidden",
  status: "pending",
  time: "20:00",
  title: "Artist Live",
  updatedAt: 10,
  venue: "KC Grad",
  venueId: "venue-1",
  ...signatureFields,
};
const duplicateEvent = {
  ...primaryEvent,
  _id: "event-duplicate",
  updatedAt: 11,
};

function receipt(index, eventId) {
  const sourceIdentity = `instagram:POST${index}`;
  const key = `occurrence-${index}`;
  return {
    _creationTime: 1,
    _id: `receipt-${index}`,
    createdAt: 1,
    deferredChildCount: 0,
    deferredChildKeys: [],
    expectedKeys: [key],
    expectedOccurrences: [
      {
        artists: ["Artist"],
        date: "2026-08-29",
        key,
        time: "20:00",
        title: "Artist Live",
        venue: "KC Grad",
      },
    ],
    satisfiedKeys: [key],
    satisfiedOccurrences: [{ eventId, key }],
    sourceFingerprint: `fingerprint-${index}`,
    sourceIdentity,
    updatedAt: 1,
  };
}

function sourceOccurrence(index, eventId) {
  const sourceIdentity = `instagram:POST${index}`;
  const key = `occurrence-${index}`;
  return {
    _creationTime: 1,
    _id: `source-occurrence-${index}`,
    canonicalEventId: eventId,
    canonicalSourceUrl: `https://www.instagram.com/p/POST${index}/`,
    createdAt: 1,
    factsJson: JSON.stringify({
      artists: ["Artist"],
      date: "2026-08-29",
      key,
      time: "20:00",
      title: "Artist Live",
      venue: "KC Grad",
    }),
    normalizedOccurrenceJson: JSON.stringify({
      artists: ["Artist"],
      date: "2026-08-29",
      eventType: "music",
      key,
      time: "20:00",
      title: "Artist Live",
      venue: "KC Grad",
    }),
    occurrenceOrdinal: 0,
    provider: "instagram",
    sourceDocumentId: `post-${index}`,
    sourceFingerprint: `fingerprint-${index}`,
    sourceIdentity,
    sourceOccurrenceKey: key,
    sourceRevision: 1,
    state: "satisfied",
    updatedAt: 1,
    venueId: "venue-1",
    venueResolutionStatus: "resolved",
    ...signatureFields,
  };
}

function sourceLink(index, eventId) {
  return {
    _creationTime: 1,
    _id: `source-link-${index}`,
    eventId,
    linkedAt: 1,
    sourceFingerprint: `fingerprint-${index}`,
    sourceIdentity: `instagram:POST${index}`,
    sourceOccurrenceId: `source-occurrence-${index}`,
    sourceOccurrenceKey: `occurrence-${index}`,
    updatedAt: 1,
  };
}

const migrationRows = [
  "canonical-event-domain-fields-v1",
  "venue-identities-v1",
  "event-venue-bindings-v1",
  "source-occurrences-generic-v2",
  "source-occurrence-canonical-payload-v1",
].map((key, index) => ({
  _creationTime: 1,
  _id: `migration-${index}`,
  completedAt: 2,
  createdAt: 1,
  errorCount: 0,
  key,
  mismatchCount: 0,
  phase: "complete",
  scannedCount: 2,
  skippedCount: 0,
  updatedAt: 2,
  updatedCount: 2,
}));
migrationRows.push({
  _creationTime: 1,
  _id: "receipt-topology-audit",
  completedAt: 2,
  createdAt: 1,
  errorCount: 0,
  isDone: true,
  key: "source-occurrence-receipt-topology-v1",
  mismatchCount: 0,
  phase: "receipt_topology_audit",
  quarantinedLineageMarkerCount: 0,
  scannedCount: 2,
  skippedCount: 0,
  topologyEpoch: 1,
  unchangedCount: 2,
  updatedAt: 2,
  updatedCount: 0,
});

const consolidationSeed = {
  eventDomainMigrationState: migrationRows,
  events: [primaryEvent, duplicateEvent],
  instagramEventSources: [
    sourceLink(1, primaryEvent._id),
    sourceLink(2, duplicateEvent._id),
  ],
  instagramSourceOccurrenceReceipts: [
    receipt(1, primaryEvent._id),
    receipt(2, duplicateEvent._id),
  ],
  reconciliationRolloutState: [
    {
      _creationTime: 1,
      _id: "rollout-1",
      comparedCount: 2,
      completedAt: 2,
      coverageEndAt: 2,
      coverageStartAt: 1,
      createdAt: 1,
      errorCount: 0,
      evidenceDigestSha256: "a".repeat(64),
      expectedOccurrenceCount: 2,
      indeterminateCount: 0,
      key: "source-occurrence-reconciliation-apply-v1",
      matchedCount: 2,
      mismatchCount: 0,
      note: "QA server full-outcome review.",
      operatorEnabled: false,
      policyVersion: RECONCILIATION_POLICY_VERSION,
      reviewedBy: "qa",
      updatedAt: 2,
      verificationKind: "server_full_outcome_v1",
      verificationPhase: "ready_for_review",
      verificationRunId: "qa-full-outcome-run",
      verificationStartedAt: QA_NOW,
      verificationTopologyEpoch: 1,
      verifiedConsolidationEvidenceCount: 0,
      verifiedOperationKinds: ["attach"],
    },
  ],
  savedEvents: [
    {
      _creationTime: 1,
      _id: "save-primary",
      createdAt: 1,
      eventId: primaryEvent._id,
      userId: "subject-primary",
    },
    {
      _creationTime: 1,
      _id: "save-duplicate",
      createdAt: 2,
      eventId: duplicateEvent._id,
      userId: "subject-duplicate",
    },
    {
      _creationTime: 1,
      _id: "save-shared-primary",
      createdAt: 4,
      eventId: primaryEvent._id,
      userId: "subject-shared",
    },
    {
      _creationTime: 1,
      _id: "save-shared-duplicate",
      createdAt: 9,
      eventId: duplicateEvent._id,
      userId: "subject-shared",
    },
  ],
  sourceOccurrences: [
    sourceOccurrence(1, primaryEvent._id),
    sourceOccurrence(2, duplicateEvent._id),
  ],
  sourceOccurrenceTopologyEpoch: [
    {
      _creationTime: 1,
      _id: "topology-epoch-1",
      createdAt: 1,
      currentEpoch: 1,
      key: "source-occurrence-topology-v1",
      updatedAt: 1,
      verifiedEpoch: 1,
    },
  ],
  userSavedEvents: [
    {
      _creationTime: 1,
      _id: "legacy-save-duplicate",
      eventId: duplicateEvent._id,
      savedAt: 3,
      userId: "legacy-user-1",
    },
    {
      _creationTime: 1,
      _id: "legacy-save-shared-primary",
      eventId: primaryEvent._id,
      savedAt: 5,
      userId: "legacy-user-shared",
    },
    {
      _creationTime: 1,
      _id: "legacy-save-shared-duplicate",
      eventId: duplicateEvent._id,
      savedAt: 10,
      userId: "legacy-user-shared",
    },
  ],
};
const db = makeDb(consolidationSeed);
const rolloutState = [...db.tables.reconciliationRolloutState.values()][0];
const mergeCapability = await verifyCanonicalConsolidationCapability._handler(
  { db },
  {
    eventVersions: [
      { eventId: primaryEvent._id, expectedUpdatedAt: primaryEvent.updatedAt },
      {
        eventId: duplicateEvent._id,
        expectedUpdatedAt: duplicateEvent.updatedAt,
      },
    ],
    expectedRolloutUpdatedAt: rolloutState.updatedAt,
    intent: "merge_events",
    primaryEventId: primaryEvent._id,
  },
);
assert.deepEqual(mergeCapability.verifiedOperationKinds, ["attach", "merge"]);
const coalesceCapability =
  await verifyCanonicalConsolidationCapability._handler(
    { db },
    {
      eventVersions: [
        {
          eventId: primaryEvent._id,
          expectedUpdatedAt: primaryEvent.updatedAt,
        },
        {
          eventId: duplicateEvent._id,
          expectedUpdatedAt: duplicateEvent.updatedAt,
        },
      ],
      expectedRolloutUpdatedAt: mergeCapability.updatedAt,
      intent: "coalesce_events",
      primaryEventId: primaryEvent._id,
    },
  );
assert.deepEqual(coalesceCapability.verifiedOperationKinds, [
  "attach",
  "coalesce",
  "merge",
]);
const consolidationAuthorization =
  await authorizeServerVerifiedReconciliationRollout._handler(
    { db },
    {
      expectedEvidenceDigestSha256: coalesceCapability.evidenceDigestSha256,
      expectedUpdatedAt: coalesceCapability.updatedAt,
      expectedVerificationRunId: coalesceCapability.verificationRunId,
      note: "QA operator reviewed both bounded server consolidation capability proofs.",
      reviewedBy: "qa-operator",
    },
  );
assert.equal(consolidationAuthorization.operatorEnabled, true);
const consolidationEnabledState = structuredClone(
  [...db.tables.reconciliationRolloutState.values()][0],
);

const consolidated = await executeCanonicalConsolidation._handler(
  { db },
  {
    eventVersions: [
      { eventId: primaryEvent._id, expectedUpdatedAt: primaryEvent.updatedAt },
      {
        eventId: duplicateEvent._id,
        expectedUpdatedAt: duplicateEvent.updatedAt,
      },
    ],
    intent: "merge_events",
    mode: "apply",
    primaryEventId: primaryEvent._id,
  },
);
assert.equal(consolidated.applied, true);
assert.equal(consolidated.action, "merge");
assert.equal(consolidated.removedEventCount, 1);
assert.equal(db.tables.events.has(duplicateEvent._id), false);
assert.equal(
  db.tables.sourceOccurrences.get("source-occurrence-2").canonicalEventId,
  primaryEvent._id,
);
assert.equal(
  db.tables.instagramEventSources.get("source-link-2").eventId,
  primaryEvent._id,
);
assert.equal(
  db.tables.instagramSourceOccurrenceReceipts.get("receipt-2")
    .satisfiedOccurrences[0].eventId,
  primaryEvent._id,
);
assert.deepEqual(
  [...db.tables.savedEvents.values()].map((row) => row.userId).sort(),
  ["subject-duplicate", "subject-primary", "subject-shared"],
);
assert.equal(
  [...db.tables.savedEvents.values()].find(
    (row) => row.userId === "subject-shared",
  ).createdAt,
  9,
  "Save consolidation must preserve the newest canonical ordering timestamp.",
);
assert.equal(
  db.tables.userSavedEvents.get("legacy-save-duplicate").eventId,
  primaryEvent._id,
);
assert.equal(
  [...db.tables.userSavedEvents.values()].find(
    (row) => row.userId === "legacy-user-shared",
  ).savedAt,
  10,
  "Save consolidation must preserve the newest legacy ordering timestamp.",
);
assert.equal(db.tables.events.get(primaryEvent._id).publicationState, "hidden");
assert.equal(
  db.tables.sourceOccurrenceTopologyEpoch.get("topology-epoch-1").currentEpoch,
  db.tables.sourceOccurrenceTopologyEpoch.get("topology-epoch-1").verifiedEpoch,
);
assert.ok(
  db.tables.sourceOccurrenceTopologyEpoch.get("topology-epoch-1").currentEpoch >
    1,
);
assert.equal(
  [...db.tables.reconciliationAudits.values()].at(-1).mode,
  "applied",
);

const coalesceDb = makeDb({
  ...consolidationSeed,
  reconciliationRolloutState: [consolidationEnabledState],
});
const coalesced = await executeCanonicalConsolidation._handler(
  { db: coalesceDb },
  {
    eventVersions: [
      { eventId: primaryEvent._id, expectedUpdatedAt: primaryEvent.updatedAt },
      {
        eventId: duplicateEvent._id,
        expectedUpdatedAt: duplicateEvent.updatedAt,
      },
    ],
    intent: "coalesce_events",
    mode: "apply",
    primaryEventId: primaryEvent._id,
  },
);
assert.equal(coalesced.applied, true);
assert.equal(coalesced.action, "coalesce");
assert.equal(coalesceDb.tables.events.has(duplicateEvent._id), false);
assert.equal(
  coalesceDb.tables.sourceOccurrences.get("source-occurrence-2")
    .canonicalEventId,
  primaryEvent._id,
);
assert.equal(
  coalesceDb.tables.instagramEventSources.get("source-link-2").eventId,
  primaryEvent._id,
);
assert.equal(
  coalesceDb.tables.instagramSourceOccurrenceReceipts.get("receipt-2")
    .satisfiedOccurrences[0].eventId,
  primaryEvent._id,
);
assert.deepEqual(
  [...coalesceDb.tables.savedEvents.values()].map((row) => row.userId).sort(),
  ["subject-duplicate", "subject-primary", "subject-shared"],
);
assert.equal(
  coalesceDb.tables.userSavedEvents.get("legacy-save-duplicate").eventId,
  primaryEvent._id,
);
assert.equal(
  coalesceDb.tables.events.get(primaryEvent._id).publicationState,
  "hidden",
);
assert.equal(
  coalesceDb.tables.sourceOccurrenceTopologyEpoch.get("topology-epoch-1")
    .currentEpoch,
  coalesceDb.tables.sourceOccurrenceTopologyEpoch.get("topology-epoch-1")
    .verifiedEpoch,
);
assert.equal(
  [...coalesceDb.tables.reconciliationAudits.values()].at(-1).mode,
  "applied",
);

const richerDuplicate = {
  ...duplicateEvent,
  description: "Duplicate-only artist biography and ticket detail.",
};
const richerContentDb = makeDb({
  ...consolidationSeed,
  events: [primaryEvent, richerDuplicate],
});
const richerContentBefore = JSON.stringify({
  events: [...richerContentDb.tables.events.values()],
  links: [...richerContentDb.tables.instagramEventSources.values()],
  saves: [...richerContentDb.tables.savedEvents.values()],
});
const contentPreserved = await executeCanonicalConsolidation._handler(
  { db: richerContentDb },
  {
    eventVersions: [
      { eventId: primaryEvent._id, expectedUpdatedAt: primaryEvent.updatedAt },
      {
        eventId: richerDuplicate._id,
        expectedUpdatedAt: richerDuplicate.updatedAt,
      },
    ],
    intent: "merge_events",
    mode: "apply",
    primaryEventId: primaryEvent._id,
  },
);
assert.equal(contentPreserved.applied, false);
assert.equal(contentPreserved.action, "manual_review");
assert.equal(
  JSON.stringify({
    events: [...richerContentDb.tables.events.values()],
    links: [...richerContentDb.tables.instagramEventSources.values()],
    saves: [...richerContentDb.tables.savedEvents.values()],
  }),
  richerContentBefore,
  "Generic consolidation must not discard richer duplicate-only canonical content.",
);

const distinctSignatureFields = toOccurrenceCandidateIndexFields(
  buildOccurrenceSignature({
    artists: ["Artist"],
    eventType: "music",
    localDate: "2026-08-29",
    time: "23:00",
    title: "Artist Live",
    venueId: "venue-1",
  }),
);
const distinctEvent = {
  ...duplicateEvent,
  time: "23:00",
  ...distinctSignatureFields,
};
const distinctDb = makeDb({
  ...consolidationSeed,
  events: [primaryEvent, distinctEvent],
});
const distinctStateBefore = JSON.stringify({
  events: [...distinctDb.tables.events.values()],
  links: [...distinctDb.tables.instagramEventSources.values()],
  occurrences: [...distinctDb.tables.sourceOccurrences.values()],
  receipts: [...distinctDb.tables.instagramSourceOccurrenceReceipts.values()],
  savedEvents: [...distinctDb.tables.savedEvents.values()],
  userSavedEvents: [...distinctDb.tables.userSavedEvents.values()],
});
const keptDistinct = await executeCanonicalConsolidation._handler(
  { db: distinctDb },
  {
    eventVersions: [
      { eventId: primaryEvent._id, expectedUpdatedAt: primaryEvent.updatedAt },
      {
        eventId: distinctEvent._id,
        expectedUpdatedAt: distinctEvent.updatedAt,
      },
    ],
    intent: "merge_events",
    mode: "apply",
    primaryEventId: primaryEvent._id,
  },
);
assert.equal(keptDistinct.applied, false);
assert.equal(keptDistinct.action, "keep_distinct");
assert.equal(distinctDb.tables.events.has(distinctEvent._id), true);
assert.equal(
  [...distinctDb.tables.reconciliationAudits.values()].at(-1).mode,
  "rejected",
);
assert.equal(
  JSON.stringify({
    events: [...distinctDb.tables.events.values()],
    links: [...distinctDb.tables.instagramEventSources.values()],
    occurrences: [...distinctDb.tables.sourceOccurrences.values()],
    receipts: [...distinctDb.tables.instagramSourceOccurrenceReceipts.values()],
    savedEvents: [...distinctDb.tables.savedEvents.values()],
    userSavedEvents: [...distinctDb.tables.userSavedEvents.values()],
  }),
  distinctStateBefore,
  "keep_distinct must be an audited no-op across every topology and publication table.",
);

const ambiguousSignatureFields = toOccurrenceCandidateIndexFields(
  buildOccurrenceSignature({
    artists: ["Other Artist"],
    eventType: "music",
    localDate: "2026-08-29",
    time: "20:00",
    title: "Mystery",
    venueId: "venue-1",
  }),
);
const ambiguousEvent = {
  ...duplicateEvent,
  artists: ["Other Artist"],
  title: "Mystery",
  ...ambiguousSignatureFields,
};
const manualDb = makeDb({
  ...consolidationSeed,
  events: [primaryEvent, ambiguousEvent],
});
const manualStateBefore = JSON.stringify({
  events: [...manualDb.tables.events.values()],
  links: [...manualDb.tables.instagramEventSources.values()],
  occurrences: [...manualDb.tables.sourceOccurrences.values()],
  receipts: [...manualDb.tables.instagramSourceOccurrenceReceipts.values()],
  savedEvents: [...manualDb.tables.savedEvents.values()],
  userSavedEvents: [...manualDb.tables.userSavedEvents.values()],
});
const manual = await executeCanonicalConsolidation._handler(
  { db: manualDb },
  {
    eventVersions: [
      { eventId: primaryEvent._id, expectedUpdatedAt: primaryEvent.updatedAt },
      {
        eventId: ambiguousEvent._id,
        expectedUpdatedAt: ambiguousEvent.updatedAt,
      },
    ],
    intent: "merge_events",
    mode: "apply",
    primaryEventId: primaryEvent._id,
  },
);
assert.equal(manual.applied, false);
assert.equal(manual.action, "manual_review");
assert.equal(
  [...manualDb.tables.reconciliationAudits.values()].at(-1).mode,
  "rejected",
);
assert.equal(
  JSON.stringify({
    events: [...manualDb.tables.events.values()],
    links: [...manualDb.tables.instagramEventSources.values()],
    occurrences: [...manualDb.tables.sourceOccurrences.values()],
    receipts: [...manualDb.tables.instagramSourceOccurrenceReceipts.values()],
    savedEvents: [...manualDb.tables.savedEvents.values()],
    userSavedEvents: [...manualDb.tables.userSavedEvents.values()],
  }),
  manualStateBefore,
  "manual_review must be an audited no-op across every topology and publication table.",
);

console.log("Full-outcome reconciliation and generic consolidation QA passed.");
