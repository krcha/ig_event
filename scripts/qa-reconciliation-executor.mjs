import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  executeLatestSourceOccurrenceShadow,
  executeSourceOccurrence,
  verifyReconciliationRolloutBatch,
} from "../convex/reconciliation.ts";
import { reconcileIngestionPlan } from "../convex/reconciliationIngress.ts";
import {
  authorizeServerVerifiedReconciliationRollout,
  recordReconciliationRolloutReview,
} from "../convex/internal/reconciliationRollout.ts";
import {
  buildOccurrenceSignature,
  toOccurrenceCandidateIndexFields,
} from "../lib/domain/occurrences/signature.ts";
import { buildInstagramSourceOccurrenceFingerprint } from "../lib/domain/occurrences/source-fingerprint.ts";
import { adaptInstagramScrapedPostToSourceDocument } from "../lib/domain/source-documents.ts";
import { DomainError } from "../lib/domain/errors.ts";
import { RECONCILIATION_POLICY_VERSION } from "../lib/domain/reconciliation/index.ts";

const QA_NOW = new Date("2026-08-27T18:00:00.000Z").getTime();
Date.now = () => QA_NOW;

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reconciliationAuthorityFiles = [
  join(projectRoot, "convex/reconciliation.ts"),
  ...readdirSync(join(projectRoot, "convex/internal"))
    .filter((name) => /^reconciliation.*\.ts$/u.test(name))
    .map((name) => join(projectRoot, "convex/internal", name)),
];
const reconciliationAuthoritySet = new Set(reconciliationAuthorityFiles);
const importPattern = /\bfrom\s+["']([^"']+)["']/gu;
const authorityEdges = new Map(
  reconciliationAuthorityFiles.map((file) => {
    const source = readFileSync(file, "utf8");
    const imports = [...source.matchAll(importPattern)]
      .map((match) => match[1])
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) => {
        const absolute = resolve(dirname(file), specifier);
        return absolute.endsWith(".ts") ? absolute : `${absolute}.ts`;
      })
      .filter((target) => reconciliationAuthoritySet.has(target));
    return [file, imports];
  }),
);
const visiting = new Set();
const visited = new Set();
function assertAuthorityGraphAcyclic(file, path = []) {
  if (visiting.has(file)) {
    assert.fail(
      `Reconciliation authority import cycle: ${[...path, file]
        .map((entry) => entry.slice(projectRoot.length + 1))
        .join(" -> ")}`,
    );
  }
  if (visited.has(file)) return;
  visiting.add(file);
  for (const target of authorityEdges.get(file) ?? []) {
    assertAuthorityGraphAcyclic(target, [...path, file]);
  }
  visiting.delete(file);
  visited.add(file);
}
for (const file of reconciliationAuthorityFiles) {
  assertAuthorityGraphAcyclic(file);
}
assert.doesNotMatch(
  readFileSync(
    join(projectRoot, "convex/internal/reconciliationCanonicalExecutor.ts"),
    "utf8",
  ),
  /from\s+["']\.\.\/reconciliation["']/u,
  "The canonical executor must not import the mutation entrypoint as its apply authority.",
);

const completedMigrationState = [
  "canonical-event-domain-fields-v1",
  "venue-identities-v1",
  "event-venue-bindings-v1",
  "legacy-source-identity-canonicalization-v1",
  "legacy-source-occurrence-admission-v1",
  "source-occurrences-generic-v2",
  "source-occurrence-canonical-payload-v1",
].map((key, index) => ({
  _creationTime: 1,
  _id: `migration-${index + 1}`,
  completedAt: 2,
  createdAt: 1,
  cursor: "done",
  key,
  mismatchCount: 0,
  phase: "qa",
  scannedCount: 1,
  updatedAt: 2,
  updatedCount: 1,
}));
completedMigrationState.push({
  _creationTime: 1,
  _id: "migration-receipt-topology",
  completedAt: 2,
  createdAt: 1,
  cursor: "done",
  errorCount: 0,
  isDone: true,
  key: "source-occurrence-receipt-topology-v1",
  mismatchCount: 0,
  phase: "receipt_topology_audit",
  quarantinedLineageMarkerCount: 0,
  scannedCount: 1,
  skippedCount: 0,
  topologyEpoch: 1,
  unchangedCount: 1,
  updatedAt: 2,
  updatedCount: 0,
});

const enabledRolloutState = [
  {
    _creationTime: 1,
    _id: "rollout-1",
    comparedCount: 1,
    completedAt: 2,
    coverageEndAt: 2,
    coverageStartAt: 1,
    createdAt: 1,
    errorCount: 0,
    evidenceDigestSha256: "a".repeat(64),
    expectedOccurrenceCount: 1,
    indeterminateCount: 0,
    key: "source-occurrence-reconciliation-apply-v1",
    matchedCount: 1,
    mismatchCount: 0,
    note: "QA reviewed complete shadow comparison window.",
    operatorEnabled: true,
    policyVersion: RECONCILIATION_POLICY_VERSION,
    reviewedBy: "qa-operator",
    updatedAt: 2,
    verificationKind: "server_full_outcome_v1",
    verificationPhase: "enabled",
    verificationRunId: "qa-server-verification-run",
    verificationStartedAt: 1,
    verificationTopologyEpoch: 1,
    verifiedConsolidationEvidenceCount: 2,
    verifiedOperationKinds: ["attach", "coalesce", "create", "merge", "update"],
    reviewedAt: 2,
  },
];

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
  for (const table of [
    "eventAuditLog",
    "instagramEventSources",
    "reconciliationAudits",
    "venueIdentities",
  ]) {
    tables[table] ??= new Map();
  }
  if (!("reconciliationRolloutState" in seed)) {
    tables.reconciliationRolloutState = new Map(
      enabledRolloutState.map((row) => [row._id, structuredClone(row)]),
    );
  }
  if (!("sourceOccurrenceTopologyEpoch" in seed)) {
    tables.sourceOccurrenceTopologyEpoch = new Map([
      [
        "topology-epoch-1",
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
    ]);
  }
  if (tables.venueIdentities.size === 0) {
    tables.venueIdentities.set("venue-identity-1", {
      _creationTime: 1,
      _id: "venue-identity-1",
      active: true,
      kind: "canonical_name",
      normalizedValue: "kc grad",
      rawValue: "KC Grad",
      source: "venue_record",
      venueId: "venue-1",
    });
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
    const result = {
      order(direction) {
        const ordered = queryResult(table, criteria);
        ordered._direction = direction;
        return ordered;
      },
      async paginate({ cursor, numItems }) {
        const orderedRows = matches().sort((left, right) => {
          const comparison = String(left._id).localeCompare(String(right._id));
          return result._direction === "desc" ? -comparison : comparison;
        });
        const offset = cursor ? Number(cursor) : 0;
        const page = orderedRows.slice(offset, offset + numItems);
        const nextOffset = offset + page.length;
        return {
          continueCursor: String(nextOffset),
          isDone: nextOffset >= orderedRows.length,
          page,
        };
      },
      async take(limit) {
        return matches().slice(0, limit);
      },
      async first() {
        return matches()[0] ?? null;
      },
      async unique() {
        const found = matches();
        if (found.length > 1) throw new Error(`Expected unique ${table} row.`);
        return found[0] ?? null;
      },
    };
    return result;
  };
  return {
    tables,
    async get(id) {
      for (const table of Object.values(tables)) {
        if (table.has(id)) return table.get(id);
      }
      return null;
    },
    async insert(table, value) {
      tables[table] ??= new Map();
      const id = `${table}-${nextId++}`;
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
        withIndex(_index, configure) {
          return queryResult(table, indexCriteria(configure));
        },
      };
    },
  };
}

