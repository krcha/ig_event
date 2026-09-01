import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const operatorPath = join(
  repositoryRoot,
  "scripts/event-domain-rollout-operator.mjs",
);
const operatorSource = readFileSync(operatorPath, "utf8");
const publicationPolicySource = readFileSync(
  join(repositoryRoot, "lib/domain/publication/policy.ts"),
  "utf8",
);
const reconciliationTypesSource = readFileSync(
  join(repositoryRoot, "lib/domain/reconciliation/types.ts"),
  "utf8",
);

const orderedMigrationKeys = [
  "source-document-canonical-url-v1",
  "media-canonical-url-v1",
  "canonical-event-domain-fields-v1",
  "reviewed-kolarac-venue-consolidation-v1",
  "reviewed-official-venue-directory-additions-v1",
  "venue-compatibility-seed-audit-v1",
  "venue-identities-v1",
  "campaign-lineage-reattestation-v1",
  "event-venue-bindings-v1",
  "source-occurrences-generic-v2",
  "source-occurrence-canonical-payload-v1",
  "source-occurrence-receipt-topology-v1",
];
let previousIndex = -1;
for (const key of orderedMigrationKeys) {
  const index = operatorSource.indexOf(`key: "${key}"`);
  assert.ok(index > previousIndex, `${key} must retain its documented order.`);
  previousIndex = index;
}
assert.match(operatorSource, /CONVEX_SELF_HOSTED_URL/u);
assert.match(operatorSource, /CONVEX_SELF_HOSTED_ADMIN_KEY/u);
assert.match(operatorSource, /CONVEX_DEPLOYMENT/u);
assert.match(operatorSource, /"--codegen",\s*"disable"/u);
assert.match(operatorSource, /"--typecheck",\s*"disable"/u);
assert.match(operatorSource, /AUTHORIZE_RECONCILIATION_ROLLOUT/u);
assert.match(operatorSource, /ENABLE_RECONCILIATION_INGESTION_APPLY/u);
const automaticReconciliationSource = operatorSource.slice(
  operatorSource.indexOf("async function applyReconciliationVerification"),
  operatorSource.indexOf("async function readCutoverState"),
);
assert.doesNotMatch(
  automaticReconciliationSource,
  /authorizeServerVerifiedReconciliationRollout|enableServerVerifiedReconciliationIngestionApply/u,
  "Verification must stop before either explicit reconciliation enable transition.",
);
assert.match(
  publicationPolicySource,
  /PUBLICATION_POLICY_VERSION\s*=\s*1\s+as const/u,
);
assert.match(
  reconciliationTypesSource,
  /RECONCILIATION_POLICY_VERSION\s*=\s*1\s+as const/u,
);

const qaRoot = mkdtempSync(join(tmpdir(), "event-zeka-rollout-operator-"));
const targetUrl = "http://127.0.0.1:3210";
const adminKey = "qa-admin-key-SUPERSECRET";
const envFile = join(qaRoot, "self-hosted.env");
const stateFile = join(qaRoot, "fake-state.json");
const logFile = join(qaRoot, "fake-calls.jsonl");
const fakeConvexPath = join(qaRoot, "fake-convex.mjs");

function emptyFakeState() {
  return {
    callCounts: {},
    eventStates: {},
    failOnceDone: false,
    publicationState: null,
    reconciliationState: null,
    savedState: null,
  };
}

function setFakeState(value = emptyFakeState()) {
  writeFileSync(stateFile, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  writeFileSync(logFile, "", { mode: 0o600 });
}

function makeReceiptDir(label) {
  const path = join(qaRoot, `receipts-${label}`);
  mkdirSync(path, { mode: 0o700 });
  return path;
}

function receiptFiles(path) {
  return readdirSync(path)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(path, name));
}

function readCalls() {
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function qaEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CONVEX_DEPLOYMENT;
  delete env.CONVEX_DEPLOY_KEY;
  delete env.CONVEX_PREVIEW_DEPLOY_KEY;
  return env;
}

function runOperator(mode, receiptDir, extraArgs = [], extraEnv = {}) {
  const env = qaEnvironment({
    FAKE_CONVEX_LOG: logFile,
    FAKE_CONVEX_SCENARIO: "normal",
    FAKE_CONVEX_STATE: stateFile,
  });
  Object.assign(env, extraEnv);
  return spawnSync(
    process.execPath,
    [
      operatorPath,
      mode,
      "--env-file",
      envFile,
      "--expected-url",
      targetUrl,
      "--receipt-dir",
      receiptDir,
      "--convex-bin",
      fakeConvexPath,
      ...extraArgs,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env,
      timeout: 30_000,
    },
  );
}

