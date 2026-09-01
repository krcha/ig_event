#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";

const RECEIPT_SCHEMA_VERSION = "event-zeka-event-domain-rollout-receipt-v1";
const OPERATOR_VERSION = "event-domain-rollout-operator-v1";
const DEFAULT_MAX_PAGES = 10_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const STATE_TABLE_LIMIT = 200;
const REQUIRED_RECONCILIATION_OPERATIONS = ["attach", "create", "update"];
const EXPECTED_PUBLICATION_POLICY_VERSION = 1;
const EXPECTED_RECONCILIATION_POLICY_VERSION = 1;

const EVENT_DOMAIN_STEPS = [
  {
    workflow: "canonical",
    key: "source-document-canonical-url-v1",
    functionName:
      "internal/migrations/eventDomain:backfillSourceDocumentCanonicalUrlsBatch",
    kind: "event_domain_page",
    limit: 50,
  },
  {
    workflow: "canonical",
    key: "media-canonical-url-v1",
    functionName:
      "internal/migrations/eventDomain:backfillMediaCanonicalUrlsBatch",
    kind: "event_domain_page",
    limit: 50,
  },
  {
    workflow: "canonical",
    key: "canonical-event-domain-fields-v1",
    functionName:
      "internal/migrations/eventDomain:backfillCanonicalEventFieldsBatch",
    kind: "event_domain_page",
    limit: 50,
  },
  {
    workflow: "venues",
    key: "reviewed-kolarac-venue-consolidation-v1",
    functionName:
      "internal/migrations/eventDomain:consolidateReviewedKolaracVenue",
    kind: "event_domain_page",
    limit: 1,
  },
  {
    workflow: "venues",
    key: "reviewed-official-venue-directory-additions-v1",
    functionName:
      "internal/migrations/eventDomain:addReviewedOfficialVenueDirectoryEntries",
    kind: "event_domain_page",
    limit: 2,
  },
  {
    workflow: "venues",
    key: "venue-compatibility-seed-audit-v1",
    functionName:
      "internal/migrations/eventDomain:auditVenueCompatibilitySeeds",
    kind: "venue_seed_audit",
  },
  {
    workflow: "venues",
    key: "venue-identities-v1",
    functionName:
      "internal/migrations/eventDomain:backfillVenueIdentitiesBatch",
    kind: "event_domain_page",
    limit: 50,
  },
  {
    workflow: "venues",
    key: "campaign-lineage-reattestation-v1",
    functionName:
      "internal/migrations/campaignLineage:reattestCampaignLineageBatch",
    kind: "campaign_page",
    limit: 16,
  },
  {
    workflow: "venues",
    key: "reviewed-madlenianum-duplicate-source-rewire-v1",
    functionName:
      "internal/migrations/eventDomain:rewireReviewedMadlenianumDuplicate",
    kind: "event_domain_page",
    limit: 1,
  },
  {
    workflow: "venues",
    key: "reviewed-mrak-source-occurrence-correction-v1",
    functionName:
      "internal/migrations/eventDomain:correctReviewedMrakSourceOccurrence",
    kind: "event_domain_page",
    limit: 1,
  },
  {
    workflow: "venues",
    key: "event-venue-bindings-v1",
    functionName:
      "internal/migrations/eventDomain:backfillEventVenueBindingsBatch",
    kind: "event_domain_page",
    limit: 50,
  },
  {
    workflow: "occurrences",
    key: "legacy-source-occurrence-admission-v1",
    functionName:
      "internal/migrations/eventDomain:admitLegacySourceOccurrencesBatch",
    kind: "event_domain_page",
    limit: 50,
  },
  {
    workflow: "occurrences",
    key: "source-occurrences-generic-v2",
    functionName:
      "internal/migrations/eventDomain:backfillSourceOccurrencesBatch",
    kind: "event_domain_page",
    limit: 50,
  },
  {
    workflow: "occurrences",
    key: "source-occurrence-canonical-payload-v1",
    functionName:
      "internal/migrations/eventDomain:backfillSourceOccurrenceCanonicalPayloadsBatch",
    kind: "event_domain_page",
    limit: 25,
  },
  {
    workflow: "occurrences",
    key: "source-occurrence-receipt-topology-v1",
    functionName:
      "internal/migrations/eventDomain:auditSourceOccurrenceReceiptTopologyBatch",
    kind: "event_domain_page",
    limit: 4,
  },
];

const WORKFLOWS = new Set([
  "all",
  "canonical",
  "venues",
  "occurrences",
  "saved-events",
  "publication",
  "reconciliation",
  "saved-read-cutover",
  "saved-write-cutover",
  "saved-cutover-rollback",
  "publication-read-cutover",
  "publication-cutover-rollback",
  "reconciliation-disable",
  "reconciliation-abandon",
  "reconciliation-authorize",
  "reconciliation-ingestion-enable",
]);

const CUTOVER_CONFIRMATIONS = {
  "saved-read-cutover": "ENABLE_SAVED_EVENT_READ_CUTOVER",
  "saved-write-cutover": "ENABLE_SAVED_EVENT_WRITE_CUTOVER",
  "saved-cutover-rollback": "ROLLBACK_SAVED_EVENT_CUTOVER",
  "publication-read-cutover": "ENABLE_PUBLICATION_READ_CUTOVER",
  "publication-cutover-rollback": "ROLLBACK_PUBLICATION_READ_CUTOVER",
  "reconciliation-disable": "DISABLE_RECONCILIATION_ROLLOUT",
  "reconciliation-abandon": "ABANDON_RECONCILIATION_VERIFICATION",
  "reconciliation-authorize": "AUTHORIZE_RECONCILIATION_ROLLOUT",
  "reconciliation-ingestion-enable":
    "ENABLE_RECONCILIATION_INGESTION_APPLY",
};

const NON_EVENT_DOMAIN_RESTART_KEYS = new Map([
  ["saved-events-legacy-to-canonical-v1", "saved-events"],
  ["materialized-publication-v1", "publication"],
  ["source-occurrence-reconciliation-apply-v1", "reconciliation"],
]);

const HELP = `Usage:
  node scripts/event-domain-rollout-operator.mjs status [options]
  node scripts/event-domain-rollout-operator.mjs preview [options]
  node scripts/event-domain-rollout-operator.mjs apply [options]

Required options:
  --env-file ABSOLUTE_PATH       Self-hosted-only Convex CLI env file
  --expected-url URL             Exact expected CONVEX_SELF_HOSTED_URL
  --receipt-dir ABSOLUTE_PATH    Private directory for atomic JSON receipts

Workflow options:
  --workflow NAME                all, canonical, venues, occurrences,
                                 saved-events, publication, reconciliation,
                                 saved-read-cutover, saved-write-cutover,
                                 saved-cutover-rollback,
                                 publication-read-cutover, or
                                 publication-cutover-rollback,
                                 reconciliation-disable, or
                                 reconciliation-abandon,
                                 reconciliation-authorize, or
                                 reconciliation-ingestion-enable
  --restart-key KEY              Explicitly restart one completed/blocked
                                 migration after its data issue was repaired;
                                 may be repeated
  --max-pages N                  Maximum bounded pages per operation
  --timeout-ms N                 Timeout per Convex CLI call
  --resume ABSOLUTE_RECEIPT      Resume and append to an incomplete receipt

Apply-only options:
  --confirm TOKEN                APPLY_EVENT_DOMAIN_ROLLOUT for migrations;
                                 cutovers require their workflow-specific token
  --expected-state-updated-at N  Exact optimistic state version for a cutover
  --operator TEXT                Named cutover reviewer
  --note TEXT                    Non-empty cutover review/rollback note
  --expected-evidence-digest HEX Exact reconciliation evidence digest fence
  --expected-verification-run ID Exact reconciliation verification run fence
  --reviewed-status-receipt PATH Completed matching status receipt required
                                 for reconciliation enable transitions

Safety properties:
  The env file must contain exactly CONVEX_SELF_HOSTED_URL and
  CONVEX_SELF_HOSTED_ADMIN_KEY, be a private regular file, and contain no
  CONVEX_DEPLOYMENT or cloud/preview deploy key. Reconciliation verification
  never authorizes or enables apply.
`;

class OperatorError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "OperatorError";
    this.code = code;
    this.details = details;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new OperatorError("E_TARGET", `${label} is not a valid URL.`);
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new OperatorError(
      "E_TARGET",
      `${label} must be a plain HTTP(S) origin without credentials, query, or fragment.`,
    );
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/u, "");
  return `${parsed.origin}${normalizedPath}`;
}

function parseEnvText(text) {
  const values = new Map();
  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) {
      throw new OperatorError(
        "E_ENV_FILE",
        `Env line ${index + 1} uses unsupported export syntax.`,
      );
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) {
      throw new OperatorError(
        "E_ENV_FILE",
        `Env line ${index + 1} is malformed.`,
      );
    }
    const [, name, rawValue] = match;
    if (values.has(name)) {
      throw new OperatorError(
        "E_ENV_FILE",
        `Env variable ${name} is duplicated.`,
      );
    }
    let value = rawValue.trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(name, value);
  }
  return values;
}