const signatureFields = toOccurrenceCandidateIndexFields(
  buildOccurrenceSignature({
    artists: ["Artist One"],
    eventType: "music",
    localDate: "2026-08-29",
    time: "20:00",
    title: "Artist One Live",
    venueId: "venue-1",
  }),
);
const sourceDocument = {
  _creationTime: 1,
  _id: "post-1",
  analysisResultJson: "{}",
  caption: "Artist One Live, 29 August at 20:00",
  createdAt: 1,
  handle: "promoter",
  imageStorageId: "storage-poster-1",
  imageUrl: "https://images.example.test/poster-1.jpg",
  imageUrls: [],
  instagramPostUrl: "https://www.instagram.com/reel/POSTONE/?utm_source=test",
  postId: "POSTONE",
  processingLeaseExpiresAt: QA_NOW + 60_000,
  processingLeaseOwner: "worker-1",
  processingStatus: "processing",
  sourceRevision: 3,
  updatedAt: 1,
  username: "promoter",
};
const sourceOccurrence = {
  _creationTime: 1,
  _id: "occurrence-1",
  canonicalSourceUrl: "https://www.instagram.com/p/POSTONE/",
  createdAt: 1,
  factsJson: JSON.stringify({
    artists: ["Artist One"],
    date: "2026-08-29",
    key: "source-key-1",
    time: "20:00",
    title: "Artist One Live",
    venue: "KC Grad",
  }),
  normalizedOccurrenceJson: JSON.stringify({
    artists: ["Artist One"],
    date: "2026-08-29",
    eventType: "music",
    time: "20:00",
    title: "Artist One Live",
    venue: "KC Grad",
    venueId: "venue-1",
  }),
  occurrenceOrdinal: 0,
  provider: "instagram",
  sourceDocumentId: "post-1",
  sourceFingerprint: "fingerprint-1",
  sourceIdentity: "instagram:POSTONE",
  sourceOccurrenceKey: "source-key-1",
  sourceRevision: 3,
  state: "expected",
  updatedAt: 10,
  venueId: "venue-1",
  venueResolutionStatus: "resolved",
  ...signatureFields,
};
const candidate = {
  _creationTime: 1,
  _id: "event-1",
  artists: ["Artist One"],
  createdAt: 1,
  date: "2026-08-29",
  eventType: "music",
  normalizedVenueIdentity: "id:venue-1",
  publicationEvaluatedAt: 1,
  publicationPolicyVersion: 1,
  publicationReason: "moderation_not_approved",
  publicationState: "hidden",
  status: "pending",
  time: "20:00",
  title: "Artist One Live",
  updatedAt: 20,
  venue: "KC Grad",
  venueId: "venue-1",
  ...signatureFields,
};
const venue = {
  _creationTime: 1,
  _id: "venue-1",
  aliases: ["Kulturni centar Grad"],
  category: "cultural_center",
  createdAt: 1,
  instagramHandle: "kcgrad",
  name: "KC Grad",
  publicStatus: "published",
  scrapeActive: true,
  updatedAt: 1,
};
const receipt = {
  _creationTime: 1,
  _id: "receipt-1",
  createdAt: 1,
  deferredChildCount: 0,
  deferredChildKeys: [],
  expectedKeys: ["source-key-1"],
  expectedOccurrences: [
    {
      artists: ["Artist One"],
      date: "2026-08-29",
      key: "source-key-1",
      time: "20:00",
      title: "Artist One Live",
      venue: "KC Grad",
    },
  ],
  satisfiedKeys: [],
  satisfiedOccurrences: [],
  sourceFingerprint: "fingerprint-1",
  sourceIdentity: "instagram:POSTONE",
  updatedAt: 1,
};

const db = makeDb({
  eventDomainMigrationState: completedMigrationState,
  events: [candidate],
  instagramEventSources: [
    {
      _creationTime: 1,
      _id: "verification-source-link",
      eventId: "event-1",
      linkedAt: 1,
      sourceFingerprint: "fingerprint-1",
      sourceHandle: "promoter",
      sourceIdentity: "instagram:POSTONE",
      sourceOccurrenceId: "occurrence-1",
      sourceOccurrenceKey: "source-key-1",
      updatedAt: 10,
    },
  ],
  instagramSourceOccurrenceReceipts: [
    {
      ...receipt,
      satisfiedKeys: ["source-key-1"],
      satisfiedOccurrences: [{ eventId: "event-1", key: "source-key-1" }],
    },
  ],
  reconciliationRolloutState: [],
  scrapedPosts: [sourceDocument],
  sourceOccurrences: [
    {
      ...sourceOccurrence,
      canonicalEventId: "event-1",
      state: "satisfied",
    },
  ],
  venues: [venue],
});
const independentlyObservedShadow =
  await executeLatestSourceOccurrenceShadow._handler(
    { db },
    { legacyOutcome: "attach", sourceOccurrenceId: "occurrence-1" },
  );
assert.equal(independentlyObservedShadow.plan.action, "attach");
const serverVerification = await verifyReconciliationRolloutBatch._handler(
  { db },
  { limit: 1 },
);
assert.equal(serverVerification.isDone, true);
assert.equal(serverVerification.phase, "ready_for_review");
assert.equal(serverVerification.operatorEnabled, false);
const serverVerifiedState = [
  ...db.tables.reconciliationRolloutState.values(),
][0];
assert.equal(serverVerifiedState.verificationKind, "server_full_outcome_v1");
assert.equal(serverVerifiedState.operatorEnabled, false);
assert.deepEqual(serverVerifiedState.verifiedOperationKinds, ["attach"]);
const authorization =
  await authorizeServerVerifiedReconciliationRollout._handler(
    { db },
    {
      expectedEvidenceDigestSha256: serverVerification.evidenceDigestSha256,
      expectedUpdatedAt: serverVerification.updatedAt,
      expectedVerificationRunId: serverVerification.verificationRunId,
      note: "QA operator reviewed the complete server full-outcome evidence.",
      reviewedBy: "qa-operator",
    },
  );
assert.equal(authorization.operatorEnabled, true);
assert.equal(serverVerifiedState.verificationPhase, "enabled");

