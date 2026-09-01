import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  abandonReconciliationRolloutVerification,
  assertReconciliationIngestionApplyEnabled,
  disableServerVerifiedReconciliationRollout,
  enableServerVerifiedReconciliationIngestionApply,
  getReconciliationRolloutStatus,
  reconciliationIngestionApplyIsEnabled,
} from "../convex/internal/reconciliationRollout.ts";
import { readReconciliationPrerequisiteStatus } from "../convex/internal/reconciliationPrerequisites.ts";
import { DomainError } from "../lib/domain/errors.ts";
import { RECONCILIATION_POLICY_VERSION } from "../lib/domain/reconciliation/index.ts";

const QA_NOW = new Date("2026-09-01T12:00:00.000Z").getTime();
Date.now = () => QA_NOW;

const rolloutSource = readFileSync(
  new URL("../convex/internal/reconciliationRollout.ts", import.meta.url),
  "utf8",
);
assert.match(
  rolloutSource,
  /getReconciliationRolloutStatus\s*=\s*internalQuery\([\s\S]*?\.withIndex\("by_key"[\s\S]*?\.take\(2\)/u,
  "The orchestration query must use one bounded rollout-key lookup.",
);
assert.doesNotMatch(
  rolloutSource,
  /getReconciliationRolloutStatus\s*=\s*internalQuery\([\s\S]*?\.collect\(/u,
  "The orchestration query must not collect a growing table.",
);

const migrationRows = [
  "canonical-event-domain-fields-v1",
  "venue-identities-v1",
  "event-venue-bindings-v1",
  "legacy-source-identity-canonicalization-v1",
  "legacy-source-occurrence-admission-v1",
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
  phase: "qa",
  quarantinedLineageMarkerCount: 0,
  scannedCount: 1,
  skipReasonCountsJson: "{}",
  skippedCount: 0,
  updatedAt: 2,
  updatedCount: 1,
}));
migrationRows.push({
  _creationTime: 1,
  _id: "receipt-topology-migration",
  completedAt: 2,
  createdAt: 1,
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

const topologyRow = {
  _creationTime: 1,
  _id: "topology-1",
  createdAt: 1,
  currentEpoch: 1,
  key: "source-occurrence-topology-v1",
  updatedAt: 1,
  verifiedEpoch: 1,
};

function enabledRollout(overrides = {}) {
  return {
    _creationTime: 1,
    _id: "rollout-1",
    comparedCount: 1,
    completedAt: 50,
    coverageEndAt: 20,
    coverageStartAt: 10,
    createdAt: 10,
    errorCount: 0,
    evidenceDigestSha256: "a".repeat(64),
    expectedOccurrenceCount: 1,
    indeterminateCount: 0,
    ingestionApplyEnabled: false,
    key: "source-occurrence-reconciliation-apply-v1",
    matchedCount: 1,
    mismatchCount: 0,
    note: "QA server verification was explicitly authorized.",
    operatorEnabled: true,
    policyVersion: RECONCILIATION_POLICY_VERSION,
    reviewedAt: 50,
    reviewedBy: "qa-operator",
    updatedAt: 50,
    verificationKind: "server_full_outcome_v1",
    verificationPhase: "enabled",
    verificationRunId: "qa-verification-run",
    verificationStartedAt: 10,
    verificationTopologyEpoch: 1,
    verifiedConsolidationEvidenceCount: 0,
    verifiedOperationKinds: ["attach"],
    ...overrides,
  };
}

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

function makeDb({
  migrations = migrationRows,
  rolloutRows = [enabledRollout()],
  topology = topologyRow,
} = {}) {
  const tables = {
    eventDomainMigrationState: new Map(
      migrations.map((row) => [row._id, structuredClone(row)]),
    ),
    events: new Map(),
    reconciliationRolloutState: new Map(
      rolloutRows.map((row) => [row._id, structuredClone(row)]),
    ),
    scrapedPosts: new Map(),
    sourceOccurrenceTopologyEpoch: new Map(
      topology ? [[topology._id, structuredClone(topology)]] : [],
    ),
    venueIdentities: new Map(),
    venues: new Map(),
  };
  const values = (table) => [...(tables[table]?.values() ?? [])];
  const queryResult = (table, criteria = []) => {
    const matches = () =>
      values(table).filter((row) =>
        criteria.every(([operation, field, expected]) =>
          operation === "gte"
            ? row[field] >= expected
            : row[field] === expected,
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

const db = makeDb();
const quarantinedPayloadMigrations = structuredClone(migrationRows);
const quarantinedPayloadState = quarantinedPayloadMigrations.find(
  (row) => row.key === "source-occurrence-canonical-payload-v1",
);
quarantinedPayloadState.skippedCount = 1;
quarantinedPayloadState.quarantinedLineageMarkerCount = 1;
quarantinedPayloadState.skipReasonCountsJson = JSON.stringify({
  audited_lineage_requires_reattestation: 1,
});
const quarantinedPrerequisite = await readReconciliationPrerequisiteStatus({
  db: makeDb({ migrations: quarantinedPayloadMigrations }),
});
assert.equal(quarantinedPrerequisite.satisfied, false);
assert.deepEqual(quarantinedPrerequisite.incompleteMigrations, [
  "source-occurrence-canonical-payload-v1",
]);
const initialStatus = await getReconciliationRolloutStatus._handler({ db }, {});
assert.equal(initialStatus.singletonStatus, "present");
assert.equal(initialStatus.applyReady, true);
assert.equal(initialStatus.ingestionApplyEnabled, false);
assert.equal(initialStatus.ingestionApplyReady, false);
assert.deepEqual(initialStatus.blockReasons, []);
assert.deepEqual(initialStatus.verifiedOperationKinds, ["attach"]);
assert.equal(await reconciliationIngestionApplyIsEnabled({ db }), false);

await assert.rejects(
  assertReconciliationIngestionApplyEnabled({ db }, "attach"),
  (error) =>
    error instanceof DomainError &&
    error.code === "RECONCILIATION_PLAN_INVALID" &&
    /separate operator cutover/i.test(error.message),
  "Generic apply authorization alone must not enable ingestion writes.",
);
await assert.rejects(
  enableServerVerifiedReconciliationIngestionApply._handler(
    { db },
    {
      enabledBy: "qa-operator",
      expectedEvidenceDigestSha256: "a".repeat(64),
      expectedUpdatedAt: 49,
      expectedVerificationRunId: "qa-verification-run",
      note: "QA intentionally supplies a stale state fence for rejection.",
    },
  ),
  /state changed before the operator control/i,
);
const driftedEnableDb = makeDb({
  topology: { ...topologyRow, currentEpoch: 2, verifiedEpoch: 2 },
});
await assert.rejects(
  enableServerVerifiedReconciliationIngestionApply._handler(
    { db: driftedEnableDb },
    {
      enabledBy: "qa-operator",
      expectedEvidenceDigestSha256: "a".repeat(64),
      expectedUpdatedAt: 50,
      expectedVerificationRunId: "qa-verification-run",
      note: "QA refuses ingestion cutover after the reviewed topology changed.",
    },
  ),
  /topology changed before the ingestion apply cutover/i,
);
const ingestionEnable =
  await enableServerVerifiedReconciliationIngestionApply._handler(
    { db },
    {
      enabledBy: "qa-operator",
      expectedEvidenceDigestSha256: "a".repeat(64),
      expectedUpdatedAt: 50,
      expectedVerificationRunId: "qa-verification-run",
      note: "QA explicitly enables ingestion only after generic apply authorization.",
    },
  );
assert.equal(ingestionEnable.ingestionApplyEnabled, true);
await assertReconciliationIngestionApplyEnabled({ db }, "attach");
const ingestionEnabledStatus =
  await getReconciliationRolloutStatus._handler({ db }, {});
assert.equal(ingestionEnabledStatus.applyReady, true);
assert.equal(ingestionEnabledStatus.ingestionApplyReady, true);
assert.equal(await reconciliationIngestionApplyIsEnabled({ db }), true);
db.tables.sourceOccurrenceTopologyEpoch.get("topology-1").currentEpoch = 2;

await assert.rejects(
  disableServerVerifiedReconciliationRollout._handler(
    { db },
    {
      disabledBy: "qa-operator",
      expectedEvidenceDigestSha256: "b".repeat(64),
      expectedUpdatedAt: ingestionEnable.updatedAt,
      expectedVerificationRunId: "qa-verification-run",
      note: "QA intentionally supplies the wrong evidence digest for rejection.",
    },
  ),
  /state changed before the operator control/i,
);
const disabled = await disableServerVerifiedReconciliationRollout._handler(
  { db },
  {
    disabledBy: "qa-operator",
    expectedEvidenceDigestSha256: "a".repeat(64),
    expectedUpdatedAt: ingestionEnable.updatedAt,
    expectedVerificationRunId: "qa-verification-run",
    note: "QA emergency rollback disables both generic and ingestion apply.",
  },
);
assert.equal(disabled.operatorEnabled, false);
assert.equal(disabled.verificationPhase, "blocked");
const disabledState = db.tables.reconciliationRolloutState.get("rollout-1");
assert.equal(disabledState.operatorEnabled, false);
assert.equal(disabledState.ingestionApplyEnabled, false);
assert.equal(disabledState.verificationPhase, "blocked");
const disabledStatus = await getReconciliationRolloutStatus._handler({ db }, {});
assert.equal(disabledStatus.applyReady, false);
assert.equal(disabledStatus.ingestionApplyReady, false);
assert.equal(await reconciliationIngestionApplyIsEnabled({ db }), false);
assert.deepEqual(disabledStatus.blockReasons, [
  "rollout_attestation_not_apply_ready",
  "receipt_topology_coverage_incomplete",
  "topology_epoch_unverified",
]);
await assert.rejects(
  assertReconciliationIngestionApplyEnabled({ db }, "attach"),
  /zero-mismatch server verification/i,
);

const scanning = enabledRollout({
  completedAt: undefined,
  ingestionApplyEnabled: true,
  operatorEnabled: false,
  reviewedAt: undefined,
  reviewedBy: "server_full_outcome_verifier",
  updatedAt: 75,
  verificationCursor: "opaque-cursor",
  verificationPhase: "scanning",
});
const scanningDb = makeDb({ rolloutRows: [scanning] });
await assert.rejects(
  abandonReconciliationRolloutVerification._handler(
    { db: scanningDb },
    {
      abandonedBy: "qa-operator",
      expectedEvidenceDigestSha256: "a".repeat(64),
      expectedUpdatedAt: 74,
      expectedVerificationRunId: "qa-verification-run",
      note: "QA rejects abandoning a scan through a stale state fence.",
    },
  ),
  /state changed before the operator control/i,
);
const abandoned =
  await abandonReconciliationRolloutVerification._handler(
    { db: scanningDb },
    {
      abandonedBy: "qa-operator",
      expectedEvidenceDigestSha256: "a".repeat(64),
      expectedUpdatedAt: 75,
      expectedVerificationRunId: "qa-verification-run",
      note: "QA abandons an interrupted verification without enabling apply.",
    },
  );
assert.equal(abandoned.operatorEnabled, false);
const abandonedState =
  scanningDb.tables.reconciliationRolloutState.get("rollout-1");
assert.equal(abandonedState.verificationPhase, "blocked");
assert.equal(abandonedState.verificationCursor, undefined);
assert.equal(abandonedState.ingestionApplyEnabled, false);
assert.equal(abandonedState.completedAt, QA_NOW);
await assert.rejects(
  abandonReconciliationRolloutVerification._handler(
    { db: scanningDb },
    {
      abandonedBy: "qa-operator",
      expectedEvidenceDigestSha256: "a".repeat(64),
      expectedUpdatedAt: abandoned.updatedAt,
      expectedVerificationRunId: "qa-verification-run",
      note: "QA cannot abandon the same verification after it is blocked.",
    },
  ),
  /only a disabled in-progress server verification/i,
);

const missingStatus = await getReconciliationRolloutStatus._handler(
  { db: makeDb({ rolloutRows: [] }) },
  {},
);
assert.equal(missingStatus.singletonStatus, "missing");
assert.equal(missingStatus.applyReady, false);
assert.ok(missingStatus.blockReasons.includes("rollout_state_missing"));
assert.equal(
  await reconciliationIngestionApplyIsEnabled({
    db: makeDb({ rolloutRows: [] }),
  }),
  false,
);

const duplicateStatus = await getReconciliationRolloutStatus._handler(
  {
    db: makeDb({
      rolloutRows: [
        enabledRollout(),
        enabledRollout({ _id: "rollout-2", updatedAt: 51 }),
      ],
    }),
  },
  {},
);
assert.equal(duplicateStatus.singletonStatus, "duplicate");
assert.equal(duplicateStatus.operatorEnabled, false);
assert.equal(duplicateStatus.applyReady, false);
assert.ok(duplicateStatus.blockReasons.includes("rollout_state_duplicate"));
assert.equal(
  await reconciliationIngestionApplyIsEnabled({
    db: makeDb({
      rolloutRows: [
        enabledRollout({ ingestionApplyEnabled: true }),
        enabledRollout({
          _id: "rollout-2",
          ingestionApplyEnabled: true,
          updatedAt: 51,
        }),
      ],
    }),
  }),
  false,
  "Duplicate rollout rows must select legacy ingress without throwing.",
);

const driftedTopologyStatus = await getReconciliationRolloutStatus._handler(
  {
    db: makeDb({
      topology: { ...topologyRow, currentEpoch: 2, verifiedEpoch: 1 },
    }),
  },
  {},
);
assert.equal(driftedTopologyStatus.applyReady, false);
assert.ok(
  driftedTopologyStatus.blockReasons.includes("topology_epoch_unverified"),
);

console.log("reconciliation_rollout_controls_qa=passed");