function parsePositiveInteger(raw, label, maximum) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new OperatorError(
      "E_ARGS",
      `${label} must be an integer from 1 through ${maximum}.`,
    );
  }
  return value;
}

function allowedRestartKeys(workflow) {
  const allowed = new Set();
  for (const step of EVENT_DOMAIN_STEPS) {
    if (workflow === "all" || workflow === step.workflow) allowed.add(step.key);
  }
  for (const [key, owner] of NON_EVENT_DOMAIN_RESTART_KEYS) {
    if (workflow === "all" || workflow === owner) allowed.add(key);
  }
  return allowed;
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }
  const mode = argv[0];
  if (!new Set(["status", "preview", "apply"]).has(mode)) {
    throw new OperatorError(
      "E_ARGS",
      "First argument must be status, preview, or apply.",
    );
  }
  const options = {
    mode,
    workflow: "all",
    restartKeys: new Set(),
    maxPages: DEFAULT_MAX_PAGES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  const takesValue = new Set([
    "--env-file",
    "--expected-url",
    "--receipt-dir",
    "--workflow",
    "--restart-key",
    "--max-pages",
    "--timeout-ms",
    "--resume",
    "--confirm",
    "--expected-state-updated-at",
    "--operator",
    "--note",
    "--expected-evidence-digest",
    "--expected-verification-run-id",
    "--reviewed-status-receipt",
    "--convex-bin",
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!takesValue.has(flag)) {
      throw new OperatorError("E_ARGS", `Unknown option: ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new OperatorError("E_ARGS", `Missing value for ${flag}.`);
    }
    index += 1;
    switch (flag) {
      case "--env-file":
        options.envFile = value;
        break;
      case "--expected-url":
        options.expectedUrl = value;
        break;
      case "--receipt-dir":
        options.receiptDir = value;
        break;
      case "--workflow":
        options.workflow = value;
        break;
      case "--restart-key":
        options.restartKeys.add(value);
        break;
      case "--max-pages":
        options.maxPages = parsePositiveInteger(value, flag, 100_000);
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInteger(value, flag, 600_000);
        break;
      case "--resume":
        options.resume = value;
        break;
      case "--confirm":
        options.confirm = value;
        break;
      case "--expected-state-updated-at":
        options.expectedStateUpdatedAt = parsePositiveInteger(
          value,
          flag,
          Number.MAX_SAFE_INTEGER,
        );
        break;
      case "--operator":
        options.operator = value.trim();
        break;
      case "--note":
        options.note = value.trim();
        break;
      case "--expected-evidence-digest":
        options.expectedEvidenceDigest = value.trim();
        break;
      case "--expected-verification-run-id":
        options.expectedVerificationRunId = value.trim();
        break;
      case "--reviewed-status-receipt":
        options.reviewedStatusReceipt = value;
        break;
      case "--convex-bin":
        options.convexBin = value;
        break;
      default:
        throw new OperatorError("E_ARGS", `Unhandled option: ${flag}`);
    }
  }
  if (!WORKFLOWS.has(options.workflow)) {
    throw new OperatorError(
      "E_ARGS",
      `Unsupported workflow: ${options.workflow}`,
    );
  }
  for (const [label, value] of [
    ["--env-file", options.envFile],
    ["--receipt-dir", options.receiptDir],
  ]) {
    if (!value || !isAbsolute(value)) {
      throw new OperatorError("E_ARGS", `${label} must be an absolute path.`);
    }
  }
  if (!options.expectedUrl) {
    throw new OperatorError("E_ARGS", "--expected-url is required.");
  }
  if (options.resume && !isAbsolute(options.resume)) {
    throw new OperatorError("E_ARGS", "--resume must be an absolute path.");
  }
  if (
    options.reviewedStatusReceipt &&
    !isAbsolute(options.reviewedStatusReceipt)
  ) {
    throw new OperatorError(
      "E_ARGS",
      "--reviewed-status-receipt must be an absolute path.",
    );
  }
  if (options.convexBin && !isAbsolute(options.convexBin)) {
    throw new OperatorError("E_ARGS", "--convex-bin must be an absolute path.");
  }

  const cutoverConfirmation = CUTOVER_CONFIRMATIONS[options.workflow];
  if (options.mode === "apply") {
    const expectedConfirmation =
      cutoverConfirmation ?? "APPLY_EVENT_DOMAIN_ROLLOUT";
    if (options.confirm !== expectedConfirmation) {
      throw new OperatorError(
        "E_CONFIRMATION",
        `Apply requires --confirm ${expectedConfirmation}.`,
      );
    }
    if (cutoverConfirmation) {
      if (!options.expectedStateUpdatedAt) {
        throw new OperatorError(
          "E_ARGS",
          "Cutover apply requires --expected-state-updated-at.",
        );
      }
      if (!options.operator || !options.note) {
        throw new OperatorError(
          "E_ARGS",
          "Cutover apply requires --operator and --note.",
        );
      }
      if (options.operator.length > 2_000 || options.note.length > 2_000) {
        throw new OperatorError(
          "E_ARGS",
          "Cutover operator and note must each be at most 2,000 characters.",
        );
      }
      if (
        options.workflow.startsWith("reconciliation-") &&
        (!/^[a-f0-9]{64}$/u.test(options.expectedEvidenceDigest ?? "") ||
          !options.expectedVerificationRunId ||
          options.expectedVerificationRunId.length > 256 ||
          options.note.length < 20)
      ) {
        throw new OperatorError(
          "E_ARGS",
          "Reconciliation rollback requires exact evidence-digest and verification-run fences.",
        );
      }
      if (
        new Set([
          "reconciliation-authorize",
          "reconciliation-ingestion-enable",
        ]).has(options.workflow) &&
        !options.reviewedStatusReceipt
      ) {
        throw new OperatorError(
          "E_ARGS",
          "Reconciliation enable transitions require --reviewed-status-receipt.",
        );
      }
    }
  }
  if (
    options.mode !== "apply" &&
    (options.confirm ||
      options.expectedStateUpdatedAt ||
      options.operator ||
      options.note)
  ) {
    throw new OperatorError(
      "E_ARGS",
      "Apply-only review and confirmation options are not accepted in status or preview mode.",
    );
  }
  if (
    options.mode !== "apply" &&
    (options.expectedEvidenceDigest || options.expectedVerificationRunId)
  ) {
    throw new OperatorError(
      "E_ARGS",
      "Reconciliation evidence fences are accepted only in apply mode.",
    );
  }
  if (options.mode !== "apply" && options.reviewedStatusReceipt) {
    throw new OperatorError(
      "E_ARGS",
      "--reviewed-status-receipt is accepted only in apply mode.",
    );
  }
  if (
    options.reviewedStatusReceipt &&
    !new Set([
      "reconciliation-authorize",
      "reconciliation-ingestion-enable",
    ]).has(options.workflow)
  ) {
    throw new OperatorError(
      "E_ARGS",
      "--reviewed-status-receipt is invalid for this workflow.",
    );
  }
  if (
    !options.workflow.startsWith("reconciliation-") &&
    (options.expectedEvidenceDigest || options.expectedVerificationRunId)
  ) {
    throw new OperatorError(
      "E_ARGS",
      "Reconciliation evidence fences are invalid for this workflow.",
    );
  }
  if (options.restartKeys.size > 0 && options.mode !== "apply") {
    throw new OperatorError(
      "E_ARGS",
      "--restart-key is accepted only in apply mode.",
    );
  }
  const permittedRestartKeys = allowedRestartKeys(options.workflow);
  const invalidRestartKeys = [...options.restartKeys].filter(
    (key) => !permittedRestartKeys.has(key),
  );
  if (invalidRestartKeys.length > 0) {
    throw new OperatorError(
      "E_ARGS",
      `Restart keys do not belong to ${options.workflow}: ${invalidRestartKeys.sort().join(", ")}.`,
    );
  }
  return options;
}

async function validatePrivateRegularFile(path, label) {
  const info = await lstat(path).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink()) {
    throw new OperatorError(
      "E_FILE",
      `${label} must be an existing regular file, not a symlink.`,
    );
  }
  if ((info.mode & 0o077) !== 0) {
    throw new OperatorError(
      "E_FILE_MODE",
      `${label} must not be readable, writable, or executable by group/other.`,
    );
  }
  return info;
}

async function validateTarget(options) {
  await validatePrivateRegularFile(options.envFile, "Convex target env file");
  const envText = await readFile(options.envFile, "utf8");
  const values = parseEnvText(envText);
  const allowed = new Set([
    "CONVEX_SELF_HOSTED_URL",
    "CONVEX_SELF_HOSTED_ADMIN_KEY",
  ]);
  const unexpected = [...values.keys()].filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new OperatorError(
      "E_TARGET_AMBIGUOUS",
      `Target env file contains forbidden or unrelated variables: ${unexpected.sort().join(", ")}.`,
    );
  }
  const ambientForbidden = [
    "CONVEX_DEPLOYMENT",
    "CONVEX_DEPLOY_KEY",
    "CONVEX_PREVIEW_DEPLOY_KEY",
  ].filter((key) => process.env[key]?.trim());
  if (ambientForbidden.length > 0) {
    throw new OperatorError(
      "E_TARGET_AMBIGUOUS",
      `Ambient cloud/preview target variables are set: ${ambientForbidden.join(", ")}.`,
    );
  }
  const selfHostedUrl = values.get("CONVEX_SELF_HOSTED_URL")?.trim();
  const adminKey = values.get("CONVEX_SELF_HOSTED_ADMIN_KEY")?.trim();
  if (!selfHostedUrl || !adminKey) {
    throw new OperatorError(
      "E_TARGET",
      "Target env file must contain non-empty self-hosted URL and admin key values.",
    );
  }
  const actualUrl = normalizeUrl(selfHostedUrl, "CONVEX_SELF_HOSTED_URL");
  const expectedUrl = normalizeUrl(options.expectedUrl, "--expected-url");
  if (actualUrl !== expectedUrl) {
    throw new OperatorError(
      "E_TARGET_MISMATCH",
      "Self-hosted target does not match --expected-url.",
      { actualUrl, expectedUrl },
    );
  }
  return {
    actualUrl,
    adminKey,
    envFileDigestSha256: sha256(envText),
    originDigestSha256: sha256(actualUrl),
  };
}

async function validateReviewedStatusReceipt(options, target) {
  if (!options.reviewedStatusReceipt) return null;
  await validatePrivateRegularFile(
    options.reviewedStatusReceipt,
    "Reviewed status receipt",
  );
  if (
    dirname(resolve(options.reviewedStatusReceipt)) !==
    resolve(options.receiptDir)
  ) {
    throw new OperatorError(
      "E_STATUS_RECEIPT",
      "Reviewed status receipt must be inside the selected receipt directory.",
    );
  }
  const text = await readFile(options.reviewedStatusReceipt, "utf8");
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch {
    throw new OperatorError(
      "E_STATUS_RECEIPT",
      "Reviewed status receipt is not valid JSON.",
    );
  }
  const rows = receipt.statusSnapshot?.reconciliationRolloutState;
  const control =
    receipt.statusSnapshot?.reconciliationRolloutControl ?? null;
  const state = Array.isArray(rows)
    ? rows.filter(
        (row) =>
          row?.key === "source-occurrence-reconciliation-apply-v1",
      )
    : [];
  if (
    receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    receipt.mode !== "status" ||
    receipt.status !== "complete" ||
    receipt.target?.originDigestSha256 !== target.originDigestSha256 ||
    receipt.target?.envFileDigestSha256 !== target.envFileDigestSha256 ||
    control?.singletonStatus !== "present" ||
    control.prerequisitesSatisfied !== true ||
    control.receiptTopologyCoverageSatisfied !== true ||
    !control.topology ||
    control.topology.currentEpoch !== control.topology.verifiedEpoch ||
    state.length !== 1 ||
    state[0].updatedAt !== options.expectedStateUpdatedAt ||
    state[0].evidenceDigestSha256 !== options.expectedEvidenceDigest ||
    state[0].verificationRunId !== options.expectedVerificationRunId
  ) {
    throw new OperatorError(
      "E_STATUS_RECEIPT",
      "Reviewed status receipt does not match the exact target and reconciliation fences.",
    );
  }
  const snapshot = state[0];
  const clean =
    snapshot.policyVersion === EXPECTED_RECONCILIATION_POLICY_VERSION &&
    snapshot.expectedOccurrenceCount > 0 &&
    snapshot.comparedCount === snapshot.expectedOccurrenceCount &&
    snapshot.matchedCount === snapshot.expectedOccurrenceCount &&
    snapshot.mismatchCount === 0 &&
    snapshot.indeterminateCount === 0 &&
    snapshot.errorCount === 0 &&
    REQUIRED_RECONCILIATION_OPERATIONS.every((operation) =>
      snapshot.verifiedOperationKinds?.includes(operation),
    );
  const expectedPhase =
    options.workflow === "reconciliation-authorize"
      ? "ready_for_review"
      : "enabled";
  const expectedOperatorEnabled =
    options.workflow === "reconciliation-ingestion-enable";
  if (
    !clean ||
    snapshot.verificationKind !== "server_full_outcome_v1" ||
    control.verificationRunId !== snapshot.verificationRunId ||
    control.updatedAt !== snapshot.updatedAt ||
    control.topology.currentEpoch !== snapshot.verificationTopologyEpoch ||
    snapshot.verificationPhase !== expectedPhase ||
    Boolean(snapshot.operatorEnabled) !== expectedOperatorEnabled ||
    snapshot.ingestionApplyEnabled === true
  ) {
    throw new OperatorError(
      "E_STATUS_RECEIPT",
      "Reviewed status receipt is not at the required clean disabled frontier.",
    );
  }
  if (
    options.workflow === "reconciliation-ingestion-enable" &&
    control.applyReady !== true
  ) {
    throw new OperatorError(
      "E_STATUS_RECEIPT",
      "Reviewed status receipt does not prove generic reconciliation apply readiness.",
    );
  }
  return {
    digestSha256: sha256(text),
    fileName: basename(options.reviewedStatusReceipt),
  };
}

async function resolveConvexBinary(options) {
  const candidate = options.convexBin
    ? options.convexBin
    : resolve(process.cwd(), "node_modules/.bin/convex");
  const info = await stat(candidate).catch(() => null);
  if (!info?.isFile()) {
    throw new OperatorError(
      "E_CONVEX_BIN",
      `Convex CLI binary is unavailable: ${candidate}`,
    );
  }
  const resolvedPath = await realpath(candidate);
  const binaryBytes = await readFile(resolvedPath);
  return {
    path: candidate,
    digestSha256: sha256(binaryBytes),
  };
}

function sanitizedCopy(value, secrets) {
  if (typeof value === "string") {
    let output = value;
    for (const secret of secrets) {
      if (secret) output = output.split(secret).join("[REDACTED]");
    }
    output = output.replace(
      /(["']?(?:CONVEX_SELF_HOSTED_ADMIN_KEY|CONVEX_DEPLOY_KEY|CRON_SECRET)["']?\s*[:=]\s*)[^\s,"'}]+/giu,
      "$1[REDACTED]",
    );
    return output;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizedCopy(item, secrets));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /(?:secret|admin.?key|deploy.?key|token)/iu.test(key)
          ? "[REDACTED]"
          : sanitizedCopy(item, secrets),
      ]),
    );
  }
  return value;
}

function parseJsonOutput(text, label) {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new OperatorError("E_PROTOCOL", `${label} returned empty output.`);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const starts = [...trimmed.matchAll(/[\[{]/gu)].map((match) => match.index);
    for (let index = starts.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(trimmed.slice(starts[index]));
      } catch {
        // Continue looking for the final complete JSON document.
      }
    }
    throw new OperatorError(
      "E_PROTOCOL",
      `${label} did not return one parseable JSON document.`,
    );
  }
}

function appendBounded(buffer, chunk, label) {
  const next = Buffer.concat([buffer, chunk]);
  if (next.byteLength > MAX_COMMAND_OUTPUT_BYTES) {
    throw new OperatorError(
      "E_OUTPUT_BOUND",
      `${label} exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes.`,
    );
  }
  return next;
}

async function runProcess(binary, args, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(binary, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(result);
    };
    child.stdout.on("data", (chunk) => {
      try {
        stdout = appendBounded(stdout, Buffer.from(chunk), "Convex stdout");
      } catch (error) {
        child.kill("SIGTERM");
        finish(error);
      }
    });
    child.stderr.on("data", (chunk) => {
      try {
        stderr = appendBounded(stderr, Buffer.from(chunk), "Convex stderr");
      } catch (error) {
        child.kill("SIGTERM");
        finish(error);
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      finish(null, {
        code: code ?? -1,
        signal,
        stderr: stderr.toString("utf8"),
        stdout: stdout.toString("utf8"),
      });
    });
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(
        new OperatorError(
          "E_TIMEOUT",
          `Convex CLI call exceeded ${timeoutMs}ms.`,
        ),
      );
    }, timeoutMs);
  });
}

async function ensureReceiptDirectory(path) {
  const before = await lstat(path).catch(() => null);
  if (before && (!before.isDirectory() || before.isSymbolicLink())) {
    throw new OperatorError(
      "E_RECEIPT_DIR",
      "Receipt directory must be a real directory, not a symlink.",
    );
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0
  ) {
    throw new OperatorError(
      "E_RECEIPT_DIR",
      "Receipt directory must be private (mode 0700 or stricter).",
    );
  }
}

async function writeReceipt(context) {
  context.receipt.updatedAt = new Date().toISOString();
  const sanitized = sanitizedCopy(context.receipt, context.secrets);
  const tempPath = `${context.receiptPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(sanitized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(tempPath, 0o600);
    await rename(tempPath, context.receiptPath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

async function initializeReceipt(
  options,
  target,
  convexBinary,
  reviewedStatusReceipt,
) {
  await ensureReceiptDirectory(options.receiptDir);
  if (options.resume) {
    await validatePrivateRegularFile(options.resume, "Resume receipt");
    if (dirname(resolve(options.resume)) !== resolve(options.receiptDir)) {
      throw new OperatorError(
        "E_RESUME",
        "Resume receipt must be inside the selected receipt directory.",
      );
    }
    const previous = JSON.parse(await readFile(options.resume, "utf8"));
    const restartKeys = [...options.restartKeys].sort();
    const review = CUTOVER_CONFIRMATIONS[options.workflow]
      ? {
          expectedStateUpdatedAt: options.expectedStateUpdatedAt,
          expectedEvidenceDigest:
            options.expectedEvidenceDigest ?? null,
          expectedVerificationRunId:
            options.expectedVerificationRunId ?? null,
          reviewedStatusReceiptDigestSha256:
            reviewedStatusReceipt?.digestSha256 ?? null,
          noteDigestSha256: sha256(options.note),
          operator: options.operator,
        }
      : null;
    if (
      previous.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
      previous.operatorVersion !== OPERATOR_VERSION ||
      previous.mode !== options.mode ||
      previous.workflow !== options.workflow ||
      previous.target?.originDigestSha256 !== target.originDigestSha256 ||
      previous.target?.envFileDigestSha256 !== target.envFileDigestSha256 ||
      previous.target?.convexBinaryDigestSha256 !== convexBinary.digestSha256 ||
      previous.options?.maxPages !== options.maxPages ||
      previous.options?.timeoutMs !== options.timeoutMs ||
      JSON.stringify(previous.options?.restartKeys) !==
        JSON.stringify(restartKeys) ||
      JSON.stringify(previous.review ?? null) !== JSON.stringify(review) ||
      previous.status === "complete"
    ) {
      throw new OperatorError(
        "E_RESUME",
        "Resume receipt does not match this incomplete target/mode/workflow.",
      );
    }
    previous.resumeCount = (previous.resumeCount ?? 0) + 1;
    previous.status = "running";
    delete previous.completedAt;
    delete previous.failure;
    return {
      receipt: previous,
      receiptPath: resolve(options.resume),
    };
  }
  const runId = `${Date.now()}-${randomUUID()}`;
  const receiptPath = join(
    resolve(options.receiptDir),
    `event-domain-rollout-${runId}.json`,
  );
  return {
    receiptPath,
    receipt: {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      operatorVersion: OPERATOR_VERSION,
      runId,
      mode: options.mode,
      workflow: options.workflow,
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      resumeCount: 0,
      target: {
        selfHostedUrl: target.actualUrl,
        originDigestSha256: target.originDigestSha256,
        envFileDigestSha256: target.envFileDigestSha256,
        envFileName: basename(options.envFile),
        convexBinaryDigestSha256: convexBinary.digestSha256,
      },
      options: {
        maxPages: options.maxPages,
        restartKeys: [...options.restartKeys].sort(),
        timeoutMs: options.timeoutMs,
      },
      ...(CUTOVER_CONFIRMATIONS[options.workflow]
        ? {
            review: {
              expectedStateUpdatedAt: options.expectedStateUpdatedAt,
              expectedEvidenceDigest:
                options.expectedEvidenceDigest ?? null,
              expectedVerificationRunId:
                options.expectedVerificationRunId ?? null,
              reviewedStatusReceiptDigestSha256:
                reviewedStatusReceipt?.digestSha256 ?? null,
              noteDigestSha256: sha256(options.note),
              operator: options.operator,
            },
          }
        : {}),
      ...(reviewedStatusReceipt
        ? { reviewedStatusReceipt }
        : {}),
      commands: [],
      gates: [],
    },
  };
}

async function acquireLock(context) {
  if (context.options.mode !== "apply") return null;
  const lockPath = join(resolve(context.options.receiptDir), "event-domain-rollout.lock");
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new OperatorError(
        "E_LOCKED",
        `Another apply operator holds ${lockPath}.`,
      );
    }
    throw error;
  }
  await handle.writeFile(`${context.receipt.runId}\n`, "utf8");
  await handle.close();
  return lockPath;
}

async function recordCommand(context, operation, args, parseLabel) {
  const sequence = context.receipt.commands.length + 1;
  const startedAt = Date.now();
  const command = {
    sequence,
    operation,
    args: args.map((value, index) =>
      index > 0 && args[index - 1] === "--env-file"
        ? `[env-file:${basename(value)}]`
        : value,
    ),
    startedAt: new Date(startedAt).toISOString(),
    status: "running",
  };
  context.receipt.commands.push(command);
  await writeReceipt(context);
  let result;
  try {
    result = await runProcess(
      context.convexBinary.path,
      args,
      context.options.timeoutMs,
    );
  } catch (error) {
    command.status = "failed";
    command.error = {
      code: error.code ?? "E_PROCESS",
      message: error.message,
    };
    command.durationMs = Date.now() - startedAt;
    await writeReceipt(context);
    throw error;
  }
  command.durationMs = Date.now() - startedAt;
  command.exitCode = result.code;
  command.signal = result.signal;
  command.stderr = result.stderr.trim().slice(0, 16_000);
  if (result.code !== 0) {
    command.status = "failed";
    await writeReceipt(context);
    throw new OperatorError(
      "E_CONVEX_COMMAND",
      `${operation} failed with exit ${result.code}.`,
      { stderr: result.stderr.trim().slice(0, 2_000) },
    );
  }
  const emptyDataTable =
    args[0] === "data" &&
    result.stdout.trim() === "" &&
    result.stderr.trim() === "There are no documents in this table.";
  const parsed = emptyDataTable ? [] : parseJsonOutput(result.stdout, parseLabel);
  command.status = "complete";
  command.result = parsed;
  await writeReceipt(context);
  return parsed;
}

async function convexRun(context, functionName, args) {
  return recordCommand(
    context,
    `run:${functionName}`,
    [
      "run",
      "--env-file",
      context.options.envFile,
      "--typecheck",
      "disable",
      "--codegen",
      "disable",
      functionName,
      JSON.stringify(args),
    ],
    functionName,
  );
}

async function convexData(context, table) {
  const result = await recordCommand(
    context,
    `data:${table}`,
    [
      "data",
      "--env-file",
      context.options.envFile,
      table,
      "--limit",
      String(STATE_TABLE_LIMIT),
      "--order",
      "desc",
      "--format",
      "json",
    ],
    `data:${table}`,
  );
  if (!Array.isArray(result)) {
    throw new OperatorError(
      "E_PROTOCOL",
      `Convex data for ${table} was not a JSON array.`,
    );
  }
  if (result.length >= STATE_TABLE_LIMIT) {
    throw new OperatorError(
      "E_STATE_BOUND",
      `${table} reached the operator inspection bound.`,
    );
  }
  return result;
}

function uniqueState(rows, key, table) {
  const matching = rows.filter((row) => row?.key === key);
  if (matching.length > 1) {
    throw new OperatorError(
      "E_STATE_DUPLICATE",
      `${table} contains duplicate state for ${key}.`,
    );
  }
  return matching[0] ?? null;
}

function isCleanEventDomainState(state) {
  return Boolean(
    state?.isDone === true &&
      state.completedAt !== undefined &&
      state.mismatchCount === 0 &&
      (state.errorCount ?? 0) === 0,
  );
}

function assertZero(value, label) {
  if ((value ?? 0) !== 0) {
    throw new OperatorError("E_GATE", `${label} must be zero; got ${value}.`);
  }
}

function assertRequiredZero(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new OperatorError(
      "E_PROTOCOL",
      `${label} must be a finite numeric counter.`,
    );
  }
  assertZero(value, label);
}

function assertMigrationResult(result, step, options = {}) {
  if (!result || typeof result !== "object") {
    throw new OperatorError("E_PROTOCOL", `${step.key} returned no result.`);
  }
  if (step.kind === "venue_seed_audit") {
    assertRequiredZero(result.issueCount, `${step.key}.issueCount`);
    return;
  }
  if (step.kind === "campaign_page") {
    assertRequiredZero(
      result.quarantinedCount,
      `${step.key}.quarantinedCount`,
    );
    if (options.postApply) {
      assertRequiredZero(
        result.reattestedCount,
        `${step.key}.reattestedCount`,
      );
    }
    return;
  }
  assertRequiredZero(result.mismatchCount, `${step.key}.mismatchCount`);
  assertZero(result.errorCount, `${step.key}.errorCount`);
  assertZero(result.quarantinedLineageMarkerCount, `${step.key}.quarantinedLineageMarkerCount`);
  if (options.requireNoSkipped) {
    assertZero(result.skippedCount, `${step.key}.skippedCount`);
  }
  if (options.postApply) {
    assertRequiredZero(result.updatedCount, `${step.key}.updatedCount`);
  }
}

function addGate(context, gate) {
  context.receipt.gates.push({
    at: new Date().toISOString(),
    ...gate,
  });
}

async function runExplicitCursorPages(context, options) {
  let cursor = options.cursor ?? null;
  let pageCount = 0;
  const totals = {};
  while (true) {
    if (pageCount >= context.options.maxPages) {
      throw new OperatorError(
        "E_PAGE_BOUND",
        `${options.step.key} exceeded ${context.options.maxPages} pages.`,
      );
    }
    const args = {
      cursor,
      dryRun: options.dryRun,
      limit: options.step.limit,
      ...(options.restart && pageCount === 0 ? { restart: true } : {}),
    };
    const result = await convexRun(
      context,
      options.step.functionName,
      args,
    );
    assertMigrationResult(result, options.step, {
      postApply: options.postApply,
      requireNoSkipped:
        options.step.key === "event-venue-bindings-v1" ||
        options.step.key === "legacy-source-occurrence-admission-v1" ||
        options.step.key === "source-occurrences-generic-v2" ||
        options.step.key === "source-occurrence-canonical-payload-v1" ||
        options.step.key === "source-occurrence-receipt-topology-v1",
    });
    for (const field of [
      "scannedCount",
      "updatedCount",
      "mismatchCount",
      "errorCount",
      "skippedCount",
      "quarantinedLineageMarkerCount",
    ]) {
      totals[field] = (totals[field] ?? 0) + (result[field] ?? 0);
    }
    pageCount += 1;
    if (result.isDone === true) {
      return { pageCount, totals, result };
    }
    if (
      typeof result.continueCursor !== "string" ||
      !result.continueCursor ||
      result.continueCursor === cursor
    ) {
      throw new OperatorError(
        "E_CURSOR",
        `${options.step.key} pagination did not advance.`,
      );
    }
    cursor = result.continueCursor;
  }
}

async function runCampaignPages(context, options) {
  let cursor = options.cursor ?? null;
  let pageCount = 0;
  while (true) {
    if (pageCount >= context.options.maxPages) {
      throw new OperatorError(
        "E_PAGE_BOUND",
        `${options.step.key} exceeded ${context.options.maxPages} pages.`,
      );
    }
    const args = options.dryRun
      ? { cursor, dryRun: true, limit: options.step.limit }
      : {
          dryRun: false,
          limit: options.step.limit,
          ...(options.restart && pageCount === 0
            ? { restartCompleted: true }
            : {}),
        };
    const result = await convexRun(
      context,
      options.step.functionName,
      args,
    );
    assertMigrationResult(result, options.step, {
      postApply: options.postApply,
    });
    pageCount += 1;
    if (result.isDone === true) return { pageCount, result };
    if (options.dryRun) {
      if (
        typeof result.continueCursor !== "string" ||
        !result.continueCursor ||
        result.continueCursor === cursor
      ) {
        throw new OperatorError(
          "E_CURSOR",
          `${options.step.key} pagination did not advance.`,
        );
      }
      cursor = result.continueCursor;
    }
  }
}

async function previewEventDomainStep(context, step, postApply = false) {
  if (step.kind === "venue_seed_audit") {
    const result = await convexRun(context, step.functionName, { dryRun: true });
    assertMigrationResult(result, step, { postApply });
    return result;
  }
  if (step.kind === "campaign_page") {
    return runCampaignPages(context, {
      step,
      dryRun: true,
      postApply,
    });
  }
  return runExplicitCursorPages(context, {
    step,
    dryRun: true,
    postApply,
  });
}

async function applyEventDomainStep(context, step) {
  const rows = await convexData(context, "eventDomainMigrationState");
  const state = uniqueState(rows, step.key, "eventDomainMigrationState");
  const restart = context.options.restartKeys.has(step.key);
  if (isCleanEventDomainState(state) && !restart) {
    addGate(context, { key: step.key, status: "already_clean" });
    return;
  }
  if (state?.isDone && !restart) {
    throw new OperatorError(
      "E_RESTART_REQUIRED",
      `${step.key} is completed/blocked but not clean; repair evidence and pass --restart-key ${step.key}.`,
    );
  }
  await previewEventDomainStep(context, step, false);
  if (step.kind === "venue_seed_audit") {
    const result = await convexRun(context, step.functionName, {
      dryRun: false,
      ...(restart ? { restart: true } : {}),
    });
    assertMigrationResult(result, step);
  } else if (step.kind === "campaign_page") {
    await runCampaignPages(context, {
      step,
      dryRun: false,
      restart,
    });
  } else {
    await runExplicitCursorPages(context, {
      step,
      dryRun: false,
      cursor: restart ? null : (state?.cursor ?? null),
      restart,
    });
  }
  const afterRows = await convexData(context, "eventDomainMigrationState");
  const after = uniqueState(afterRows, step.key, "eventDomainMigrationState");
  if (!isCleanEventDomainState(after)) {
    throw new OperatorError(
      "E_GATE",
      `${step.key} did not finish with one clean durable state.`,
    );
  }
  await previewEventDomainStep(context, step, true);
  addGate(context, {
    key: step.key,
    status: "clean",
    stateUpdatedAt: after.updatedAt,
  });
}

function selectedEventDomainSteps(workflow) {
  if (workflow === "all") return EVENT_DOMAIN_STEPS;
  return EVENT_DOMAIN_STEPS.filter((step) => step.workflow === workflow);
}

async function runEventDomainWorkflow(context) {
  const steps = selectedEventDomainSteps(context.options.workflow);
  for (const step of steps) {
    if (context.options.mode === "preview") {
      await previewEventDomainStep(context, step, false);
      addGate(context, { key: step.key, status: "preview_clean" });
    } else {
      await applyEventDomainStep(context, step);
    }
  }
}

function assertSavedBackfillResult(result, postApply = false) {
  for (const field of [
    "conflictCount",
    "missingUserCount",
    "timestampMismatchCount",
  ]) {
    assertRequiredZero(result[field], `saved-events.${field}`);
  }
  assertRequiredZero(
    result.cumulative?.mismatchCount,
    "saved-events.cumulative.mismatchCount",
  );
  if (postApply) {
    assertRequiredZero(result.wouldInsert, "saved-events.wouldInsert");
  }
}

async function previewSavedEvents(context, postApply = false) {
  let cursor = null;
  for (let page = 0; page < context.options.maxPages; page += 1) {
    const result = await convexRun(
      context,
      "internal/migrations/savedEvents:backfillLegacySavedEventsBatch",
      { cursor, dryRun: true, limit: 100 },
    );
    assertSavedBackfillResult(result, postApply);
    if (result.isDone === true) return;
    if (!result.continueCursor || result.continueCursor === cursor) {
      throw new OperatorError("E_CURSOR", "Saved-event preview did not advance.");
    }
    cursor = result.continueCursor;
  }
  throw new OperatorError("E_PAGE_BOUND", "Saved-event preview exceeded its page bound.");
}

function savedStateEquivalent(state) {
  if (!state) return false;
  const classified =
    state.alreadyCanonicalCount +
    state.insertedCount +
    state.duplicateLegacyRowCount +
    state.missingUserCount +
    state.conflictCount +
    state.timestampMismatchCount;
  return Boolean(
    state.isDone &&
      state.completedAt !== undefined &&
      state.canonicalAuditDone === true &&
      state.canonicalScannedCount ===
        (state.canonicalUniqueRowCount ?? 0) +
          (state.canonicalDuplicateRowCount ?? 0) &&
      state.canonicalDuplicateRowCount === 0 &&
      state.scannedCount === classified &&
      state.mismatchCount === 0 &&
      state.missingUserCount === 0 &&
      state.conflictCount === 0 &&
      state.timestampMismatchCount === 0
  );
}

async function applySavedEvents(context) {
  let rows = await convexData(context, "savedEventMigrationState");
  let state = uniqueState(
    rows,
    "saved-events-legacy-to-canonical-v1",
    "savedEventMigrationState",
  );
  if (state?.readCutoverEnabled || state?.cutoverEnabled) {
    if (!savedStateEquivalent(state)) {
      throw new OperatorError("E_GATE", "Enabled saved-event state is not equivalent.");
    }
    addGate(context, {
      key: "saved-events-legacy-to-canonical-v1",
      status: "already_cut_over",
      stateUpdatedAt: state.updatedAt,
    });
    return;
  }
  const restart = context.options.restartKeys.has(
    "saved-events-legacy-to-canonical-v1",
  );
  if (state?.isDone && !savedStateEquivalent(state) && !restart) {
    throw new OperatorError(
      "E_RESTART_REQUIRED",
      "Saved-event migration is blocked; repair evidence and pass --restart-key saved-events-legacy-to-canonical-v1.",
    );
  }
  await previewSavedEvents(context, false);
  if (!state?.isDone || restart) {
    for (let page = 0; page < context.options.maxPages; page += 1) {
      const result = await convexRun(
        context,
        "internal/migrations/savedEvents:backfillLegacySavedEventsBatch",
        {
          dryRun: false,
          limit: 100,
          ...(restart && page === 0 ? { restartCompleted: true } : {}),
        },
      );
      assertSavedBackfillResult(result, false);
      if (result.isDone === true) break;
      if (page === context.options.maxPages - 1) {
        throw new OperatorError("E_PAGE_BOUND", "Saved-event apply exceeded its page bound.");
      }
    }
  }
  rows = await convexData(context, "savedEventMigrationState");
  state = uniqueState(
    rows,
    "saved-events-legacy-to-canonical-v1",
    "savedEventMigrationState",
  );
  if (!state?.isDone || state.mismatchCount !== 0) {
    throw new OperatorError("E_GATE", "Saved-event backfill is not cleanly complete.");
  }
  if (!state.canonicalAuditDone || restart) {
    for (let page = 0; page < context.options.maxPages; page += 1) {
      const result = await convexRun(
        context,
        "internal/migrations/savedEvents:auditCanonicalSavedEventsBatch",
        {
          limit: 100,
          ...(restart && page === 0 && state.canonicalAuditDone
            ? { restartCompleted: true }
            : {}),
        },
      );
      assertRequiredZero(
        result.canonicalDuplicateRowCount,
        "saved-events.canonicalDuplicateRowCount",
      );
      if (result.isDone === true) break;
      if (page === context.options.maxPages - 1) {
        throw new OperatorError("E_PAGE_BOUND", "Saved-event audit exceeded its page bound.");
      }
    }
  }
  rows = await convexData(context, "savedEventMigrationState");
  state = uniqueState(
    rows,
    "saved-events-legacy-to-canonical-v1",
    "savedEventMigrationState",
  );
  if (!savedStateEquivalent(state) || state.phase !== "ready_for_review") {
    throw new OperatorError("E_GATE", "Saved-event migration is not ready for review.");
  }
  await previewSavedEvents(context, true);
  addGate(context, {
    key: "saved-events-legacy-to-canonical-v1",
    status: "ready_for_review",
    stateUpdatedAt: state.updatedAt,
  });
}

function publicationStateEquivalent(state) {
  return Boolean(
    state &&
      state.policyVersion === EXPECTED_PUBLICATION_POLICY_VERSION &&
      state.backfillDone &&
      state.mismatchCount === 0 &&
      state.auditDone &&
      state.auditScannedCount >= state.scannedCount &&
      state.auditDriftCount === 0 &&
      state.completedAt !== undefined,
  );
}

async function previewPublication(context, postApply = false) {
  let cursor = null;
  for (let page = 0; page < context.options.maxPages; page += 1) {
    const result = await convexRun(
      context,
      "internal/migrations/publication:backfillMaterializedPublicationBatch",
      { cursor, dryRun: true, limit: 64 },
    );
    assertRequiredZero(result.mismatchCount, "publication.mismatchCount");
    if (postApply) {
      assertRequiredZero(result.updatedCount, "publication.updatedCount");
    }
    if (result.isDone === true) return;
    if (!result.continueCursor || result.continueCursor === cursor) {
      throw new OperatorError("E_CURSOR", "Publication preview did not advance.");
    }
    cursor = result.continueCursor;
  }
  throw new OperatorError("E_PAGE_BOUND", "Publication preview exceeded its page bound.");
}

async function applyPublication(context) {
  let rows = await convexData(context, "publicationMigrationState");
  let state = uniqueState(
    rows,
    "materialized-publication-v1",
    "publicationMigrationState",
  );
  if (state?.readCutoverEnabled) {
    if (!publicationStateEquivalent(state)) {
      throw new OperatorError("E_GATE", "Enabled publication state is not equivalent.");
    }
    addGate(context, {
      key: "materialized-publication-v1",
      status: "already_cut_over",
      stateUpdatedAt: state.updatedAt,
    });
    return;
  }
  const restart = context.options.restartKeys.has("materialized-publication-v1");
  if (state?.backfillDone && !publicationStateEquivalent(state) && !restart) {
    throw new OperatorError(
      "E_RESTART_REQUIRED",
      "Publication migration is blocked; repair evidence and pass --restart-key materialized-publication-v1.",
    );
  }
  await previewPublication(context, false);
  if (!state?.backfillDone || restart) {
    for (let page = 0; page < context.options.maxPages; page += 1) {
      const result = await convexRun(
        context,
        "internal/migrations/publication:backfillMaterializedPublicationBatch",
        {
          dryRun: false,
          limit: 64,
          ...(restart && page === 0 ? { restartCompleted: true } : {}),
        },
      );
      assertRequiredZero(result.mismatchCount, "publication.mismatchCount");
      if (result.isDone === true) break;
      if (page === context.options.maxPages - 1) {
        throw new OperatorError("E_PAGE_BOUND", "Publication apply exceeded its page bound.");
      }
    }
  }
  rows = await convexData(context, "publicationMigrationState");
  state = uniqueState(
    rows,
    "materialized-publication-v1",
    "publicationMigrationState",
  );
  if (!state?.backfillDone || state.mismatchCount !== 0) {
    throw new OperatorError("E_GATE", "Publication backfill is not cleanly complete.");
  }
  if (!state.auditDone || restart) {
    for (let page = 0; page < context.options.maxPages; page += 1) {
      const result = await convexRun(
        context,
        "internal/migrations/publication:auditMaterializedPublicationBatch",
        {
          limit: 64,
          ...(restart && page === 0 && state.auditDone
            ? { restartCompleted: true }
            : {}),
        },
      );
      assertRequiredZero(
        result.auditDriftCount,
        "publication.auditDriftCount",
      );
      if (result.isDone === true) break;
      if (page === context.options.maxPages - 1) {
        throw new OperatorError("E_PAGE_BOUND", "Publication audit exceeded its page bound.");
      }
    }
  }
  rows = await convexData(context, "publicationMigrationState");
  state = uniqueState(
    rows,
    "materialized-publication-v1",
    "publicationMigrationState",
  );
  if (!publicationStateEquivalent(state) || state.phase !== "ready_for_review") {
    throw new OperatorError("E_GATE", "Publication migration is not ready for review.");
  }
  await previewPublication(context, true);
  addGate(context, {
    key: "materialized-publication-v1",
    status: "ready_for_review",
    stateUpdatedAt: state.updatedAt,
  });
}

function assertReconciliationResult(result) {
  assertRequiredZero(result.mismatchCount, "reconciliation.mismatchCount");
  assertRequiredZero(
    result.indeterminateCount,
    "reconciliation.indeterminateCount",
  );
  assertRequiredZero(result.errorCount, "reconciliation.errorCount");
  if (result.isDone === true) {
    if (
      result.phase !== "ready_for_review" ||
      result.expectedOccurrenceCount <= 0 ||
      result.comparedCount !== result.expectedOccurrenceCount ||
      result.matchedCount !== result.expectedOccurrenceCount
    ) {
      throw new OperatorError(
        "E_GATE",
        "Reconciliation verification did not finish with complete matched coverage.",
      );
    }
    const kinds = new Set(result.verifiedOperationKinds ?? []);
    const missing = REQUIRED_RECONCILIATION_OPERATIONS.filter(
      (operation) => !kinds.has(operation),
    );
    if (missing.length > 0) {
      throw new OperatorError(
        "E_GATE",
        `Reconciliation verification lacks required operations: ${missing.join(", ")}.`,
      );
    }
  }
}

async function inspectReconciliation(context) {
  const rows = await convexData(context, "reconciliationRolloutState");
  const state = uniqueState(
    rows,
    "source-occurrence-reconciliation-apply-v1",
    "reconciliationRolloutState",
  );
  if (state?.operatorEnabled) {
    throw new OperatorError(
      "E_RECONCILIATION_ENABLED",
      "Reconciliation apply is already enabled; this driver refuses to overwrite or re-authorize it.",
    );
  }
  if (
    state &&
    state.policyVersion !== EXPECTED_RECONCILIATION_POLICY_VERSION
  ) {
    throw new OperatorError(
      "E_STATE_VERSION",
      `Reconciliation policy version is ${state.policyVersion}; expected ${EXPECTED_RECONCILIATION_POLICY_VERSION}.`,
    );
  }
  return state;
}

async function applyReconciliationVerification(context) {
  let state = await inspectReconciliation(context);
  if (state?.verificationPhase === "ready_for_review") {
    assertReconciliationResult({ ...state, isDone: true, phase: state.verificationPhase });
    addGate(context, {
      key: "source-occurrence-reconciliation-apply-v1",
      status: "ready_for_human_review_not_authorized",
      stateUpdatedAt: state.updatedAt,
      evidenceDigestSha256: state.evidenceDigestSha256,
      verificationRunId: state.verificationRunId,
    });
    return;
  }
  const restart = context.options.restartKeys.has(
    "source-occurrence-reconciliation-apply-v1",
  );
  if (state && state.verificationPhase !== "scanning" && !restart) {
    throw new OperatorError(
      "E_RESTART_REQUIRED",
      "Reconciliation verification is completed/blocked; repair evidence and pass --restart-key source-occurrence-reconciliation-apply-v1.",
    );
  }
  for (let page = 0; page < context.options.maxPages; page += 1) {
    const result = await convexRun(
      context,
      "reconciliation:verifyReconciliationRolloutBatch",
      {
        limit: 32,
        ...(restart && page === 0 ? { restartCompleted: true } : {}),
      },
    );
    assertReconciliationResult(result);
    if (result.isDone === true) break;
    if (page === context.options.maxPages - 1) {
      throw new OperatorError(
        "E_PAGE_BOUND",
        "Reconciliation verification exceeded its page bound.",
      );
    }
  }
  state = await inspectReconciliation(context);
  if (
    !state ||
    state.verificationPhase !== "ready_for_review" ||
    state.operatorEnabled
  ) {
    throw new OperatorError(
      "E_GATE",
      "Reconciliation verification is not ready for separate human review.",
    );
  }
  assertReconciliationResult({ ...state, isDone: true, phase: state.verificationPhase });
  addGate(context, {
    key: "source-occurrence-reconciliation-apply-v1",
    status: "ready_for_human_review_not_authorized",
    stateUpdatedAt: state.updatedAt,
    evidenceDigestSha256: state.evidenceDigestSha256,
    verificationRunId: state.verificationRunId,
  });
}

async function readCutoverState(context, workflow) {
  if (workflow.startsWith("saved-")) {
    const state = uniqueState(
      await convexData(context, "savedEventMigrationState"),
      "saved-events-legacy-to-canonical-v1",
      "savedEventMigrationState",
    );
    if (!state) throw new OperatorError("E_GATE", "Saved-event migration state is missing.");
    return state;
  }
  if (workflow.startsWith("reconciliation-")) {
    const state = uniqueState(
      await convexData(context, "reconciliationRolloutState"),
      "source-occurrence-reconciliation-apply-v1",
      "reconciliationRolloutState",
    );
    if (!state) {
      throw new OperatorError(
        "E_GATE",
        "Reconciliation rollout state is missing.",
      );
    }
    if (state.policyVersion !== EXPECTED_RECONCILIATION_POLICY_VERSION) {
      throw new OperatorError(
        "E_STATE_VERSION",
        `Reconciliation policy version is ${state.policyVersion}; expected ${EXPECTED_RECONCILIATION_POLICY_VERSION}.`,
      );
    }
    return state;
  }
  const state = uniqueState(
    await convexData(context, "publicationMigrationState"),
    "materialized-publication-v1",
    "publicationMigrationState",
  );
  if (!state) throw new OperatorError("E_GATE", "Publication migration state is missing.");
  return state;
}

function assertExpectedStateVersion(context, state) {
  if (state.updatedAt !== context.options.expectedStateUpdatedAt) {
    throw new OperatorError(
      "E_STATE_VERSION",
      `State updatedAt is ${state.updatedAt}; expected ${context.options.expectedStateUpdatedAt}.`,
    );
  }
}

function assertCutoverPrecondition(workflow, state) {
  if (workflow === "saved-read-cutover") {
    if (!savedStateEquivalent(state) || state.phase !== "ready_for_review") {
      throw new OperatorError(
        "E_GATE",
        "Saved-event reads are not ready for cutover.",
      );
    }
    return;
  }
  if (workflow === "saved-write-cutover") {
    if (
      !savedStateEquivalent(state) ||
      state.phase !== "cutover_enabled" ||
      !(state.readCutoverEnabled ?? state.cutoverEnabled) ||
      state.writeCutoverEnabled === true
    ) {
      throw new OperatorError(
        "E_GATE",
        "Saved-event writes are not ready for cutover.",
      );
    }
    return;
  }
  if (workflow === "saved-cutover-rollback") {
    if (
      !state.cutoverEnabled &&
      !state.readCutoverEnabled &&
      !state.writeCutoverEnabled
    ) {
      throw new OperatorError(
        "E_GATE",
        "Saved-event cutover is already fully disabled.",
      );
    }
    return;
  }
  if (workflow === "publication-read-cutover") {
    if (!publicationStateEquivalent(state) || state.phase !== "ready_for_review") {
      throw new OperatorError(
        "E_GATE",
        "Publication reads are not ready for cutover.",
      );
    }
    return;
  }
  if (workflow === "publication-cutover-rollback") {
    if (!state.readCutoverEnabled) {
      throw new OperatorError(
        "E_GATE",
        "Publication read cutover is already disabled.",
      );
    }
    return;
  }
  if (workflow === "reconciliation-disable") {
    if (
      state.verificationKind !== "server_full_outcome_v1" ||
      state.verificationPhase !== "enabled" ||
      !state.operatorEnabled
    ) {
      throw new OperatorError(
        "E_GATE",
        "Only an enabled server-verified reconciliation rollout can be disabled.",
      );
    }
    return;
  }
  if (workflow === "reconciliation-authorize") {
    assertReconciliationResult({
      ...state,
      isDone: true,
      phase: "ready_for_review",
    });
    if (
      state.verificationKind !== "server_full_outcome_v1" ||
      state.verificationPhase !== "ready_for_review" ||
      state.operatorEnabled ||
      state.ingestionApplyEnabled === true ||
      state.completedAt === undefined
    ) {
      throw new OperatorError(
        "E_GATE",
        "Reconciliation verification is not ready for explicit authorization.",
      );
    }
    return;
  }
  if (workflow === "reconciliation-ingestion-enable") {
    assertReconciliationResult({
      ...state,
      isDone: true,
      phase: "ready_for_review",
    });
    if (
      state.verificationKind !== "server_full_outcome_v1" ||
      state.verificationPhase !== "enabled" ||
      !state.operatorEnabled ||
      state.ingestionApplyEnabled === true ||
      state.reviewedAt === undefined ||
      state.completedAt === undefined
    ) {
      throw new OperatorError(
        "E_GATE",
        "Reconciliation generic apply must be enabled before ingestion apply.",
      );
    }
    return;
  }
  if (workflow === "reconciliation-abandon") {
    if (
      state.verificationKind !== "server_full_outcome_v1" ||
      state.verificationPhase !== "scanning" ||
      state.operatorEnabled
    ) {
      throw new OperatorError(
        "E_GATE",
        "Only a disabled in-progress reconciliation verification can be abandoned.",
      );
    }
    return;
  }
  throw new OperatorError(
    "E_ARGS",
    `Unsupported cutover workflow: ${workflow}`,
  );
}

function assertCutoverApplied(context, before, result, after) {
  const workflow = context.options.workflow;
  if (
    typeof result.updatedAt !== "number" ||
    result.updatedAt <= before.updatedAt ||
    after.updatedAt !== result.updatedAt
  ) {
    throw new OperatorError(
      "E_STATE_VERSION",
      `${workflow} did not commit exactly one observable advanced state version.`,
    );
  }
  if (
    after.reviewedBy !== context.options.operator ||
    (workflow.startsWith("reconciliation-")
      ? after.note
      : after.reviewNote) !== context.options.note
  ) {
    throw new OperatorError(
      "E_GATE",
      `${workflow} did not persist the exact named review evidence.`,
    );
  }
  if (workflow.startsWith("saved-")) {
    if (
      after.cutoverGeneration !== (before.cutoverGeneration ?? 0) + 1
    ) {
      throw new OperatorError(
        "E_STATE_VERSION",
        `${workflow} did not advance the saved-event cutover generation exactly once.`,
      );
    }
    const readEnabled = Boolean(
      after.cutoverEnabled &&
        (after.readCutoverEnabled ?? after.cutoverEnabled),
    );
    if (workflow === "saved-read-cutover") {
      if (
        !readEnabled ||
        after.writeCutoverEnabled === true ||
        after.phase !== "cutover_enabled" ||
        !savedStateEquivalent(after)
      ) {
        throw new OperatorError(
          "E_GATE",
          "Saved-event read cutover did not persist its exact enabled state.",
        );
      }
    } else if (workflow === "saved-write-cutover") {
      if (
        !readEnabled ||
        after.writeCutoverEnabled !== true ||
        after.phase !== "cutover_enabled" ||
        !savedStateEquivalent(after)
      ) {
        throw new OperatorError(
          "E_GATE",
          "Saved-event write cutover did not persist its exact enabled state.",
        );
      }
    } else if (
      after.cutoverEnabled ||
      after.readCutoverEnabled ||
      after.writeCutoverEnabled
    ) {
      throw new OperatorError(
        "E_GATE",
        "Saved-event rollback did not disable every cutover bit.",
      );
    }
    return;
  }
  if (workflow.startsWith("reconciliation-")) {
    if (
      after.evidenceDigestSha256 !== before.evidenceDigestSha256 ||
      after.verificationRunId !== before.verificationRunId
    ) {
      throw new OperatorError(
        "E_GATE",
        `${workflow} changed the reviewed reconciliation evidence identity.`,
      );
    }
    if (workflow === "reconciliation-authorize") {
      if (
        !after.operatorEnabled ||
        after.ingestionApplyEnabled === true ||
        after.verificationPhase !== "enabled" ||
        result.operatorEnabled !== true
      ) {
        throw new OperatorError(
          "E_GATE",
          "Reconciliation authorization did not preserve the separate ingestion gate.",
        );
      }
    } else if (workflow === "reconciliation-ingestion-enable") {
      if (
        !after.operatorEnabled ||
        after.ingestionApplyEnabled !== true ||
        after.verificationPhase !== "enabled" ||
        result.operatorEnabled !== true ||
        result.ingestionApplyEnabled !== true
      ) {
        throw new OperatorError(
          "E_GATE",
          "Reconciliation ingestion cutover did not enable both exact gates.",
        );
      }
    } else if (
      after.operatorEnabled ||
      after.ingestionApplyEnabled ||
      after.verificationPhase !== "blocked" ||
      after.verificationCursor !== undefined ||
      result.operatorEnabled !== false ||
      result.verificationPhase !== "blocked"
    ) {
      throw new OperatorError(
        "E_GATE",
        `${workflow} did not persist the exact disabled reconciliation state.`,
      );
    }
    return;
  }
  if (workflow === "publication-read-cutover") {
    if (
      !after.readCutoverEnabled ||
      after.phase !== "cutover_enabled" ||
      !publicationStateEquivalent(after)
    ) {
      throw new OperatorError(
        "E_GATE",
        "Publication read cutover did not persist its exact enabled state.",
      );
    }
  } else if (after.readCutoverEnabled) {
    throw new OperatorError(
      "E_GATE",
      "Publication rollback did not disable materialized reads.",
    );
  }
}

async function runCutoverWorkflow(context) {
  const workflow = context.options.workflow;
  const state = await readCutoverState(context, workflow);
  assertCutoverPrecondition(workflow, state);
  if (context.options.mode === "preview") {
    addGate(context, {
      key: workflow,
      status: "preview_ready",
      stateUpdatedAt: state.updatedAt,
    });
    return;
  }
  assertExpectedStateVersion(context, state);
  if (workflow.startsWith("reconciliation-")) {
    if (
      state.evidenceDigestSha256 !== context.options.expectedEvidenceDigest ||
      state.verificationRunId !== context.options.expectedVerificationRunId
    ) {
      throw new OperatorError(
        "E_STATE_VERSION",
        "Reconciliation evidence digest or verification run changed before rollback.",
      );
    }
  }
  let functionName;
  let args;
  if (workflow === "saved-read-cutover") {
    if (!savedStateEquivalent(state) || state.phase !== "ready_for_review") {
      throw new OperatorError("E_GATE", "Saved-event reads are not ready for cutover.");
    }
    functionName =
      "internal/migrations/savedEvents:reviewSavedEventReadCutover";
    args = {
      enable: true,
      expectedStateUpdatedAt: state.updatedAt,
      note: context.options.note,
      reviewedBy: context.options.operator,
    };
  } else if (workflow === "saved-write-cutover") {
    if (
      !savedStateEquivalent(state) ||
      state.phase !== "cutover_enabled" ||
      !(state.readCutoverEnabled ?? state.cutoverEnabled)
    ) {
      throw new OperatorError("E_GATE", "Saved-event writes are not ready for cutover.");
    }
    functionName =
      "internal/migrations/savedEvents:reviewSavedEventWriteCutover";
    args = {
      enable: true,
      expectedStateUpdatedAt: state.updatedAt,
      note: context.options.note,
      reviewedBy: context.options.operator,
    };
  } else if (workflow === "saved-cutover-rollback") {
    functionName = "internal/migrations/savedEvents:rollbackSavedEventCutover";
    args = {
      expectedStateUpdatedAt: state.updatedAt,
      note: context.options.note,
      reviewedBy: context.options.operator,
    };
  } else if (workflow === "publication-read-cutover") {
    if (!publicationStateEquivalent(state) || state.phase !== "ready_for_review") {
      throw new OperatorError("E_GATE", "Publication reads are not ready for cutover.");
    }
    functionName =
      "internal/migrations/publication:reviewMaterializedPublicationReadCutover";
    args = {
      enable: true,
      expectedStateUpdatedAt: state.updatedAt,
      note: context.options.note,
      reviewedBy: context.options.operator,
    };
  } else if (workflow === "publication-cutover-rollback") {
    functionName =
      "internal/migrations/publication:reviewMaterializedPublicationReadCutover";
    args = {
      enable: false,
      expectedStateUpdatedAt: state.updatedAt,
      note: context.options.note,
      reviewedBy: context.options.operator,
    };
  } else if (workflow === "reconciliation-authorize") {
    functionName =
      "internal/reconciliationRollout:authorizeServerVerifiedReconciliationRollout";
    args = {
      expectedEvidenceDigestSha256: context.options.expectedEvidenceDigest,
      expectedUpdatedAt: state.updatedAt,
      expectedVerificationRunId: context.options.expectedVerificationRunId,
      note: context.options.note,
      reviewedBy: context.options.operator,
    };
  } else if (workflow === "reconciliation-ingestion-enable") {
    functionName =
      "internal/reconciliationRollout:enableServerVerifiedReconciliationIngestionApply";
    args = {
      enabledBy: context.options.operator,
      expectedEvidenceDigestSha256: context.options.expectedEvidenceDigest,
      expectedUpdatedAt: state.updatedAt,
      expectedVerificationRunId: context.options.expectedVerificationRunId,
      note: context.options.note,
    };
  } else if (workflow === "reconciliation-disable") {
    functionName =
      "internal/reconciliationRollout:disableServerVerifiedReconciliationRollout";
    args = {
      disabledBy: context.options.operator,
      expectedEvidenceDigestSha256: context.options.expectedEvidenceDigest,
      expectedUpdatedAt: state.updatedAt,
      expectedVerificationRunId: context.options.expectedVerificationRunId,
      note: context.options.note,
    };
  } else if (workflow === "reconciliation-abandon") {
    functionName =
      "internal/reconciliationRollout:abandonReconciliationRolloutVerification";
    args = {
      abandonedBy: context.options.operator,
      expectedEvidenceDigestSha256: context.options.expectedEvidenceDigest,
      expectedUpdatedAt: state.updatedAt,
      expectedVerificationRunId: context.options.expectedVerificationRunId,
      note: context.options.note,
    };
  } else {
    throw new OperatorError("E_ARGS", `Unsupported cutover workflow: ${workflow}`);
  }
  const result = await convexRun(context, functionName, args);
  const after = await readCutoverState(context, workflow);
  assertCutoverApplied(context, state, result, after);
  addGate(context, {
    key: workflow,
    status: "applied",
    previousStateUpdatedAt: state.updatedAt,
    stateUpdatedAt: after.updatedAt,
  });
}

async function collectStatus(context) {
  const tables = [
    "eventDomainMigrationState",
    "sourceOccurrenceTopologyEpoch",
    "savedEventMigrationState",
    "publicationMigrationState",
    "reconciliationRolloutState",
  ];
  const status = {};
  for (const table of tables) status[table] = await convexData(context, table);
  status.reconciliationRolloutControl = await convexRun(
    context,
    "internal/reconciliationRollout:getReconciliationRolloutStatus",
    {},
  );
  context.receipt.statusSnapshot = status;
  addGate(context, { key: "status", status: "captured" });
}

async function runSelectedWorkflow(context) {
  if (context.options.mode === "status") {
    await collectStatus(context);
    return;
  }
  if (CUTOVER_CONFIRMATIONS[context.options.workflow]) {
    await runCutoverWorkflow(context);
    return;
  }
  const runAll = context.options.workflow === "all";
  if (
    runAll ||
    new Set(["canonical", "venues", "occurrences"]).has(
      context.options.workflow,
    )
  ) {
    await runEventDomainWorkflow(context);
  }
  if (runAll || context.options.workflow === "saved-events") {
    if (context.options.mode === "preview") {
      await previewSavedEvents(context, false);
      addGate(context, { key: "saved-events", status: "preview_clean" });
    } else {
      await applySavedEvents(context);
    }
  }
  if (runAll || context.options.workflow === "publication") {
    if (context.options.mode === "preview") {
      await previewPublication(context, false);
      addGate(context, { key: "publication", status: "preview_clean" });
    } else {
      await applyPublication(context);
    }
  }
  if (runAll || context.options.workflow === "reconciliation") {
    if (context.options.mode === "preview") {
      const state = await inspectReconciliation(context);
      addGate(context, {
        key: "source-occurrence-reconciliation-apply-v1",
        status: state?.verificationPhase ?? "not_started",
        stateUpdatedAt: state?.updatedAt ?? null,
      });
    } else {
      await applyReconciliationVerification(context);
    }
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(HELP);
      return;
    }
    const target = await validateTarget(options);
    const reviewedStatusReceipt = await validateReviewedStatusReceipt(
      options,
      target,
    );
    const convexBinary = await resolveConvexBinary(options);
    const initialized = await initializeReceipt(
      options,
      target,
      convexBinary,
      reviewedStatusReceipt,
    );
    const context = {
      options,
      target,
      convexBinary,
      receipt: initialized.receipt,
      receiptPath: initialized.receiptPath,
      secrets: [target.adminKey],
    };
    await writeReceipt(context);
    let lockPath = null;
    try {
      lockPath = await acquireLock(context);
      await runSelectedWorkflow(context);
      context.receipt.status = "complete";
      context.receipt.completedAt = new Date().toISOString();
      await writeReceipt(context);
      process.stdout.write(
        `${JSON.stringify({
          status: "complete",
          mode: options.mode,
          workflow: options.workflow,
          receiptPath: context.receiptPath,
          targetOriginSha256: target.originDigestSha256,
        })}\n`,
      );
    } catch (error) {
      context.receipt.status = "failed";
      context.receipt.failure = {
        code: error.code ?? "E_OPERATOR",
        message: error.message,
        details: error.details,
      };
      await writeReceipt(context).catch(() => {});
      throw error;
    } finally {
      if (lockPath) await rm(lockPath, { force: true });
    }
  } catch (error) {
    const payload = {
      status: "failed",
      code: error.code ?? "E_OPERATOR",
      message: error.message,
    };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = 1;
  }
}

await main();