const secondSourceDocument = {
  ...sourceDocument,
  _id: "post-2",
  instagramPostUrl: "https://www.instagram.com/p/POSTTWO/",
  postId: "POSTTWO",
};
const secondSourceOccurrence = {
  ...sourceOccurrence,
  _id: "occurrence-2",
  canonicalSourceUrl: "https://www.instagram.com/p/POSTTWO/",
  sourceDocumentId: "post-2",
  sourceFingerprint: "fingerprint-2",
  sourceIdentity: "instagram:POSTTWO",
  sourceOccurrenceKey: "source-key-2",
  factsJson: JSON.stringify({
    artists: ["Artist One"],
    date: "2026-08-29",
    key: "source-key-2",
    time: "20:00",
    title: "Artist One Live",
    venue: "KC Grad",
  }),
};
const secondReceipt = {
  ...receipt,
  _id: "receipt-2",
  expectedKeys: ["source-key-2"],
  expectedOccurrences: [
    {
      artists: ["Artist One"],
      date: "2026-08-29",
      key: "source-key-2",
      time: "20:00",
      title: "Artist One Live",
      venue: "KC Grad",
    },
  ],
  sourceFingerprint: "fingerprint-2",
  sourceIdentity: "instagram:POSTTWO",
};
const twoOccurrenceMigrations = completedMigrationState.map((row) =>
  row.key === "source-occurrence-receipt-topology-v1"
    ? { ...row, scannedCount: 2, unchangedCount: 2 }
    : row,
);
async function makeObservedVerificationDb() {
  const observedDb = makeDb({
    eventDomainMigrationState: twoOccurrenceMigrations,
    events: [candidate],
    instagramEventSources: [
      {
        _creationTime: 1,
        _id: "observed-link-1",
        eventId: "event-1",
        linkedAt: 1,
        sourceFingerprint: "fingerprint-1",
        sourceHandle: "promoter",
        sourceIdentity: "instagram:POSTONE",
        sourceOccurrenceId: "occurrence-1",
        sourceOccurrenceKey: "source-key-1",
        updatedAt: 10,
      },
      {
        _creationTime: 1,
        _id: "observed-link-2",
        eventId: "event-1",
        linkedAt: 1,
        sourceFingerprint: "fingerprint-2",
        sourceHandle: "promoter",
        sourceIdentity: "instagram:POSTTWO",
        sourceOccurrenceId: "occurrence-2",
        sourceOccurrenceKey: "source-key-2",
        updatedAt: 10,
      },
    ],
    instagramSourceOccurrenceReceipts: [
      {
        ...receipt,
        satisfiedKeys: ["source-key-1"],
        satisfiedOccurrences: [{ eventId: "event-1", key: "source-key-1" }],
      },
      {
        ...secondReceipt,
        satisfiedKeys: ["source-key-2"],
        satisfiedOccurrences: [{ eventId: "event-1", key: "source-key-2" }],
      },
    ],
    reconciliationRolloutState: [],
    scrapedPosts: [sourceDocument, secondSourceDocument],
    sourceOccurrences: [
      {
        ...sourceOccurrence,
        canonicalEventId: "event-1",
        state: "satisfied",
      },
      {
        ...secondSourceOccurrence,
        canonicalEventId: "event-1",
        state: "satisfied",
      },
    ],
    venues: [venue],
  });
  for (const sourceOccurrenceId of ["occurrence-1", "occurrence-2"]) {
    const observed = await executeLatestSourceOccurrenceShadow._handler(
      { db: observedDb },
      { legacyOutcome: "attach", sourceOccurrenceId },
    );
    assert.equal(observed.plan.action, "attach");
  }
  return observedDb;
}
const resumableDb = await makeObservedVerificationDb();
const firstVerificationPage = await verifyReconciliationRolloutBatch._handler(
  { db: resumableDb },
  { limit: 1 },
);
assert.equal(firstVerificationPage.isDone, false);
assert.equal(firstVerificationPage.phase, "scanning");
assert.equal(firstVerificationPage.expectedOccurrenceCount, 1);
await assert.rejects(
  verifyReconciliationRolloutBatch._handler(
    { db: resumableDb },
    { limit: 1, restartCompleted: true },
  ),
  /in-progress verification run cannot be restarted/i,
);
const secondVerificationPage = await verifyReconciliationRolloutBatch._handler(
  { db: resumableDb },
  { limit: 1 },
);
assert.equal(secondVerificationPage.isDone, true);
assert.equal(secondVerificationPage.phase, "ready_for_review");
assert.equal(secondVerificationPage.expectedOccurrenceCount, 2);
assert.equal(
  secondVerificationPage.verificationRunId,
  firstVerificationPage.verificationRunId,
);
resumableDb.tables.sourceOccurrenceTopologyEpoch.get(
  "topology-epoch-1",
).currentEpoch = 2;
resumableDb.tables.sourceOccurrenceTopologyEpoch.get(
  "topology-epoch-1",
).verifiedEpoch = 2;
await assert.rejects(
  authorizeServerVerifiedReconciliationRollout._handler(
    { db: resumableDb },
    {
      expectedEvidenceDigestSha256: secondVerificationPage.evidenceDigestSha256,
      expectedUpdatedAt: secondVerificationPage.updatedAt,
      expectedVerificationRunId: secondVerificationPage.verificationRunId,
      note: "QA refuses authorization after the verified topology snapshot changed.",
      reviewedBy: "qa-operator",
    },
  ),
  /topology changed after server verification/i,
);

const staleResumeDb = await makeObservedVerificationDb();
await verifyReconciliationRolloutBatch._handler(
  { db: staleResumeDb },
  { limit: 1 },
);
staleResumeDb.tables.sourceOccurrenceTopologyEpoch.get(
  "topology-epoch-1",
).currentEpoch = 2;
staleResumeDb.tables.sourceOccurrenceTopologyEpoch.get(
  "topology-epoch-1",
).verifiedEpoch = 2;
await assert.rejects(
  verifyReconciliationRolloutBatch._handler(
    { db: staleResumeDb },
    { limit: 1 },
  ),
  /stable, completely verified topology epoch/i,
  "A resumed verifier must reject even a safely advanced topology epoch because its snapshot changed.",
);
const inputDriftDb = await makeObservedVerificationDb();
await verifyReconciliationRolloutBatch._handler(
  { db: inputDriftDb },
  { limit: 1 },
);
inputDriftDb.tables.events.get("event-1").updatedAt = QA_NOW;
await assert.rejects(
  verifyReconciliationRolloutBatch._handler({ db: inputDriftDb }, { limit: 1 }),
  /verification inputs changed.*restart verification/i,
  "A resumed verifier must reject canonical/source/venue input drift from an earlier page.",
);

const receiptMismatchDb = await makeObservedVerificationDb();
receiptMismatchDb.tables.instagramSourceOccurrenceReceipts.get(
  "receipt-1",
).expectedOccurrences[0].title = "Different receipt title";
const receiptMismatchVerification =
  await verifyReconciliationRolloutBatch._handler(
    { db: receiptMismatchDb },
    { limit: 2 },
  );
assert.equal(receiptMismatchVerification.phase, "blocked");
assert.ok(
  receiptMismatchVerification.mismatchCount +
    receiptMismatchVerification.errorCount >
    0,
  "Server verification must reject receipt facts that the executor would reject.",
);

const missingIndependentEvidenceDb = await makeObservedVerificationDb();
missingIndependentEvidenceDb.tables.reconciliationAudits.clear();
const missingIndependentEvidence =
  await verifyReconciliationRolloutBatch._handler(
    { db: missingIndependentEvidenceDb },
    { limit: 2 },
  );
assert.equal(missingIndependentEvidence.phase, "blocked");
assert.equal(missingIndependentEvidence.indeterminateCount, 2);
assert.deepEqual(
  missingIndependentEvidence.verifiedOperationKinds,
  [],
  "Regenerating the generic planner without independently observed legacy evidence must never self-certify.",
);
const applyDb = makeDb({
  eventDomainMigrationState: completedMigrationState,
  events: [candidate],
  instagramSourceOccurrenceReceipts: [receipt],
  reconciliationRolloutState: [structuredClone(serverVerifiedState)],
  scrapedPosts: [sourceDocument],
  sourceOccurrences: [sourceOccurrence],
  venues: [venue],
});
const applied = await executeSourceOccurrence._handler(
  { db: applyDb },
  {
    expectedSourceOccurrenceUpdatedAt: 10,
    expectedSourceRevision: 3,
    mode: "apply",
    processingOwner: "worker-1",
    sourceOccurrenceId: "occurrence-1",
  },
);
assert.equal(applied.applied, true);
assert.equal(applied.canonicalEventId, "event-1");
assert.equal(
  applyDb.tables.sourceOccurrences.get("occurrence-1").state,
  "satisfied",
);
assert.equal(
  applyDb.tables.sourceOccurrences.get("occurrence-1").canonicalEventId,
  "event-1",
);
assert.deepEqual(
  applyDb.tables.instagramSourceOccurrenceReceipts.get("receipt-1")
    .satisfiedOccurrences,
  [{ eventId: "event-1", key: "source-key-1" }],
);
assert.equal([...applyDb.tables.instagramEventSources.values()].length, 1);
assert.equal(
  [...applyDb.tables.reconciliationAudits.values()].some(
    (audit) => audit.mode === "applied",
  ),
  true,
);
await assert.rejects(
  executeSourceOccurrence._handler(
    {
      db: makeDb({
        eventDomainMigrationState: completedMigrationState,
        events: [],
        instagramSourceOccurrenceReceipts: [receipt],
        reconciliationRolloutState: [structuredClone(serverVerifiedState)],
        scrapedPosts: [sourceDocument],
        sourceOccurrences: [sourceOccurrence],
        venues: [venue],
      }),
    },
    {
      expectedSourceOccurrenceUpdatedAt: 10,
      expectedSourceRevision: 3,
      mode: "apply",
      processingOwner: "worker-1",
      sourceOccurrenceId: "occurrence-1",
    },
  ),
  /operation that was not covered.*server verification/i,
  "A legitimate attach-only attestation must not authorize an unverified create.",
);