const fakeConvexSource = String.raw`#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const command = args[0];
const statePath = process.env.FAKE_CONVEX_STATE;
const logPath = process.env.FAKE_CONVEX_LOG;
const scenario = process.env.FAKE_CONVEX_SCENARIO ?? "normal";
const state = JSON.parse(readFileSync(statePath, "utf8"));
const save = () => writeFileSync(statePath, JSON.stringify(state));
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const log = (value) =>
  appendFileSync(logPath, JSON.stringify({ args, command, ...value }) + "\n");

if (command === "data") {
  const envIndex = args.indexOf("--env-file");
  const table = args[envIndex + 2];
  log({ table });
  const rows =
    table === "eventDomainMigrationState"
      ? Object.values(state.eventStates)
      : table === "savedEventMigrationState"
        ? state.savedState
          ? [state.savedState]
          : []
        : table === "publicationMigrationState"
          ? state.publicationState
            ? [state.publicationState]
            : []
          : table === "reconciliationRolloutState"
            ? state.reconciliationState
            ? [state.reconciliationState]
              : []
            : [];
  if (scenario === "empty_table_stderr" && rows.length === 0) {
    process.stderr.write("There are no documents in this table.\n");
    process.exit(0);
  }
  emit(rows);
  process.exit(0);
}

if (command !== "run") {
  process.stderr.write("unsupported fake command\n");
  process.exit(2);
}

const functionName = args.at(-2);
const payload = JSON.parse(args.at(-1));
log({ functionName, payload });
state.callCounts[functionName] = (state.callCounts[functionName] ?? 0) + 1;

if (
  functionName ===
  "internal/reconciliationRollout:getReconciliationRolloutStatus"
) {
  const rollout = state.reconciliationState;
  const applyReady = Boolean(
    rollout?.operatorEnabled && rollout?.verificationPhase === "enabled",
  );
  emit({
    applyReady,
    blockReasons: rollout ? [] : ["rollout_state_missing"],
    comparedCount: rollout?.comparedCount,
    errorCount: rollout?.errorCount,
    evidenceDigestSha256: rollout?.evidenceDigestSha256,
    expectedOccurrenceCount: rollout?.expectedOccurrenceCount,
    incompleteMigrations: [],
    ingestionApplyEnabled: rollout?.ingestionApplyEnabled === true,
    ingestionApplyReady:
      applyReady && rollout?.ingestionApplyEnabled === true,
    indeterminateCount: rollout?.indeterminateCount,
    matchedCount: rollout?.matchedCount,
    mismatchCount: rollout?.mismatchCount,
    operatorEnabled: rollout?.operatorEnabled === true,
    policyVersion: rollout?.policyVersion,
    prerequisitesSatisfied: true,
    receiptTopologyCoverageSatisfied: true,
    reviewedAt: rollout?.reviewedAt,
    reviewedBy: rollout?.reviewedBy,
    rolloutKey: "source-occurrence-reconciliation-apply-v1",
    singletonStatus: rollout ? "present" : "missing",
    topology: { currentEpoch: 1, verifiedEpoch: 1 },
    updatedAt: rollout?.updatedAt,
    verificationCursorPresent: Boolean(rollout?.verificationCursor),
    verificationKind: rollout?.verificationKind,
    verificationPhase: rollout?.verificationPhase,
    verificationRunId: rollout?.verificationRunId,
    verificationStartedAt: rollout?.verificationStartedAt,
    verificationTopologyEpoch: rollout?.verificationTopologyEpoch,
    verifiedConsolidationEvidenceCount:
      rollout?.verifiedConsolidationEvidenceCount,
    verifiedOperationKinds: rollout?.verifiedOperationKinds ?? [],
  });
  process.exit(0);
}

const migrationByFunction = {
  "internal/migrations/eventDomain:backfillSourceDocumentCanonicalUrlsBatch":
    "source-document-canonical-url-v1",
  "internal/migrations/eventDomain:backfillMediaCanonicalUrlsBatch":
    "media-canonical-url-v1",
  "internal/migrations/eventDomain:backfillCanonicalEventFieldsBatch":
    "canonical-event-domain-fields-v1",
  "internal/migrations/eventDomain:backfillSourceOccurrencesBatch":
    "source-occurrences-generic-v2",
  "internal/migrations/eventDomain:backfillSourceOccurrenceCanonicalPayloadsBatch":
    "source-occurrence-canonical-payload-v1",
  "internal/migrations/eventDomain:auditSourceOccurrenceReceiptTopologyBatch":
    "source-occurrence-receipt-topology-v1",
};
const migrationKey = migrationByFunction[functionName];
if (migrationKey) {
  if (
    scenario === "canonical_mismatch" &&
    migrationKey === "source-document-canonical-url-v1" &&
    payload.dryRun
  ) {
    emit({
      continueCursor: "",
      dryRun: true,
      errorCount: 0,
      isDone: true,
      mismatchCount: 1,
      scannedCount: 1,
      updatedCount: 0,
    });
    process.exit(0);
  }
  const durable = state.eventStates[migrationKey];
  const alreadyClean = durable?.isDone === true && durable.mismatchCount === 0;
  const isTwoPageSource =
    migrationKey === "source-document-canonical-url-v1" && !alreadyClean;
  const firstPage = isTwoPageSource && (payload.cursor ?? null) === null;
  if (
    scenario === "fail_once_resume" &&
    migrationKey === "source-document-canonical-url-v1" &&
    !payload.dryRun &&
    payload.cursor === "cursor-1" &&
    !state.failOnceDone
  ) {
    state.failOnceDone = true;
    save();
    process.stderr.write("injected one-time failure\n");
    process.exit(17);
  }
  if (!payload.dryRun) {
    if (firstPage) {
      state.eventStates[migrationKey] = {
        cursor: "cursor-1",
        errorCount: 0,
        isDone: false,
        key: migrationKey,
        mismatchCount: 0,
        phase: "backfill",
        scannedCount: 1,
        updatedAt: 10,
        updatedCount: 1,
      };
    } else {
      state.eventStates[migrationKey] = {
        completedAt: 20,
        cursor: "",
        errorCount: 0,
        isDone: true,
        key: migrationKey,
        mismatchCount: 0,
        phase: "complete",
        scannedCount: isTwoPageSource ? 2 : 1,
        updatedAt: 20,
        updatedCount: isTwoPageSource ? 2 : 1,
      };
    }
    save();
  }
  emit({
    continueCursor: firstPage ? "cursor-1" : "",
    dryRun: payload.dryRun,
    errorCount: 0,
    isDone: !firstPage,
    mismatchCount: 0,
    scannedCount: 1,
    updatedCount: payload.dryRun && alreadyClean ? 0 : 1,
  });
  process.exit(0);
}

if (functionName === "reconciliation:verifyReconciliationRolloutBatch") {
  const first = !state.reconciliationState;
  const now = first ? 100 : 101;
  const complete = !first;
  state.reconciliationState = {
    comparedCount: complete ? 3 : 1,
    completedAt: complete ? now : undefined,
    coverageEndAt: 10,
    coverageStartAt: 1,
    createdAt: 99,
    errorCount: 0,
    evidenceDigestSha256: "a".repeat(64),
    expectedOccurrenceCount: complete ? 3 : 1,
    indeterminateCount: 0,
    ingestionApplyEnabled: false,
    key: "source-occurrence-reconciliation-apply-v1",
    matchedCount: complete ? 3 : 1,
    mismatchCount: 0,
    note: "server verifier",
    operatorEnabled: false,
    policyVersion: 1,
    reviewedBy: "server_full_outcome_verifier",
    updatedAt: now,
    verificationCursor: complete ? undefined : "recon-cursor-1",
    verificationKind: "server_full_outcome_v1",
    verificationPhase: complete ? "ready_for_review" : "scanning",
    verificationRunId: "qa-verification-run",
    verificationStartedAt: 99,
    verificationTopologyEpoch: 1,
    verifiedConsolidationEvidenceCount: 0,
    verifiedOperationKinds: complete ? ["attach", "create", "update"] : ["create"],
  };
  save();
  emit({
    comparedCount: complete ? 3 : 1,
    continueCursor: complete ? "" : "recon-cursor-1",
    errorCount: 0,
    evidenceDigestSha256: "a".repeat(64),
    expectedOccurrenceCount: complete ? 3 : 1,
    indeterminateCount: 0,
    isDone: complete,
    matchedCount: complete ? 3 : 1,
    mismatchCount: 0,
    operatorEnabled: false,
    phase: complete ? "ready_for_review" : "scanning",
    updatedAt: now,
    verifiedOperationKinds: complete ? ["attach", "create", "update"] : ["create"],
    verificationRunId: "qa-verification-run",
  });
  process.exit(0);
}

if (functionName === "internal/migrations/savedEvents:reviewSavedEventReadCutover") {
  if (!state.savedState || state.savedState.updatedAt !== payload.expectedStateUpdatedAt) {
    process.stderr.write("fake saved state CAS mismatch\n");
    process.exit(19);
  }
  const now = state.savedState.updatedAt + 1;
  state.savedState = {
    ...state.savedState,
    cutoverEnabled: true,
    cutoverGeneration: (state.savedState.cutoverGeneration ?? 0) + 1,
    phase: "cutover_enabled",
    readCutoverEnabled: true,
    reviewNote: payload.note,
    reviewedAt: now,
    reviewedBy: payload.reviewedBy,
    updatedAt: now,
    writeCutoverEnabled: false,
  };
  save();
  emit({
    cutoverEnabled: true,
    phase: "cutover_enabled",
    reviewedAt: now,
    updatedAt: now,
  });
  process.exit(0);
}

if (
  functionName ===
    "internal/reconciliationRollout:disableServerVerifiedReconciliationRollout"
) {
  if (
    !state.reconciliationState ||
    state.reconciliationState.updatedAt !== payload.expectedUpdatedAt ||
    state.reconciliationState.evidenceDigestSha256 !==
      payload.expectedEvidenceDigestSha256 ||
    state.reconciliationState.verificationRunId !==
      payload.expectedVerificationRunId
  ) {
    process.stderr.write("fake reconciliation state CAS mismatch\n");
    process.exit(23);
  }
  const now = state.reconciliationState.updatedAt + 1;
  state.reconciliationState = {
    ...state.reconciliationState,
    ingestionApplyEnabled: false,
    note: payload.note,
    operatorEnabled: false,
    reviewedAt: now,
    reviewedBy: payload.disabledBy,
    updatedAt: now,
    verificationCursor: undefined,
    verificationPhase: "blocked",
  };
  save();
  emit({
    operatorEnabled: false,
    policyVersion: 1,
    updatedAt: now,
    verificationPhase: "blocked",
    verificationRunId: payload.expectedVerificationRunId,
  });
  process.exit(0);
}

if (
  functionName ===
    "internal/reconciliationRollout:authorizeServerVerifiedReconciliationRollout"
) {
  if (
    !state.reconciliationState ||
    state.reconciliationState.updatedAt !== payload.expectedUpdatedAt ||
    state.reconciliationState.evidenceDigestSha256 !==
      payload.expectedEvidenceDigestSha256 ||
    state.reconciliationState.verificationRunId !==
      payload.expectedVerificationRunId
  ) {
    process.stderr.write("fake reconciliation authorization CAS mismatch\n");
    process.exit(24);
  }
  const now = state.reconciliationState.updatedAt + 1;
  state.reconciliationState = {
    ...state.reconciliationState,
    ingestionApplyEnabled: false,
    note: payload.note,
    operatorEnabled: true,
    reviewedAt: now,
    reviewedBy: payload.reviewedBy,
    updatedAt: now,
    verificationPhase: "enabled",
  };
  save();
  emit({
    operatorEnabled: true,
    policyVersion: 1,
    reviewedAt: now,
    updatedAt: now,
    verificationRunId: payload.expectedVerificationRunId,
  });
  process.exit(0);
}

if (
  functionName ===
    "internal/reconciliationRollout:enableServerVerifiedReconciliationIngestionApply"
) {
  if (
    !state.reconciliationState ||
    state.reconciliationState.updatedAt !== payload.expectedUpdatedAt ||
    state.reconciliationState.evidenceDigestSha256 !==
      payload.expectedEvidenceDigestSha256 ||
    state.reconciliationState.verificationRunId !==
      payload.expectedVerificationRunId
  ) {
    process.stderr.write("fake reconciliation ingestion CAS mismatch\n");
    process.exit(25);
  }
  const now = state.reconciliationState.updatedAt + 1;
  state.reconciliationState = {
    ...state.reconciliationState,
    ingestionApplyEnabled: true,
    note: payload.note,
    reviewedAt: now,
    reviewedBy: payload.enabledBy,
    updatedAt: now,
  };
  save();
  emit({
    ingestionApplyEnabled: true,
    operatorEnabled: true,
    policyVersion: 1,
    updatedAt: now,
    verificationRunId: payload.expectedVerificationRunId,
  });
  process.exit(0);
}

process.stderr.write("unsupported fake function " + functionName + "\n");
process.exit(3);
`;