const updateDb = makeDb({
  eventDomainMigrationState: completedMigrationState,
  events: [{ ...candidate, artists: [] }],
  instagramSourceOccurrenceReceipts: [receipt],
  scrapedPosts: [sourceDocument],
  sourceOccurrences: [sourceOccurrence],
  venues: [venue],
});
const updated = await executeSourceOccurrence._handler(
  { db: updateDb },
  {
    expectedSourceOccurrenceUpdatedAt: 10,
    expectedSourceRevision: 3,
    intent: "moderate",
    mode: "apply",
    processingOwner: "worker-1",
    sourceOccurrenceId: "occurrence-1",
  },
);
assert.equal(updated.applied, true);
assert.equal(updated.plan.action, "update");
assert.deepEqual(updateDb.tables.events.get("event-1").artists, ["Artist One"]);
assert.equal(
  updateDb.tables.events.get("event-1").canonicalSourceUrl,
  sourceOccurrence.canonicalSourceUrl,
  "Updating primary source fields must move the canonical source URL atomically.",
);
assert.equal(
  updateDb.tables.events.get("event-1").sourceOccurrenceKey,
  sourceOccurrence.sourceOccurrenceKey,
  "Updating primary source fields must move their occurrence key atomically.",
);
assert.equal(
  updateDb.tables.events.get("event-1").instagramPostId,
  sourceDocument.postId,
  "Canonical and compatibility source identity fields must describe one post.",
);
assert.equal(
  updateDb.tables.sourceOccurrences.get("occurrence-1").canonicalEventId,
  "event-1",
);
assert.deepEqual(
  updateDb.tables.instagramSourceOccurrenceReceipts.get("receipt-1")
    .satisfiedOccurrences,
  [{ eventId: "event-1", key: "source-key-1" }],
);
assert.equal([...updateDb.tables.instagramEventSources.values()].length, 1);
assert.equal(updateDb.tables.events.get("event-1").publicationState, "hidden");
assert.equal(
  [...updateDb.tables.eventAuditLog.values()].some(
    (row) => row.action === "updated_by_reconciliation_executor",
  ),
  true,
);

const noTimeSignatureFields = toOccurrenceCandidateIndexFields(
  buildOccurrenceSignature({
    artists: ["Artist One"],
    eventType: "music",
    localDate: "2026-08-29",
    title: "Artist One Live",
    venueId: "venue-1",
  }),
);
const noTimeOccurrence = {
  ...sourceOccurrence,
  factsJson: JSON.stringify({
    artists: ["Artist One"],
    date: "2026-08-29",
    key: "source-key-1",
    title: "Artist One Live",
    venue: "KC Grad",
  }),
  normalizedOccurrenceJson: JSON.stringify({
    artists: ["Artist One"],
    date: "2026-08-29",
    eventType: "music",
    title: "Artist One Live",
    venue: "KC Grad",
    venueId: "venue-1",
  }),
  ...noTimeSignatureFields,
};
const noTimeReceipt = {
  ...receipt,
  expectedOccurrences: [
    {
      artists: ["Artist One"],
      date: "2026-08-29",
      key: "source-key-1",
      title: "Artist One Live",
      venue: "KC Grad",
    },
  ],
};
const noTimeUpdateDb = makeDb({
  eventDomainMigrationState: completedMigrationState,
  events: [candidate],
  instagramSourceOccurrenceReceipts: [noTimeReceipt],
  scrapedPosts: [sourceDocument],
  sourceOccurrences: [noTimeOccurrence],
  venues: [venue],
});
const noTimeUpdated = await executeSourceOccurrence._handler(
  { db: noTimeUpdateDb },
  {
    expectedSourceOccurrenceUpdatedAt: 10,
    expectedSourceRevision: 3,
    intent: "moderate",
    mode: "apply",
    processingOwner: "worker-1",
    sourceOccurrenceId: "occurrence-1",
  },
);
assert.equal(noTimeUpdated.plan.action, "update");
assert.ok(noTimeUpdated.plan.canonicalFieldsToUnset.includes("time"));
assert.equal(noTimeUpdateDb.tables.events.get("event-1").time, undefined);
assert.equal(
  noTimeUpdateDb.tables.events.get("event-1").occurrenceSignatureHash,
  noTimeSignatureFields.occurrenceSignatureHash,
  "Clearing time must install the signature derived from the effective no-time event.",
);
assert.match(
  [...noTimeUpdateDb.tables.eventAuditLog.values()].find(
    (row) => row.action === "updated_by_reconciliation_executor",
  ).patchJson,
  /"fieldsToUnset":\[[^\]]*"time"/u,
  "Durable audits must serialize field deletions explicitly.",
);

const createDb = makeDb({
  eventDomainMigrationState: completedMigrationState,
  events: [],
  instagramSourceOccurrenceReceipts: [receipt],
  scrapedPosts: [sourceDocument],
  sourceOccurrences: [sourceOccurrence],
  venues: [venue],
});
const created = await executeSourceOccurrence._handler(
  { db: createDb },
  {
    expectedSourceOccurrenceUpdatedAt: 10,
    expectedSourceRevision: 3,
    mode: "apply",
    processingOwner: "worker-1",
    sourceOccurrenceId: "occurrence-1",
  },
);
assert.equal(created.applied, true);
assert.equal(created.plan.action, "create");
assert.deepEqual(created.plan.provenanceChanges, [
  { operation: "attach", sourceOccurrenceId: "occurrence-1" },
]);
assert.equal(
  createDb.tables.events.get(created.canonicalEventId).status,
  "pending",
);
assert.equal(
  createDb.tables.sourceOccurrences.get("occurrence-1").canonicalEventId,
  created.canonicalEventId,
);
assert.deepEqual(
  createDb.tables.instagramSourceOccurrenceReceipts.get("receipt-1")
    .satisfiedOccurrences,
  [{ eventId: created.canonicalEventId, key: "source-key-1" }],
);
assert.equal(
  [...createDb.tables.instagramEventSources.values()][0].eventId,
  created.canonicalEventId,
);
assert.equal(
  createDb.tables.events.get(created.canonicalEventId).publicationState,
  "hidden",
);
assert.equal(
  createDb.tables.events.get(created.canonicalEventId).imageStorageId,
  "storage-poster-1",
);
assert.equal(
  createDb.tables.events.get(created.canonicalEventId).imageUrl,
  "https://images.example.test/poster-1.jpg",
);
assert.equal(
  JSON.parse(
    createDb.tables.events.get(created.canonicalEventId).normalizedFieldsJson,
  ).sourceGroundingInstagramHandle,
  "promoter",
  "New canonical events must retain the source account used by teaser safety.",
);

const teaserSignatureFields = toOccurrenceCandidateIndexFields(
  buildOccurrenceSignature({
    artists: [],
    eventType: "music",
    localDate: "2026-08-29",
    title: "Chapter IV",
    venueId: "venue-1",
  }),
);
const detailedSignatureFields = toOccurrenceCandidateIndexFields(
  buildOccurrenceSignature({
    artists: ["Artist"],
    eventType: "music",
    localDate: "2026-08-29",
    time: "20:00",
    title: "Chapter IV Artist",
    venueId: "venue-1",
  }),
);
const teaserOccurrence = {
  ...sourceOccurrence,
  factsJson: JSON.stringify({
    artists: [],
    date: "2026-08-29",
    key: "source-key-1",
    title: "Chapter IV",
    venue: "KC Grad",
  }),
  normalizedOccurrenceJson: JSON.stringify({
    artists: [],
    date: "2026-08-29",
    eventType: "music",
    title: "Chapter IV",
    venue: "KC Grad",
    venueId: "venue-1",
  }),
  ...teaserSignatureFields,
};
const teaserReceipt = {
  ...receipt,
  expectedOccurrences: [
    {
      artists: [],
      date: "2026-08-29",
      key: "source-key-1",
      title: "Chapter IV",
      venue: "KC Grad",
    },
  ],
};
const detailedCandidate = {
  ...candidate,
  artists: ["Artist"],
  normalizedFieldsJson: undefined,
  time: "20:00",
  title: "Chapter IV Artist",
  ...detailedSignatureFields,
};
async function classifyTeaserThroughServerAdapter(candidateSourceHandle) {
  const teaserDb = makeDb({
    events: [detailedCandidate],
    instagramEventSources: [
      {
        _creationTime: 1,
        _id: "detailed-source-link",
        eventId: "event-1",
        linkedAt: 1,
        sourceFingerprint: "other-fingerprint",
        sourceHandle: candidateSourceHandle,
        sourceIdentity: "instagram:OTHERPOST",
        sourceOccurrenceKey: "other-key",
        updatedAt: 1,
      },
    ],
    instagramSourceOccurrenceReceipts: [teaserReceipt],
    scrapedPosts: [sourceDocument],
    sourceOccurrences: [teaserOccurrence],
    venues: [venue],
  });
  return executeSourceOccurrence._handler(
    { db: teaserDb },
    {
      expectedSourceOccurrenceUpdatedAt: 10,
      expectedSourceRevision: 3,
      mode: "shadow",
      sourceOccurrenceId: "occurrence-1",
    },
  );
}
assert.equal(
  (await classifyTeaserThroughServerAdapter("promoter")).plan.action,
  "manual_review",
  "A same-account generic teaser must remain ambiguous through the Convex source adapter.",
);
assert.equal(
  (await classifyTeaserThroughServerAdapter("different.promoter")).plan.action,
  "attach",
  "The adapter regression must specifically exercise the source-account teaser guard.",
);

await assert.rejects(
  executeSourceOccurrence._handler(
    {
      db: makeDb({
        eventDomainMigrationState: completedMigrationState,
        events: [candidate],
        instagramSourceOccurrenceReceipts: [receipt],
        reconciliationRolloutState: [],
        scrapedPosts: [sourceDocument],
        sourceOccurrences: [sourceOccurrence],
        venues: [venue],
      }),
    },
    {
      expectedSourceOccurrenceUpdatedAt: 10,
      expectedSourceRevision: 3,
      mode: "apply",
      processingOwner: "worker-1",
      sourceOccurrenceId: "occurrence-1",
    },
  ),
  (error) =>
    error instanceof DomainError &&
    error.code === "RECONCILIATION_PLAN_INVALID" &&
    /zero-mismatch server verification/i.test(error.message),
  "Completed migrations alone must not authorize apply without a reviewed server verification.",
);

const rolloutReviewDb = makeDb({ reconciliationRolloutState: [] });
await assert.rejects(
  recordReconciliationRolloutReview._handler(
    { db: rolloutReviewDb },
    {
      comparedCount: 1,
      coverageEndAt: 2,
      coverageStartAt: 1,
      errorCount: 0,
      evidenceDigestSha256: "b".repeat(64),
      expectedOccurrenceCount: 1,
      indeterminateCount: 0,
      matchedCount: 0,
      mismatchCount: 1,
      note: "QA rejected mismatching shadow comparison window.",
      operatorEnabled: true,
      policyVersion: RECONCILIATION_POLICY_VERSION,
      reviewedBy: "qa-operator",
    },
  ),
  /cannot be enabled/i,
);
await assert.rejects(
  recordReconciliationRolloutReview._handler(
    { db: rolloutReviewDb },
    {
      comparedCount: 1,
      coverageEndAt: 2,
      coverageStartAt: 1,
      errorCount: 0,
      evidenceDigestSha256: "c".repeat(64),
      expectedOccurrenceCount: 1,
      indeterminateCount: 0,
      matchedCount: 1,
      mismatchCount: 0,
      note: "QA reviewed complete shadow comparison window.",
      operatorEnabled: true,
      policyVersion: RECONCILIATION_POLICY_VERSION,
      reviewedBy: "qa-operator",
    },
  ),
  /server-computed full-outcome verification/i,
);
const recordedDisabledReport = await recordReconciliationRolloutReview._handler(
  { db: rolloutReviewDb },
  {
    comparedCount: 1,
    coverageEndAt: 2,
    coverageStartAt: 1,
    errorCount: 0,
    evidenceDigestSha256: "d".repeat(64),
    expectedOccurrenceCount: 1,
    indeterminateCount: 0,
    matchedCount: 1,
    mismatchCount: 0,
    note: "QA stored a disabled operator shadow report.",
    operatorEnabled: false,
    policyVersion: RECONCILIATION_POLICY_VERSION,
    reviewedBy: "qa-operator",
  },
);
assert.equal(recordedDisabledReport.operatorEnabled, false);
assert.equal(recordedDisabledReport.created, true);

const campaignAttachDb = makeDb({
  eventDomainMigrationState: completedMigrationState,
  events: [
    {
      ...candidate,
      moderationNote: "[cross_post_campaign_primary:v1] reviewed",
    },
  ],
  instagramSourceOccurrenceReceipts: [receipt],
  scrapedPosts: [sourceDocument],
  sourceOccurrences: [sourceOccurrence],
  venues: [venue],
});
await assert.rejects(
  executeSourceOccurrence._handler(
    { db: campaignAttachDb },
    {
      expectedSourceOccurrenceUpdatedAt: 10,
      expectedSourceRevision: 3,
      mode: "apply",
      processingOwner: "worker-1",
      sourceOccurrenceId: "occurrence-1",
    },
  ),
  (error) =>
    error instanceof DomainError &&
    error.code === "RECONCILIATION_PLAN_INVALID" &&
    /campaign lineage.*re-attestation/i.test(error.message),
  "A generated attach plan must not add unbound provenance to audited campaign lineage.",
);
assert.equal(campaignAttachDb.tables.instagramEventSources.size, 0);
assert.deepEqual(
  campaignAttachDb.tables.instagramSourceOccurrenceReceipts.get("receipt-1")
    .satisfiedOccurrences,
  [],
);
assert.equal(
  campaignAttachDb.tables.sourceOccurrences.get("occurrence-1").state,
  "expected",
  "Campaign rejection must happen before occurrence or legacy provenance writes.",
);