try {
  writeFileSync(
    envFile,
    `CONVEX_SELF_HOSTED_URL=${targetUrl}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${adminKey}\n`,
    { mode: 0o600 },
  );
  writeFileSync(fakeConvexPath, fakeConvexSource, { mode: 0o700 });
  chmodSync(fakeConvexPath, 0o700);
  setFakeState();

  {
    const receiptDir = makeReceiptDir("preview");
    const result = runOperator(
      "preview",
      receiptDir,
      ["--workflow", "canonical", "--max-pages", "10"],
    );
    assert.equal(result.status, 0, result.stderr);
    const calls = readCalls();
    assert.equal(
      calls.filter(
        (call) =>
          call.functionName ===
          "internal/migrations/eventDomain:backfillSourceDocumentCanonicalUrlsBatch",
      ).length,
      2,
      "Preview must exhaust a multi-page cursor.",
    );
    assert.deepEqual(
      calls
        .filter((call) => call.command === "run")
        .map((call) => call.functionName)
        .filter((name, index, all) => all.indexOf(name) === index),
      [
        "internal/migrations/eventDomain:backfillSourceDocumentCanonicalUrlsBatch",
        "internal/migrations/eventDomain:backfillMediaCanonicalUrlsBatch",
        "internal/migrations/eventDomain:backfillCanonicalEventFieldsBatch",
      ],
    );
    for (const call of calls) {
      assert.ok(call.args.includes("--env-file"));
      assert.ok(!call.args.includes("--prod"));
      assert.ok(!call.args.includes("--push"));
      if (call.command === "run") {
        assert.deepEqual(
          call.args.slice(call.args.indexOf("--typecheck"), -2),
          ["--typecheck", "disable", "--codegen", "disable"],
        );
      }
    }
    const [receiptPath] = receiptFiles(receiptDir);
    const receiptText = readFileSync(receiptPath, "utf8");
    const receipt = JSON.parse(receiptText);
    assert.equal(receipt.status, "complete");
    assert.ok(!receiptText.includes(adminKey));
    assert.equal(statSync(receiptPath).mode & 0o077, 0);
  }

  {
    setFakeState();
    const receiptDir = makeReceiptDir("occurrence-order");
    const result = runOperator("preview", receiptDir, [
      "--workflow",
      "occurrences",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      readCalls()
        .filter((call) => call.command === "run")
        .map((call) => call.functionName),
      [
        "internal/migrations/eventDomain:backfillSourceOccurrencesBatch",
        "internal/migrations/eventDomain:backfillSourceOccurrenceCanonicalPayloadsBatch",
        "internal/migrations/eventDomain:auditSourceOccurrenceReceiptTopologyBatch",
      ],
    );
  }

  {
    const restartKey = "source-document-canonical-url-v1";
    setFakeState({
      ...emptyFakeState(),
      eventStates: {
        [restartKey]: {
          completedAt: 20,
          cursor: "",
          errorCount: 0,
          isDone: true,
          key: restartKey,
          mismatchCount: 0,
          phase: "complete",
          scannedCount: 2,
          updatedAt: 20,
          updatedCount: 2,
        },
      },
    });
    const receiptDir = makeReceiptDir("explicit-clean-restart");
    const result = runOperator("apply", receiptDir, [
      "--workflow",
      "canonical",
      "--restart-key",
      restartKey,
      "--confirm",
      "APPLY_EVENT_DOMAIN_ROLLOUT",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const restartedCalls = readCalls().filter(
      (call) =>
        call.command === "run" &&
        call.functionName ===
          "internal/migrations/eventDomain:backfillSourceDocumentCanonicalUrlsBatch",
    );
    assert.equal(restartedCalls.length, 3);
    assert.equal(
      restartedCalls.some(
        (call) => call.payload.dryRun === false && call.payload.restart === true,
      ),
      true,
      "An explicit allowed restart must re-apply a clean migration state.",
    );
    const receipt = JSON.parse(
      readFileSync(receiptFiles(receiptDir)[0], "utf8"),
    );
    assert.equal(
      receipt.gates.find((gate) => gate.key === restartKey)?.status,
      "clean",
    );
  }

  {
    setFakeState();
    const receiptDir = makeReceiptDir("mismatch");
    const result = runOperator(
      "preview",
      receiptDir,
      ["--workflow", "canonical"],
      { FAKE_CONVEX_SCENARIO: "canonical_mismatch" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /E_GATE/u);
    assert.equal(
      readCalls().some(
        (call) => call.command === "run" && call.payload?.dryRun === false,
      ),
      false,
    );
  }

  {
    setFakeState();
    const receiptDir = makeReceiptDir("resume");
    const args = [
      "--workflow",
      "canonical",
      "--confirm",
      "APPLY_EVENT_DOMAIN_ROLLOUT",
      "--max-pages",
      "10",
    ];
    const failed = runOperator("apply", receiptDir, args, {
      FAKE_CONVEX_SCENARIO: "fail_once_resume",
    });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /E_CONVEX_COMMAND/u);
    const [receiptPath] = receiptFiles(receiptDir);
    const failedReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(failedReceipt.status, "failed");
    const resumed = runOperator(
      "apply",
      receiptDir,
      [...args, "--resume", receiptPath],
      { FAKE_CONVEX_SCENARIO: "fail_once_resume" },
    );
    assert.equal(resumed.status, 0, resumed.stderr);
    const resumedReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(resumedReceipt.status, "complete");
    assert.equal(resumedReceipt.resumeCount, 1);
    assert.equal("failure" in resumedReceipt, false);
    assert.equal(
      Object.values(JSON.parse(readFileSync(stateFile, "utf8")).eventStates)
        .every((state) => state.isDone && state.mismatchCount === 0),
      true,
    );
  }

  {
    setFakeState();
    const receiptDir = makeReceiptDir("reconciliation");
    const result = runOperator("apply", receiptDir, [
      "--workflow",
      "reconciliation",
      "--confirm",
      "APPLY_EVENT_DOMAIN_ROLLOUT",
      "--max-pages",
      "10",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const runCalls = readCalls().filter((call) => call.command === "run");
    assert.equal(runCalls.length, 2);
    assert.ok(
      runCalls.every(
        (call) =>
          call.functionName ===
          "reconciliation:verifyReconciliationRolloutBatch",
      ),
    );
    const receipt = JSON.parse(
      readFileSync(receiptFiles(receiptDir)[0], "utf8"),
    );
    assert.equal(
      receipt.gates.at(-1).status,
      "ready_for_human_review_not_authorized",
    );
  }

  {
    const readyState = JSON.parse(
      readFileSync(stateFile, "utf8"),
    ).reconciliationState;
    setFakeState({
      ...emptyFakeState(),
      reconciliationState: readyState,
    });
    const receiptDir = makeReceiptDir("reconciliation-enable");
    const beforeStatus = new Set(receiptFiles(receiptDir));
    const statusBeforeAuthorization = runOperator("status", receiptDir);
    assert.equal(statusBeforeAuthorization.status, 0, statusBeforeAuthorization.stderr);
    const reviewedAuthorizationReceipt = receiptFiles(receiptDir).find(
      (path) => !beforeStatus.has(path),
    );
    assert.ok(reviewedAuthorizationReceipt);
    const commonFences = [
      "--expected-evidence-digest",
      readyState.evidenceDigestSha256,
      "--expected-verification-run-id",
      readyState.verificationRunId,
      "--operator",
      "qa-cutover-operator",
    ];
    const authorization = runOperator("apply", receiptDir, [
      "--workflow",
      "reconciliation-authorize",
      "--confirm",
      "AUTHORIZE_RECONCILIATION_ROLLOUT",
      "--expected-state-updated-at",
      String(readyState.updatedAt),
      "--reviewed-status-receipt",
      reviewedAuthorizationReceipt,
      ...commonFences,
      "--note",
      "QA explicitly authorizes the reviewed generic reconciliation frontier.",
    ]);
    assert.equal(authorization.status, 0, authorization.stderr);
    let enabledState = JSON.parse(
      readFileSync(stateFile, "utf8"),
    ).reconciliationState;
    assert.equal(enabledState.operatorEnabled, true);
    assert.equal(enabledState.ingestionApplyEnabled, false);

    const beforeIngestionStatus = new Set(receiptFiles(receiptDir));
    const statusBeforeIngestion = runOperator("status", receiptDir);
    assert.equal(statusBeforeIngestion.status, 0, statusBeforeIngestion.stderr);
    const reviewedIngestionReceipt = receiptFiles(receiptDir).find(
      (path) => !beforeIngestionStatus.has(path),
    );
    assert.ok(reviewedIngestionReceipt);
    const ingestionEnable = runOperator("apply", receiptDir, [
      "--workflow",
      "reconciliation-ingestion-enable",
      "--confirm",
      "ENABLE_RECONCILIATION_INGESTION_APPLY",
      "--expected-state-updated-at",
      String(enabledState.updatedAt),
      "--reviewed-status-receipt",
      reviewedIngestionReceipt,
      "--expected-evidence-digest",
      enabledState.evidenceDigestSha256,
      "--expected-verification-run-id",
      enabledState.verificationRunId,
      "--operator",
      "qa-cutover-operator",
      "--note",
      "QA separately enables ingestion only after reviewing generic apply status.",
    ]);
    assert.equal(ingestionEnable.status, 0, ingestionEnable.stderr);
    enabledState = JSON.parse(
      readFileSync(stateFile, "utf8"),
    ).reconciliationState;
    assert.equal(enabledState.operatorEnabled, true);
    assert.equal(enabledState.ingestionApplyEnabled, true);
  }

  {
    const savedState = {
      alreadyCanonicalCount: 1,
      canonicalAuditDone: true,
      canonicalDuplicateRowCount: 0,
      canonicalScannedCount: 3,
      canonicalUniqueRowCount: 3,
      completedAt: 40,
      conflictCount: 0,
      createdAt: 1,
      cutoverEnabled: false,
      cutoverGeneration: 2,
      duplicateLegacyRowCount: 1,
      insertedCount: 1,
      isDone: true,
      key: "saved-events-legacy-to-canonical-v1",
      mismatchCount: 0,
      missingUserCount: 0,
      phase: "ready_for_review",
      readCutoverEnabled: false,
      scannedCount: 3,
      timestampMismatchCount: 0,
      updatedAt: 42,
      writeCutoverEnabled: false,
    };
    setFakeState({ ...emptyFakeState(), savedState });
    const staleReceiptDir = makeReceiptDir("cutover-stale");
    const common = [
      "--workflow",
      "saved-read-cutover",
      "--confirm",
      "ENABLE_SAVED_EVENT_READ_CUTOVER",
      "--operator",
      "qa-operator",
      "--note",
      "QA reviewed clean equivalence",
    ];
    const stale = runOperator("apply", staleReceiptDir, [
      ...common,
      "--expected-state-updated-at",
      "41",
    ]);
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /E_STATE_VERSION/u);
    assert.equal(readCalls().some((call) => call.command === "run"), false);

    writeFileSync(logFile, "", { mode: 0o600 });
    const receiptDir = makeReceiptDir("cutover-success");
    const applied = runOperator("apply", receiptDir, [
      ...common,
      "--expected-state-updated-at",
      "42",
    ]);
    assert.equal(applied.status, 0, applied.stderr);
    const finalState = JSON.parse(readFileSync(stateFile, "utf8")).savedState;
    assert.equal(finalState.updatedAt, 43);
    assert.equal(finalState.cutoverGeneration, 3);
    assert.equal(finalState.readCutoverEnabled, true);
    assert.equal(finalState.writeCutoverEnabled, false);
    const receiptText = readFileSync(receiptFiles(receiptDir)[0], "utf8");
    assert.ok(!receiptText.includes(adminKey));
    assert.equal(
      JSON.parse(receiptText).review.noteDigestSha256.length,
      64,
    );
  }

  {
    const evidenceDigestSha256 = "b".repeat(64);
    const verificationRunId = "qa-enabled-verification-run";
    setFakeState({
      ...emptyFakeState(),
      reconciliationState: {
        comparedCount: 3,
        completedAt: 45,
        coverageEndAt: 10,
        coverageStartAt: 1,
        createdAt: 1,
        errorCount: 0,
        evidenceDigestSha256,
        expectedOccurrenceCount: 3,
        indeterminateCount: 0,
        ingestionApplyEnabled: true,
        key: "source-occurrence-reconciliation-apply-v1",
        matchedCount: 3,
        mismatchCount: 0,
        note: "enabled",
        operatorEnabled: true,
        policyVersion: 1,
        reviewedAt: 45,
        reviewedBy: "previous-operator",
        updatedAt: 50,
        verificationKind: "server_full_outcome_v1",
        verificationPhase: "enabled",
        verificationRunId,
        verificationStartedAt: 10,
        verificationTopologyEpoch: 1,
        verifiedOperationKinds: ["attach", "create", "update"],
      },
    });
    const receiptDir = makeReceiptDir("reconciliation-disable");
    const result = runOperator("apply", receiptDir, [
      "--workflow",
      "reconciliation-disable",
      "--confirm",
      "DISABLE_RECONCILIATION_ROLLOUT",
      "--expected-state-updated-at",
      "50",
      "--expected-evidence-digest",
      evidenceDigestSha256,
      "--expected-verification-run-id",
      verificationRunId,
      "--operator",
      "qa-emergency-operator",
      "--note",
      "QA emergency rollback disables every reconciliation apply gate.",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(
      readFileSync(stateFile, "utf8"),
    ).reconciliationState;
    assert.equal(state.updatedAt, 51);
    assert.equal(state.operatorEnabled, false);
    assert.equal(state.ingestionApplyEnabled, false);
    assert.equal(state.verificationPhase, "blocked");
  }

  {
    setFakeState();
    const receiptDir = makeReceiptDir("status-empty-cli-table");
    const result = runOperator("status", receiptDir, [], {
      FAKE_CONVEX_SCENARIO: "empty_table_stderr",
    });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(
      readFileSync(receiptFiles(receiptDir)[0], "utf8"),
    );
    const emptyDataCommands = receipt.commands.filter(
      (command) =>
        command.operation.startsWith("data:") &&
        command.stderr === "There are no documents in this table.",
    );
    assert.equal(emptyDataCommands.length, 5);
    assert.ok(emptyDataCommands.every((command) => command.status === "complete"));
    assert.ok(emptyDataCommands.every((command) => command.result.length === 0));
  }

  {
    setFakeState();
    const receiptDir = makeReceiptDir("status");
    const result = runOperator("status", receiptDir);
    assert.equal(result.status, 0, result.stderr);
    const calls = readCalls();
    assert.equal(calls.length, 6);
    assert.equal(calls.filter((call) => call.command === "data").length, 5);
    assert.equal(
      calls.at(-1).functionName,
      "internal/reconciliationRollout:getReconciliationRolloutStatus",
    );
    const receipt = JSON.parse(
      readFileSync(receiptFiles(receiptDir)[0], "utf8"),
    );
    assert.deepEqual(Object.keys(receipt.statusSnapshot).sort(), [
      "eventDomainMigrationState",
      "publicationMigrationState",
      "reconciliationRolloutControl",
      "reconciliationRolloutState",
      "savedEventMigrationState",
      "sourceOccurrenceTopologyEpoch",
    ]);
  }

  {
    setFakeState();
    const receiptDir = makeReceiptDir("target-refusals");
    const forbiddenEnv = join(qaRoot, "forbidden.env");
    writeFileSync(
      forbiddenEnv,
      `CONVEX_SELF_HOSTED_URL=${targetUrl}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${adminKey}\nCONVEX_DEPLOYMENT=prod:cloud\n`,
      { mode: 0o600 },
    );
    const forbidden = spawnSync(
      process.execPath,
      [
        operatorPath,
        "status",
        "--env-file",
        forbiddenEnv,
        "--expected-url",
        targetUrl,
        "--receipt-dir",
        receiptDir,
        "--convex-bin",
        fakeConvexPath,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: qaEnvironment({
          FAKE_CONVEX_LOG: logFile,
          FAKE_CONVEX_STATE: stateFile,
        }),
      },
    );
    assert.notEqual(forbidden.status, 0);
    assert.match(forbidden.stderr, /E_TARGET_AMBIGUOUS/u);
    assert.equal(readCalls().length, 0);

    const ambient = runOperator("status", receiptDir, [], {
      CONVEX_DEPLOYMENT: "prod:cloud",
    });
    assert.notEqual(ambient.status, 0);
    assert.match(ambient.stderr, /E_TARGET_AMBIGUOUS/u);
    assert.equal(readCalls().length, 0);
  }

  {
    setFakeState();
    const receiptDir = makeReceiptDir("confirmation");
    const result = runOperator("apply", receiptDir, [
      "--workflow",
      "canonical",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /E_CONFIRMATION/u);
    assert.equal(readCalls().length, 0);
  }

  console.log("Event-domain rollout operator QA passed.");
} finally {
  rmSync(qaRoot, { force: true, recursive: true });
}