const unresolvedDb = makeDb({
  eventDomainMigrationState: completedMigrationState,
  events: [candidate],
  instagramSourceOccurrenceReceipts: [receipt],
  scrapedPosts: [sourceDocument],
  sourceOccurrences: [
    {
      ...sourceOccurrence,
      _id: "occurrence-unresolved",
      ...toOccurrenceCandidateIndexFields(
        buildOccurrenceSignature({
          artists: ["Artist One"],
          eventType: "music",
          localDate: "2026-08-29",
          normalizedVenueIdentity: "KC Grad",
          time: "20:00",
          title: "Artist One Live",
        }),
      ),
      venueId: undefined,
      venueResolutionStatus: "ambiguous",
    },
  ],
  venues: [venue],
});
const shadow = await executeSourceOccurrence._handler(
  { db: unresolvedDb },
  {
    expectedSourceOccurrenceUpdatedAt: 10,
    expectedSourceRevision: 3,
    legacyOutcome: "create",
    mode: "shadow",
    sourceOccurrenceId: "occurrence-unresolved",
  },
);
assert.equal(shadow.applied, false);
assert.equal(shadow.plan.action, "manual_review");
assert.equal(
  unresolvedDb.tables.sourceOccurrences.get("occurrence-unresolved").state,
  "expected",
  "Shadow mode must not mutate occurrence state.",
);

const manualApplyDb = makeDb({
  eventDomainMigrationState: completedMigrationState,
  events: [candidate],
  instagramSourceOccurrenceReceipts: [receipt],
  scrapedPosts: [sourceDocument],
  sourceOccurrences: [
    {
      ...sourceOccurrence,
      _id: "occurrence-unresolved",
      ...toOccurrenceCandidateIndexFields(
        buildOccurrenceSignature({
          artists: ["Artist One"],
          eventType: "music",
          localDate: "2026-08-29",
          normalizedVenueIdentity: "KC Grad",
          time: "20:00",
          title: "Artist One Live",
        }),
      ),
      venueId: undefined,
      venueResolutionStatus: "ambiguous",
    },
  ],
  venues: [venue],
});
const manualStateBefore = JSON.stringify({
  events: [...manualApplyDb.tables.events.values()],
  links: [...manualApplyDb.tables.instagramEventSources.values()],
  occurrences: [...manualApplyDb.tables.sourceOccurrences.values()],
  receipts: [
    ...manualApplyDb.tables.instagramSourceOccurrenceReceipts.values(),
  ],
});
const manualApply = await executeSourceOccurrence._handler(
  { db: manualApplyDb },
  {
    expectedSourceOccurrenceUpdatedAt: 10,
    expectedSourceRevision: 3,
    mode: "apply",
    processingOwner: "worker-1",
    sourceOccurrenceId: "occurrence-unresolved",
  },
);
assert.equal(manualApply.applied, false);
assert.equal(manualApply.plan.action, "manual_review");
assert.equal(
  [...manualApplyDb.tables.reconciliationAudits.values()].at(-1).mode,
  "rejected",
);
assert.equal(
  JSON.stringify({
    events: [...manualApplyDb.tables.events.values()],
    links: [...manualApplyDb.tables.instagramEventSources.values()],
    occurrences: [...manualApplyDb.tables.sourceOccurrences.values()],
    receipts: [
      ...manualApplyDb.tables.instagramSourceOccurrenceReceipts.values(),
    ],
  }),
  manualStateBefore,
  "Source manual_review must be an audited no-op.",
);

const unresolvedAddress = "Višnjićeva 7";
const unresolvedAddressSignature = toOccurrenceCandidateIndexFields(
  buildOccurrenceSignature({
    artists: ["Artist One"],
    eventType: "music",
    localDate: "2026-08-29",
    normalizedVenueIdentity: unresolvedAddress,
    time: "20:00",
    title: "Artist One Live",
  }),
);
const unresolvedAddressFactsJson = JSON.stringify({
  artistClaims: ["Artist One"],
  eventTypeClaim: "music",
  evidence: [
    {
      exactText: unresolvedAddress,
      field: "venue",
      source: "poster",
    },
  ],
  localDate: "2026-08-29",
  policy: {
    approvalDisposition: "approved",
    autoApproveRule: "qa_source_grounded",
    pendingReasons: [],
    signals: ["poster_address"],
    structuredEvidenceVerified: true,
  },
  startTime: "20:00",
  timeRelation: "exact",
  titleClaim: "Artist One Live",
  venueClaim: unresolvedAddress,
});
const unresolvedAddressOccurrence = {
  ...sourceOccurrence,
  _id: "occurrence-unresolved-address",
  canonicalEventJson: JSON.stringify({
    normalizedFieldsJson: JSON.stringify({
      extractionContractVersion: "event_evidence_v2",
      normalizedVenue: unresolvedAddress,
    }),
    requestedStatus: "approved",
    sourceConflictFields: [],
    time: "20:00",
    timeConfidence: 1,
    timeEvidenceKind: "start_time_stated",
    timeEvidenceText: "20:00",
    timeSource: "poster",
    timeStatus: "confirmed",
  }),
  factsJson: unresolvedAddressFactsJson,
  normalizedOccurrenceJson: JSON.stringify({
    artists: ["Artist One"],
    date: "2026-08-29",
    eventType: "music",
    time: "20:00",
    title: "Artist One Live",
    venue: unresolvedAddress,
    venueId: null,
  }),
  venueId: undefined,
  venueResolutionStatus: "unresolved",
  ...unresolvedAddressSignature,
};
const unresolvedAddressCandidate = {
  ...candidate,
  _id: "event-address-candidate",
  normalizedVenueIdentity: unresolvedAddress,
  publicationReason: "eligible",
  publicationState: "visible",
  status: "approved",
  venue: unresolvedAddress,
  venueId: undefined,
  ...unresolvedAddressSignature,
};
const unresolvedAddressReceipt = {
  ...receipt,
  expectedOccurrences: [
    {
      artists: ["Artist One"],
      date: "2026-08-29",
      key: "source-key-1",
      time: "20:00",
      title: "Artist One Live",
      venue: unresolvedAddress,
    },
  ],
};
const unresolvedAddressDb = makeDb({
  eventDomainMigrationState: completedMigrationState,
  events: [unresolvedAddressCandidate],
  instagramSourceOccurrenceReceipts: [unresolvedAddressReceipt],
  scrapedPosts: [sourceDocument],
  sourceOccurrences: [unresolvedAddressOccurrence],
  venues: [venue],
});
const addressCandidateBefore = structuredClone(unresolvedAddressCandidate);
const unresolvedAddressCreate = await executeSourceOccurrence._handler(
  { db: unresolvedAddressDb },
  {
    expectedSourceOccurrenceUpdatedAt: 10,
    expectedSourceRevision: 3,
    mode: "apply",
    processingOwner: "worker-1",
    sourceOccurrenceId: "occurrence-unresolved-address",
  },
);
assert.equal(unresolvedAddressCreate.applied, true);
assert.equal(unresolvedAddressCreate.plan.action, "create");
assert.notEqual(
  unresolvedAddressCreate.canonicalEventId,
  unresolvedAddressCandidate._id,
  "An unresolved venue claim must not attach to a semantic candidate.",
);
assert.deepEqual(
  unresolvedAddressDb.tables.events.get(unresolvedAddressCandidate._id),
  addressCandidateBefore,
  "Unresolved venue processing must not update a different semantic candidate.",
);
const unresolvedAddressEvent = unresolvedAddressDb.tables.events.get(
  unresolvedAddressCreate.canonicalEventId,
);
assert.equal(unresolvedAddressEvent.status, "pending");
assert.equal(unresolvedAddressEvent.publicationState, "hidden");
assert.equal(unresolvedAddressEvent.publicationReason, "moderation_not_approved");
assert.equal(unresolvedAddressEvent.venue, unresolvedAddress);
assert.equal(unresolvedAddressEvent.venueId, undefined);
assert.equal(
  JSON.parse(unresolvedAddressOccurrence.canonicalEventJson).requestedStatus,
  "approved",
  "The regression must prove an approved request is downgraded, not merely preserve pending.",
);
const unresolvedAddressLink = [
  ...unresolvedAddressDb.tables.instagramEventSources.values(),
][0];
assert.equal(unresolvedAddressLink.eventId, unresolvedAddressCreate.canonicalEventId);
assert.equal(
  unresolvedAddressLink.sourceOccurrenceId,
  unresolvedAddressOccurrence._id,
);
assert.equal(
  unresolvedAddressLink.sourceFingerprint,
  unresolvedAddressOccurrence.sourceFingerprint,
);
assert.equal(
  unresolvedAddressLink.sourceIdentity,
  unresolvedAddressOccurrence.sourceIdentity,
);
assert.equal(
  unresolvedAddressLink.sourceOccurrenceKey,
  unresolvedAddressOccurrence.sourceOccurrenceKey,
);
const unresolvedAddressSatisfaction = unresolvedAddressDb.tables
  .instagramSourceOccurrenceReceipts.get("receipt-1")
  .satisfiedOccurrences;
assert.deepEqual(unresolvedAddressSatisfaction, [
  {
    eventId: unresolvedAddressCreate.canonicalEventId,
    key: unresolvedAddressOccurrence.sourceOccurrenceKey,
  },
]);
const eventCountBeforeAddressRetry = unresolvedAddressDb.tables.events.size;
const linkCountBeforeAddressRetry =
  unresolvedAddressDb.tables.instagramEventSources.size;
const addressEventUpdatedAtBeforeRetry = unresolvedAddressEvent.updatedAt;
const unresolvedAddressRetry = await executeSourceOccurrence._handler(
  { db: unresolvedAddressDb },
  {
    expectedSourceOccurrenceUpdatedAt: QA_NOW,
    expectedSourceRevision: 3,
    mode: "apply",
    processingOwner: "worker-1",
    sourceOccurrenceId: "occurrence-unresolved-address",
  },
);
assert.equal(unresolvedAddressRetry.applied, true);
assert.equal(unresolvedAddressRetry.plan.action, "attach");
assert.equal(
  unresolvedAddressRetry.canonicalEventId,
  unresolvedAddressCreate.canonicalEventId,
);
assert.equal(unresolvedAddressDb.tables.events.size, eventCountBeforeAddressRetry);
assert.equal(
  unresolvedAddressDb.tables.instagramEventSources.size,
  linkCountBeforeAddressRetry,
);
assert.equal(unresolvedAddressEvent.updatedAt, addressEventUpdatedAtBeforeRetry);
assert.deepEqual(
  unresolvedAddressDb.tables.instagramSourceOccurrenceReceipts.get("receipt-1")
    .satisfiedOccurrences,
  unresolvedAddressSatisfaction,
  "Exact-source retry must keep one receipt satisfaction.",
);

const ingressPostId = "ADDRESSINGRESS";
const ingressSourceDocument = {
  ...sourceDocument,
  _id: "post-address-ingress",
  altText: `Poster: Artist One Live, ${unresolvedAddress}, 20:00`,
  caption: `Artist One Live at ${unresolvedAddress}, 29 August at 20:00`,
  instagramPostUrl: `https://www.instagram.com/p/${ingressPostId}/`,
  postId: ingressPostId,
  processingLeaseOwner: "ingress-worker",
  sourceRevision: 4,
};
const ingressSourceIdentity =
  adaptInstagramScrapedPostToSourceDocument(
    ingressSourceDocument,
  ).sourceIdentity;
const ingressSourceFingerprint =
  buildInstagramSourceOccurrenceFingerprint(ingressSourceDocument);
const ingressOccurrenceKey = "source-key-address-ingress";
const ingressAddressCandidate = {
  ...unresolvedAddressCandidate,
  _id: "event-address-ingress-candidate",
};
const ingressAddressPlan = {
  deferredChildCount: 0,
  deferredChildKeys: [],
  expectedKeys: [ingressOccurrenceKey],
  expectedOccurrences: [
    {
      artists: ["Artist One"],
      canonicalEventJson: unresolvedAddressOccurrence.canonicalEventJson,
      date: "2026-08-29",
      factsJson: unresolvedAddressFactsJson,
      key: ingressOccurrenceKey,
      time: "20:00",
      title: "Artist One Live",
      venue: unresolvedAddress,
    },
  ],
  observedChildKeys: [ingressOccurrenceKey],
  sourceFingerprint: ingressSourceFingerprint,
  sourceIdentity: ingressSourceIdentity,
};
const ingressAddressDb = makeDb({
  eventDomainMigrationState: completedMigrationState,
  events: [ingressAddressCandidate],
  instagramSourceOccurrenceReceipts: [],
  reconciliationRolloutState: [
    { ...enabledRolloutState[0], ingestionApplyEnabled: true },
  ],
  scrapedPosts: [ingressSourceDocument],
  sourceOccurrences: [],
  venues: [venue],
});
const ingressAddressCandidateBefore = structuredClone(ingressAddressCandidate);
const priorCronSecret = process.env.CRON_SECRET;
process.env.CRON_SECRET = "qa-reconciliation-ingress-secret";
try {
  const ingressArgs = {
    plan: ingressAddressPlan,
    processingFence: {
      handle: ingressSourceDocument.handle,
      instagramPostUrl: ingressSourceDocument.instagramPostUrl,
      owner: ingressSourceDocument.processingLeaseOwner,
      postId: ingressSourceDocument.postId,
      scrapedPostId: ingressSourceDocument._id,
      sourceRevision: ingressSourceDocument.sourceRevision,
    },
    serviceSecret: process.env.CRON_SECRET,
  };
  const ingressCreate = await reconcileIngestionPlan._handler(
    {
      auth: { getUserIdentity: async () => null },
      db: ingressAddressDb,
    },
    ingressArgs,
  );
  assert.equal(ingressCreate.authority, "reconciliation");
  assert.equal(ingressCreate.outcomes.length, 1);
  assert.equal(ingressCreate.outcomes[0].action, "create");
  assert.equal(ingressCreate.outcomes[0].applied, true);
  assert.equal(ingressCreate.outcomes[0].canonicalEventStatus, "pending");
  const ingressCanonicalEventId =
    ingressCreate.outcomes[0].canonicalEventId;
  assert.ok(ingressCanonicalEventId);
  assert.notEqual(ingressCanonicalEventId, ingressAddressCandidate._id);
  assert.deepEqual(
    ingressAddressDb.tables.events.get(ingressAddressCandidate._id),
    ingressAddressCandidateBefore,
    "Ingress must not attach or update the semantic candidate for an unresolved venue claim.",
  );
  const ingressCreatedEvent =
    ingressAddressDb.tables.events.get(ingressCanonicalEventId);
  assert.equal(ingressCreatedEvent.status, "pending");
  assert.equal(ingressCreatedEvent.publicationState, "hidden");
  assert.equal(ingressCreatedEvent.publicationReason, "moderation_not_approved");
  assert.equal(ingressCreatedEvent.venue, unresolvedAddress);
  assert.equal(ingressCreatedEvent.venueId, undefined);

  const ingressOccurrence = [
    ...ingressAddressDb.tables.sourceOccurrences.values(),
  ][0];
  assert.equal(ingressOccurrence.sourceIdentity, ingressSourceIdentity);
  assert.equal(ingressOccurrence.sourceFingerprint, ingressSourceFingerprint);
  assert.equal(ingressOccurrence.sourceOccurrenceKey, ingressOccurrenceKey);
  assert.equal(ingressOccurrence.sourceDocumentId, ingressSourceDocument._id);
  assert.equal(ingressOccurrence.canonicalEventId, ingressCanonicalEventId);
  assert.equal(ingressOccurrence.venueResolutionStatus, "unresolved");
  assert.equal(ingressOccurrence.venueId, undefined);
  assert.equal(ingressOccurrence.state, "satisfied");
  const ingressLink = [
    ...ingressAddressDb.tables.instagramEventSources.values(),
  ][0];
  assert.equal(ingressLink.eventId, ingressCanonicalEventId);
  assert.equal(ingressLink.sourceOccurrenceId, ingressOccurrence._id);
  assert.equal(ingressLink.sourceIdentity, ingressSourceIdentity);
  assert.equal(ingressLink.sourceFingerprint, ingressSourceFingerprint);
  assert.equal(ingressLink.sourceOccurrenceKey, ingressOccurrenceKey);
  const ingressReceipt = [
    ...ingressAddressDb.tables.instagramSourceOccurrenceReceipts.values(),
  ][0];
  assert.deepEqual(ingressReceipt.satisfiedOccurrences, [
    { eventId: ingressCanonicalEventId, key: ingressOccurrenceKey },
  ]);

  const ingressCountsBeforeRetry = {
    eventAudits: ingressAddressDb.tables.eventAuditLog.size,
    events: ingressAddressDb.tables.events.size,
    links: ingressAddressDb.tables.instagramEventSources.size,
    receipts: ingressAddressDb.tables.instagramSourceOccurrenceReceipts.size,
  };
  const ingressCandidateUpdatedAtBeforeRetry =
    ingressAddressCandidateBefore.updatedAt;
  const ingressCreatedUpdatedAtBeforeRetry = ingressCreatedEvent.updatedAt;
  const ingressRetry = await reconcileIngestionPlan._handler(
    {
      auth: { getUserIdentity: async () => null },
      db: ingressAddressDb,
    },
    ingressArgs,
  );
  assert.equal(ingressRetry.authority, "reconciliation");
  assert.equal(ingressRetry.outcomes.length, 1);
  assert.equal(ingressRetry.outcomes[0].action, "attach");
  assert.equal(ingressRetry.outcomes[0].applied, true);
  assert.equal(
    ingressRetry.outcomes[0].canonicalEventId,
    ingressCanonicalEventId,
  );
  assert.equal(
    ingressAddressDb.tables.events.size,
    ingressCountsBeforeRetry.events,
  );
  assert.equal(
    ingressAddressDb.tables.instagramEventSources.size,
    ingressCountsBeforeRetry.links,
  );
  assert.equal(
    ingressAddressDb.tables.instagramSourceOccurrenceReceipts.size,
    ingressCountsBeforeRetry.receipts,
  );
  assert.equal(
    ingressAddressDb.tables.eventAuditLog.size,
    ingressCountsBeforeRetry.eventAudits,
  );
  assert.equal(
    ingressAddressDb.tables.events.get(ingressAddressCandidate._id).updatedAt,
    ingressCandidateUpdatedAtBeforeRetry,
  );
  assert.equal(
    ingressAddressDb.tables.events.get(ingressCanonicalEventId).updatedAt,
    ingressCreatedUpdatedAtBeforeRetry,
  );
} finally {
  if (priorCronSecret === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = priorCronSecret;
  }
}

await assert.rejects(
  executeSourceOccurrence._handler(
    {
      db: makeDb({
        events: [candidate],
        instagramSourceOccurrenceReceipts: [receipt],
        scrapedPosts: [sourceDocument],
        sourceOccurrences: [sourceOccurrence],
        venues: [venue],
      }),
    },
    {
      expectedSourceOccurrenceUpdatedAt: 10,
      expectedSourceRevision: 3,
      mode: "apply",
      processingOwner: "stale-worker",
      sourceOccurrenceId: "occurrence-1",
    },
  ),
  (error) =>
    error instanceof DomainError && error.code === "PROCESSING_FENCE_INVALID",
);

await assert.rejects(
  executeSourceOccurrence._handler(
    {
      db: makeDb({
        events: [candidate],
        instagramSourceOccurrenceReceipts: [receipt],
        scrapedPosts: [sourceDocument],
        sourceOccurrences: [sourceOccurrence],
        venues: [venue],
      }),
    },
    {
      expectedSourceOccurrenceUpdatedAt: 10,
      expectedSourceRevision: 3,
      mode: "apply",
      processingOwner: "worker-1",
      sourceOccurrenceId: "occurrence-1",
    },
  ),
  (error) =>
    error instanceof DomainError &&
    error.code === "RECONCILIATION_PLAN_INVALID" &&
    error.details?.incompleteMigrations?.length === 7,
  "Apply must fail closed until every required migration is complete.",
);

await assert.rejects(
  executeSourceOccurrence._handler(
    {
      db: makeDb({
        eventDomainMigrationState: completedMigrationState,
        events: [candidate, { ...candidate, _id: "event-conflict" }],
        instagramEventSources: [
          {
            _creationTime: 1,
            _id: "source-link-conflict",
            createdAt: 1,
            eventId: "event-conflict",
            sourceFingerprint: "fingerprint-1",
            sourceIdentity: "instagram:POSTONE",
            sourceOccurrenceKey: "source-key-1",
            updatedAt: 1,
          },
        ],
        instagramSourceOccurrenceReceipts: [receipt],
        scrapedPosts: [sourceDocument],
        sourceOccurrences: [
          {
            ...sourceOccurrence,
            canonicalEventId: "event-1",
            state: "satisfied",
          },
        ],
        venues: [venue],
      }),
    },
    {
      expectedSourceOccurrenceUpdatedAt: 10,
      expectedSourceRevision: 3,
      mode: "shadow",
      sourceOccurrenceId: "occurrence-1",
    },
  ),
  (error) =>
    error instanceof DomainError && error.code === "RECONCILIATION_CONFLICT",
  "First-class and legacy provenance disagreement must fail closed.",
);

const postWriteShadowDb = makeDb({
  eventDomainMigrationState: completedMigrationState,
  events: [candidate],
  instagramEventSources: [
    {
      _creationTime: 1,
      _id: "post-write-source-link",
      createdAt: 1,
      eventId: "event-1",
      sourceFingerprint: "fingerprint-1",
      sourceIdentity: "instagram:POSTONE",
      sourceOccurrenceKey: "source-key-1",
      updatedAt: 1,
    },
  ],
  instagramSourceOccurrenceReceipts: [
    {
      ...receipt,
      satisfiedKeys: ["source-key-1"],
      satisfiedOccurrences: [{ eventId: "event-1", key: "source-key-1" }],
    },
  ],
  scrapedPosts: [sourceDocument],
  sourceOccurrences: [
    {
      ...sourceOccurrence,
      canonicalEventId: "event-1",
      state: "satisfied",
    },
  ],
  venues: [venue],
});
const postWriteShadow = await executeLatestSourceOccurrenceShadow._handler(
  { db: postWriteShadowDb },
  {
    legacyOutcome: "create",
    sourceOccurrenceId: "occurrence-1",
  },
);
assert.equal(
  postWriteShadow.plan.action,
  "create",
  "Post-write shadow must exclude the event that the legacy create just inserted.",
);
const postWriteAudit = [
  ...postWriteShadowDb.tables.reconciliationAudits.values(),
][0];
assert.equal(postWriteAudit.shadowMatches, undefined);
assert.equal(postWriteAudit.shadowComparisonStatus, "indeterminate");
assert.equal(
  postWriteAudit.shadowComparisonReason,
  "legacy_outcome_lacks_versioned_full_semantic_envelope",
);
assert.equal(postWriteAudit.shadowComparisonBasis, "post_write_counterfactual");

console.log("Server reconciliation executor QA passed.");
