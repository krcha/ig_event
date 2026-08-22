import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ConvexHttpClient } from "convex/browser";

import { parseExtractedEventData } from "../lib/ai/extract-event-data.ts";
import {
  bindSourceOccurrenceMetadata,
  prepareEventsForInsert,
} from "../lib/pipeline/run-instagram-ingestion.ts";
import { loadVenueNameOverridesByHandle } from "../lib/pipeline/venue-name-overrides.ts";
import { normalizeHandle } from "../lib/pipeline/venue-normalization.ts";

const TARGET_CREATED_AT_FROM = Date.parse("2026-08-22T07:00:00.000Z");
const TARGET_CREATED_AT_BEFORE = Date.parse("2026-08-22T08:00:00.000Z");
const TARGET_EVENT_COUNT = 29;
const TARGET_REPLAY_NOW = new Date("2026-08-22T10:00:00.000Z");
const BACKUP_ROOT = "/root/backups/ig-event-moderation-policy-20260822";
const POLICY_REASON = "event_evidence_v2_relaxed_conflict_policy_v1";
const PLANNED_SOURCE_ROLE_OVERRIDES = Object.freeze({
  longplayofficial: "promoter",
});

const listByStatusPaginatedQuery = "events:listByStatusPaginated";
const getManyByIdsQuery = "events:getManyByIds";
const getIngestionContextsQuery = "instagramSources:getIngestionContextsByHandles";
const getOccurrenceReceiptQuery = "events:getInstagramSourceOccurrenceReceipt";
const applyPolicyMutation = "events:reprocessPendingEventEvidencePolicyBatch";
const rollbackPolicyMutation = "events:rollbackEventEvidencePolicyBatch";

function parseArgs(argv) {
  const options = {
    apply: false,
    rollbackManifest: null,
    expectedEligibleCount: null,
    expectedManifestSha256: null,
    expectedTargetCount: null,
    backupRoot: BACKUP_ROOT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--rollback-manifest") {
      options.rollbackManifest = argv[++index] ?? null;
      continue;
    }
    if (arg === "--expect-target-count") {
      options.expectedTargetCount = Number.parseInt(argv[++index] ?? "", 10);
      continue;
    }
    if (arg === "--expect-eligible-count") {
      options.expectedEligibleCount = Number.parseInt(argv[++index] ?? "", 10);
      continue;
    }
    if (arg === "--expect-manifest-sha256") {
      options.expectedManifestSha256 = argv[++index] ?? null;
      continue;
    }
    if (arg === "--backup-root") {
      options.backupRoot = argv[++index] ?? "";
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.apply && options.rollbackManifest) {
    throw new Error("Choose either --apply or --rollback-manifest, not both.");
  }
  return options;
}

function parseRecord(value) {
  try {
    const parsed = JSON.parse(value ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedOptional(value) {
  return value === undefined || value === null ? null : value;
}

function valuesEqual(left, right) {
  return JSON.stringify(normalizedOptional(left)) === JSON.stringify(normalizedOptional(right));
}

function buildPost(event, normalizedFields) {
  const handle = normalizeHandle(normalizedFields.sourceGroundingInstagramHandle ?? "");
  return {
    postId: event.instagramPostId ?? "",
    caption: event.sourceCaption ?? "",
    altText:
      typeof normalizedFields.postAltText === "string" && normalizedFields.postAltText.trim()
        ? normalizedFields.postAltText
        : null,
    imageUrl: event.imageUrl ?? null,
    imageUrls: event.imageUrl ? [event.imageUrl] : [],
    postType:
      typeof normalizedFields.postType === "string" ? normalizedFields.postType : null,
    locationName:
      typeof normalizedFields.locationName === "string" && normalizedFields.locationName.trim()
        ? normalizedFields.locationName
        : null,
    instagramPostUrl: event.instagramPostUrl ?? "",
    postedAt: event.sourcePostedAt ?? null,
    username: handle,
  };
}

function buildSourceIdentity(post) {
  const shortcode = post.instagramPostUrl.match(
    /instagram\.com\/(?:p|reel|reels|tv)\/([^/?#]+)/iu,
  )?.[1];
  const identity = shortcode || post.postId || post.instagramPostUrl.toLowerCase();
  return `instagram-source-identity-v1:${identity}`;
}

async function loadPendingEvents(client, serviceSecret) {
  const events = [];
  let cursor = null;
  for (let pageNumber = 0; pageNumber < 1_000; pageNumber += 1) {
    const result = await client.query(listByStatusPaginatedQuery, {
      status: "pending",
      paginationOpts: { numItems: 50, cursor },
      serviceSecret,
    });
    if (result.pageStatus === "SplitRequired") {
      throw new Error("Pending-event pagination requested a split; refusing a partial read.");
    }
    events.push(...result.page);
    if (result.isDone) return events;
    if (!result.continueCursor || result.continueCursor === cursor) {
      throw new Error("Pending-event pagination cursor stalled.");
    }
    cursor = result.continueCursor;
  }
  throw new Error("Pending-event pagination exceeded its safety bound.");
}

async function loadContexts(client, serviceSecret, handles) {
  const contexts = [];
  for (let index = 0; index < handles.length; index += 25) {
    contexts.push(
      ...(await client.query(getIngestionContextsQuery, {
        handles: handles.slice(index, index + 25),
        serviceSecret,
      })),
    );
  }
  return contexts;
}

async function loadExactEvents(client, serviceSecret, ids) {
  const rows = [];
  for (let index = 0; index < ids.length; index += 100) {
    rows.push(
      ...(await client.query(getManyByIdsQuery, {
        ids: ids.slice(index, index + 100),
        serviceSecret,
      })),
    );
  }
  const byId = new Map(rows.map((row) => [row._id, row]));
  if (byId.size !== ids.length) {
    throw new Error(`Exact event readback returned ${byId.size}/${ids.length} rows.`);
  }
  return byId;
}

function targetEventsFromPending(pending) {
  return pending
    .filter((event) => {
      const fields = parseRecord(event.normalizedFieldsJson);
      return (
        event.createdAt >= TARGET_CREATED_AT_FROM &&
        event.createdAt < TARGET_CREATED_AT_BEFORE &&
        fields.extractionContractVersion === "event_evidence_v2" &&
        fields.sourceGroundingVersion === 5
      );
    })
    .sort((left, right) => left._id.localeCompare(right._id));
}

function buildPreimageManifest(targets) {
  return targets.map((event) => {
    const fields = parseRecord(event.normalizedFieldsJson);
    return {
      id: event._id,
      updatedAt: event.updatedAt,
      status: event.status,
      postId: event.instagramPostId ?? null,
      sourceOccurrenceKey: event.sourceOccurrenceKey ?? null,
      sourceHandle: normalizeHandle(fields.sourceGroundingInstagramHandle ?? ""),
      normalizedFieldsSha256: sha256(event.normalizedFieldsJson ?? ""),
      rawExtractionSha256: sha256(event.rawExtractionJson ?? ""),
    };
  });
}

const STABLE_PUBLIC_FIELDS = [
  "date",
  "time",
  "timeSource",
  "timeEvidenceText",
  "timeConfidence",
  "timeStatus",
  "timeEvidenceKind",
  "dateEvidenceText",
  "dateEvidenceSource",
  "dateEvidenceIsRelative",
  "description",
  "eventType",
  "ticketPrice",
  "instagramPostId",
  "instagramPostUrl",
  "sourceCaption",
  "sourcePostedAt",
];

const MUTABLE_POLICY_PUBLIC_FIELDS = [
  "artists",
  "dateEvidenceResolvedDate",
  "sourceConflictFields",
  "title",
  "venue",
];

export function buildForwardPatch(existing, prepared) {
  const existingNormalized = parseRecord(existing.normalizedFieldsJson);
  const preparedNormalized = parseRecord(prepared.normalizedFieldsJson);
  const titleChanged = !valuesEqual(existing.title, prepared.title);
  const guardedFallbackTitleChange =
    titleChanged &&
    existingNormalized.titleUsedFallback === true &&
    existingNormalized.titleSource === "unnamed_schedule_fallback" &&
    preparedNormalized.titleUsedFallback === true &&
    preparedNormalized.titleSource === "unnamed_schedule_fallback";
  const unsupportedPublicChanges = STABLE_PUBLIC_FIELDS.filter(
    (field) => !valuesEqual(existing[field], prepared[field]),
  );
  if (titleChanged && !guardedFallbackTitleChange) {
    unsupportedPublicChanges.push("title");
  }
  if (unsupportedPublicChanges.length > 0) {
    return { unsupportedPublicChanges, patch: null, changedPublicFields: [] };
  }
  const changedPublicFields = MUTABLE_POLICY_PUBLIC_FIELDS.filter(
    (field) => !valuesEqual(existing[field], prepared[field]),
  );
  const patch = {
    status: "approved",
    normalizedFieldsJson: prepared.normalizedFieldsJson,
    dateEvidenceText: prepared.dateEvidenceText,
    dateEvidenceSource: prepared.dateEvidenceSource,
    dateEvidenceIsRelative: prepared.dateEvidenceIsRelative,
    dateEvidenceResolvedDate: prepared.dateEvidenceResolvedDate,
    sourceConflictFields: prepared.sourceConflictFields,
    ...(changedPublicFields.includes("title") ? { title: prepared.title } : {}),
    ...(changedPublicFields.includes("venue") ? { venue: prepared.venue } : {}),
    ...(changedPublicFields.includes("artists") ? { artists: prepared.artists } : {}),
  };
  return { unsupportedPublicChanges, patch, changedPublicFields };
}

function buildRollbackPatch(existing, changedPublicFields) {
  return {
    status: "pending",
    normalizedFieldsJson: existing.normalizedFieldsJson,
    dateEvidenceText: existing.dateEvidenceText,
    dateEvidenceSource: existing.dateEvidenceSource,
    dateEvidenceIsRelative: existing.dateEvidenceIsRelative,
    dateEvidenceResolvedDate: existing.dateEvidenceResolvedDate,
    sourceConflictFields: existing.sourceConflictFields ?? [],
    ...(changedPublicFields.includes("title") ? { title: existing.title } : {}),
    ...(changedPublicFields.includes("venue") ? { venue: existing.venue } : {}),
    ...(changedPublicFields.includes("artists") ? { artists: existing.artists } : {}),
  };
}

async function buildReplayPlan(client, serviceSecret, targets) {
  if (targets.length !== TARGET_EVENT_COUNT) {
    throw new Error(`Expected ${TARGET_EVENT_COUNT} exact Saturday targets, found ${targets.length}.`);
  }
  const normalizedByEventId = new Map(
    targets.map((event) => [event._id, parseRecord(event.normalizedFieldsJson)]),
  );
  const handles = [
    ...new Set(
      [...normalizedByEventId.values()]
        .map((fields) => normalizeHandle(fields.sourceGroundingInstagramHandle ?? ""))
        .filter(Boolean),
    ),
  ].sort();
  const contexts = await loadContexts(client, serviceSecret, handles);
  const canonicalVenueNamesByHandle = Object.fromEntries(
    contexts
      .filter((context) => context.canonicalVenueName)
      .map((context) => [normalizeHandle(context.handle), context.canonicalVenueName]),
  );
  const sourceRolesByHandle = {
    ...Object.fromEntries(
      contexts.map((context) => [normalizeHandle(context.handle), context.role]),
    ),
    ...PLANNED_SOURCE_ROLE_OVERRIDES,
  };
  const venueNameOverridesByHandle = await loadVenueNameOverridesByHandle();
  const configuredVenueNamesByHandle = {
    ...canonicalVenueNamesByHandle,
    ...venueNameOverridesByHandle,
  };

  const bySourcePost = new Map();
  for (const event of targets) {
    const fields = normalizedByEventId.get(event._id);
    const handle = normalizeHandle(fields.sourceGroundingInstagramHandle ?? "");
    const key = `${handle}\u0000${event.instagramPostId ?? ""}`;
    const group = bySourcePost.get(key) ?? [];
    group.push(event);
    bySourcePost.set(key, group);
  }

  const decisions = [];
  const groups = [];
  for (const sourceEvents of bySourcePost.values()) {
    const representative = sourceEvents[0];
    const previousFields = normalizedByEventId.get(representative._id);
    const post = buildPost(representative, previousFields);
    if (
      sourceEvents.some(
        (event) =>
          event.rawExtractionJson !== representative.rawExtractionJson ||
          event.sourceCaption !== representative.sourceCaption ||
          event.sourcePostedAt !== representative.sourcePostedAt,
      )
    ) {
      throw new Error(`Source siblings drifted for post ${representative.instagramPostId}.`);
    }
    const extracted = parseExtractedEventData(JSON.parse(representative.rawExtractionJson));
    const selectedImageUrl =
      previousFields.extractionMode === "poster"
        ? representative.imageUrl ?? "https://example.invalid/persisted-poster.jpg"
        : null;
    const replayed = bindSourceOccurrenceMetadata(
      post,
      prepareEventsForInsert(
        post,
        extracted,
        selectedImageUrl,
        canonicalVenueNamesByHandle,
        venueNameOverridesByHandle,
        configuredVenueNamesByHandle,
        {
          eventDateFilterNow: TARGET_REPLAY_NOW,
          preserveExplicitDateEvidenceRelativeFlag: true,
          sourceRolesByHandle,
        },
      ),
    );
    const replayedByKey = new Map(
      replayed
        .filter((item) => item.kind === "ok" && item.event.sourceOccurrenceKey)
        .map((item) => [item.event.sourceOccurrenceKey, item]),
    );
    const sourceIdentity = buildSourceIdentity(post);
    const groupItems = [];
    for (const existing of sourceEvents) {
      const prepared = replayedByKey.get(existing.sourceOccurrenceKey);
      if (!prepared) {
        decisions.push({
          id: existing._id,
          title: existing.title,
          decision: "remain_pending",
          reason: "no_exact_occurrence_replay",
          pendingReasons: [],
          changedPublicFields: [],
        });
        continue;
      }
      if (prepared.event.status !== "approved") {
        decisions.push({
          id: existing._id,
          title: existing.title,
          decision: "remain_pending",
          reason: "policy_still_requires_review",
          pendingReasons: prepared.normalizedFields.moderationPendingReasons ?? [],
          diagnostics: {
            dateEvidenceVerified: prepared.normalizedFields.dateEvidenceVerified ?? null,
            dateEvidenceResolvedDate:
              prepared.normalizedFields.dateEvidenceResolvedDate ?? null,
            dateEvidenceText: prepared.normalizedFields.dateEvidenceText ?? null,
            identityEvidenceVerified: prepared.normalizedFields.identityEvidenceVerified ?? null,
            normalizedDate: prepared.normalizedFields.normalizedDate ?? null,
            normalizedVenue: prepared.normalizedFields.normalizedVenue ?? null,
            splitEventIndex: prepared.normalizedFields.splitEventIndex ?? null,
            splitEventTotal: prepared.normalizedFields.splitEventTotal ?? null,
            sourceOccurrenceKey: prepared.normalizedFields.sourceOccurrenceKey ?? null,
          },
          changedPublicFields: [],
        });
        continue;
      }
      const patchPlan = buildForwardPatch(existing, prepared.event);
      if (!patchPlan.patch) {
        decisions.push({
          id: existing._id,
          title: existing.title,
          decision: "remain_pending",
          reason: "unsupported_public_field_drift",
          pendingReasons: [],
          changedPublicFields: patchPlan.unsupportedPublicChanges,
        });
        continue;
      }
      const item = {
        id: existing._id,
        expectedUpdatedAt: existing.updatedAt,
        expectedNormalizedFieldsJson: existing.normalizedFieldsJson,
        patch: patchPlan.patch,
      };
      const rollbackItem = {
        id: existing._id,
        expectedNormalizedFieldsJson: prepared.event.normalizedFieldsJson,
        patch: buildRollbackPatch(existing, patchPlan.changedPublicFields),
      };
      groupItems.push({ item, rollbackItem, existing, prepared: prepared.event });
      decisions.push({
        id: existing._id,
        title: existing.title,
        decision: "eligible_guarded_replay",
        reason: POLICY_REASON,
        pendingReasons: [],
        changedPublicFields: patchPlan.changedPublicFields,
        nextNormalizedFieldsSha256: sha256(prepared.event.normalizedFieldsJson),
      });
    }
    if (groupItems.length > 0) {
      const receipt = await client.query(getOccurrenceReceiptQuery, {
        sourceIdentity,
        serviceSecret,
      });
      const keys = new Set(groupItems.map(({ existing }) => existing.sourceOccurrenceKey));
      if (
        !receipt ||
        receipt.sourceIdentity !== sourceIdentity ||
        receipt.sourceFingerprint !== previousFields.sourceOccurrenceSourceFingerprint ||
        groupItems.some(
          ({ existing }) =>
            !receipt.expectedOccurrences?.some(
              (occurrence) => occurrence.key === existing.sourceOccurrenceKey,
            ) ||
            !receipt.satisfiedOccurrences?.some(
              (occurrence) =>
                occurrence.key === existing.sourceOccurrenceKey &&
                occurrence.eventId === existing._id,
            ),
        ) ||
        keys.size !== groupItems.length
      ) {
        throw new Error(`Occurrence receipt preflight failed for ${sourceIdentity}.`);
      }
      groups.push({
        sourceIdentity,
        expectedReceiptId: receipt._id,
        expectedReceiptUpdatedAt: receipt.updatedAt,
        expectedSourceFingerprint: receipt.sourceFingerprint,
        items: groupItems,
      });
    }
  }
  decisions.sort((left, right) => left.id.localeCompare(right.id));
  groups.sort((left, right) => left.sourceIdentity.localeCompare(right.sourceIdentity));
  return { contexts, decisions, groups };
}

function createExclusiveJsonFile(directory, basename, value) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const filePath = path.join(directory, basename);
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const descriptor = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, payload);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(filePath, 0o600);
  const directoryDescriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(directoryDescriptor);
  } finally {
    fs.closeSync(directoryDescriptor);
  }
  if (fs.readFileSync(filePath, "utf8") !== payload) {
    throw new Error(`Backup verification failed: ${filePath}.`);
  }
  return { path: filePath, sha256: sha256(payload) };
}

function replaceJsonFileAtomically(filePath, value) {
  const directory = path.dirname(filePath);
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, payload);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryPath, filePath);
  fs.chmodSync(filePath, 0o600);
  const directoryDescriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(directoryDescriptor);
  } finally {
    fs.closeSync(directoryDescriptor);
  }
  if (fs.readFileSync(filePath, "utf8") !== payload) {
    throw new Error(`Journal verification failed: ${filePath}.`);
  }
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    ...(error && typeof error === "object" && typeof error.code === "string"
      ? { code: error.code }
      : {}),
  };
}

function completedRollbackGroupCount(appliedGroups) {
  return appliedGroups.filter((group) => group.rollback?.status === "rolled_back").length;
}

export async function rollbackAppliedGroups(
  client,
  serviceSecret,
  appliedGroups,
  { persistProgress } = {},
) {
  if (!Array.isArray(appliedGroups)) {
    throw new Error("Rollback requires an applied-group list.");
  }

  const rollbackResults = [];
  const skippedSourceIdentities = [];
  const rollbackFailures = [];
  let pendingProgressError = null;

  const persistOutcome = async (outcome) => {
    if (typeof persistProgress !== "function") return;
    try {
      await persistProgress({ appliedGroups, outcome });
      // Each progress write contains the complete group list, so a later
      // successful write supersedes an earlier transient journal failure.
      pendingProgressError = null;
    } catch (error) {
      pendingProgressError = error;
    }
  };

  for (const applied of [...appliedGroups].reverse()) {
    if (applied.rollback?.status === "rolled_back") {
      skippedSourceIdentities.push(applied.sourceIdentity);
      continue;
    }

    const attemptedAt = new Date().toISOString();
    try {
      const currentReceipt = await client.query(getOccurrenceReceiptQuery, {
        sourceIdentity: applied.sourceIdentity,
        serviceSecret,
      });
      if (
        !currentReceipt ||
        currentReceipt._id !== applied.expectedReceiptId ||
        currentReceipt.updatedAt !== applied.result.receiptUpdatedAt ||
        currentReceipt.sourceFingerprint !== applied.expectedSourceFingerprint
      ) {
        throw new Error(`Rollback receipt changed after apply: ${applied.sourceIdentity}.`);
      }
      const updatedAtById = new Map(
        applied.result.eventUpdatedAts.map((item) => [item.id, item.updatedAt]),
      );
      const result = await client.mutation(rollbackPolicyMutation, {
        sourceIdentity: applied.sourceIdentity,
        expectedReceiptId: applied.expectedReceiptId,
        expectedReceiptUpdatedAt: applied.result.receiptUpdatedAt,
        expectedSourceFingerprint: applied.expectedSourceFingerprint,
        items: applied.items.map(({ rollbackItem }) => ({
          ...rollbackItem,
          expectedUpdatedAt: updatedAtById.get(rollbackItem.id),
        })),
        serviceSecret,
      });
      applied.rollback = {
        status: "rolled_back",
        attemptedAt,
        completedAt: new Date().toISOString(),
        result,
      };
      const outcome = { sourceIdentity: applied.sourceIdentity, status: "rolled_back", result };
      rollbackResults.push({ sourceIdentity: applied.sourceIdentity, result });
      await persistOutcome(outcome);
    } catch (error) {
      const serializedError = serializeError(error);
      applied.rollback = {
        status: "failed",
        attemptedAt,
        error: serializedError,
      };
      rollbackFailures.push({
        sourceIdentity: applied.sourceIdentity,
        error,
        serializedError,
      });
      await persistOutcome({
        sourceIdentity: applied.sourceIdentity,
        status: "failed",
        error: serializedError,
      });
    }
  }

  if (pendingProgressError) {
    rollbackFailures.push({
      sourceIdentity: "rollback_progress_journal",
      error: pendingProgressError,
      serializedError: serializeError(pendingProgressError),
    });
  }

  const summary = {
    rollbackResults,
    skippedSourceIdentities,
    failures: rollbackFailures.map(({ sourceIdentity, serializedError }) => ({
      sourceIdentity,
      error: serializedError,
    })),
    completedGroupCount: completedRollbackGroupCount(appliedGroups),
    totalGroupCount: appliedGroups.length,
  };
  if (rollbackFailures.length > 0) {
    const aggregate = new AggregateError(
      rollbackFailures.map(({ error }) => error),
      `Rollback completed ${summary.completedGroupCount}/${summary.totalGroupCount} group(s); ${rollbackFailures.length} failure(s) remain.`,
    );
    aggregate.rollbackSummary = summary;
    throw aggregate;
  }
  return summary;
}

async function runRollback(client, serviceSecret, manifestPath) {
  const manifestPayload = fs.readFileSync(manifestPath, "utf8");
  const report = JSON.parse(manifestPayload);
  if (!Array.isArray(report.appliedGroups) || report.appliedGroups.length === 0) {
    throw new Error("Rollback manifest has no applied groups.");
  }
  const sourceManifestSha256 = sha256(manifestPayload);
  const rollbackJournalPath = `${path.resolve(manifestPath)}.rollback-progress.json`;
  let rollbackJournal;
  if (fs.existsSync(rollbackJournalPath)) {
    rollbackJournal = JSON.parse(fs.readFileSync(rollbackJournalPath, "utf8"));
    if (
      rollbackJournal.version !== "event-zeka-moderation-policy-rollback-journal:v1" ||
      rollbackJournal.sourceManifestSha256 !== sourceManifestSha256 ||
      !Array.isArray(rollbackJournal.appliedGroups)
    ) {
      throw new Error("Rollback progress journal does not match the requested manifest.");
    }
  } else {
    rollbackJournal = {
      version: "event-zeka-moderation-policy-rollback-journal:v1",
      status: "rolling_back",
      sourceManifestPath: path.resolve(manifestPath),
      sourceManifestSha256,
      appliedGroups: structuredClone(report.appliedGroups),
      createdAt: new Date().toISOString(),
    };
    createExclusiveJsonFile(
      path.dirname(rollbackJournalPath),
      path.basename(rollbackJournalPath),
      rollbackJournal,
    );
  }

  const persistProgress = async ({ appliedGroups, outcome }) => {
    rollbackJournal = {
      ...rollbackJournal,
      status: "rolling_back",
      appliedGroups,
      lastOutcome: outcome,
      updatedAt: new Date().toISOString(),
    };
    replaceJsonFileAtomically(rollbackJournalPath, rollbackJournal);
  };

  let summary;
  try {
    summary = await rollbackAppliedGroups(
      client,
      serviceSecret,
      rollbackJournal.appliedGroups,
      { persistProgress },
    );
    rollbackJournal = {
      ...rollbackJournal,
      status: "rolled_back",
      appliedGroups: rollbackJournal.appliedGroups,
      rollbackSummary: summary,
      completedAt: new Date().toISOString(),
    };
    replaceJsonFileAtomically(rollbackJournalPath, rollbackJournal);
  } catch (error) {
    summary = error?.rollbackSummary ?? null;
    rollbackJournal = {
      ...rollbackJournal,
      status: "rollback_failed",
      appliedGroups: rollbackJournal.appliedGroups,
      rollbackSummary: summary,
      error: serializeError(error),
      updatedAt: new Date().toISOString(),
    };
    replaceJsonFileAtomically(rollbackJournalPath, rollbackJournal);
    throw error;
  }

  const rolledBackEventCount = rollbackJournal.appliedGroups.reduce(
    (count, group) => count + (group.rollback?.result?.updatedCount ?? 0),
    0,
  );
  console.log(
    JSON.stringify(
      {
        mode: "rollback",
        manifestPath,
        rollbackJournalPath,
        rolledBackGroupCount: summary.completedGroupCount,
        newlyRolledBackGroupCount: summary.rollbackResults.length,
        skippedRolledBackGroupCount: summary.skippedSourceIdentities.length,
        rolledBackEventCount,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const serviceSecret = process.env.CRON_SECRET?.trim();
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
  if (!serviceSecret || !convexUrl) {
    throw new Error("Missing production Convex configuration.");
  }
  const client = new ConvexHttpClient(convexUrl);
  if (options.rollbackManifest) {
    await runRollback(client, serviceSecret, options.rollbackManifest);
    return;
  }

  const pending = await loadPendingEvents(client, serviceSecret);
  const targets = targetEventsFromPending(pending);
  const preimage = buildPreimageManifest(targets);
  const preimageSha256 = sha256(stableJson(preimage));
  const plan = await buildReplayPlan(client, serviceSecret, targets);
  const eligible = plan.decisions.filter(
    (decision) => decision.decision === "eligible_guarded_replay",
  );
  const publicFieldChangeCounts = Object.fromEntries(
    MUTABLE_POLICY_PUBLIC_FIELDS.map((field) => [
      field,
      eligible.filter((decision) => decision.changedPublicFields.includes(field)).length,
    ]),
  );
  const manifest = {
    version: "event-zeka-moderation-policy-replay-2026-08-22:v1",
    targetWindow: {
      createdAtFrom: TARGET_CREATED_AT_FROM,
      createdAtBefore: TARGET_CREATED_AT_BEFORE,
    },
    preimageSha256,
    decisions: plan.decisions.map((decision) => ({
      id: decision.id,
      decision: decision.decision,
      reason: decision.reason,
      changedPublicFields: decision.changedPublicFields,
      nextNormalizedFieldsSha256: decision.nextNormalizedFieldsSha256 ?? null,
    })),
  };
  const manifestSha256 = sha256(stableJson(manifest));
  const summary = {
    mode: options.apply ? "apply" : "dry-run",
    targetCount: targets.length,
    eligibleCount: eligible.length,
    remainPendingCount: targets.length - eligible.length,
    sourcePostCount: new Set(targets.map((event) => event.instagramPostId)).size,
    groupCount: plan.groups.length,
    preimageSha256,
    manifestSha256,
    publicFieldChangeCounts,
    longPlaySourceRole:
      plan.contexts.find((context) => normalizeHandle(context.handle) === "longplayofficial")
        ?.role ?? null,
    decisions: plan.decisions,
  };

  if (!options.apply) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (
    options.expectedTargetCount !== targets.length ||
    options.expectedEligibleCount !== eligible.length ||
    options.expectedManifestSha256 !== manifestSha256 ||
    targets.length !== TARGET_EVENT_COUNT ||
    summary.longPlaySourceRole !== "promoter" ||
    !options.backupRoot
  ) {
    throw new Error("Apply admission failed: counts, manifest, source role, or backup path drifted.");
  }

  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backup = createExclusiveJsonFile(options.backupRoot, `preapply-${stamp}.json`, {
    manifest,
    manifestSha256,
    targets,
    groups: plan.groups,
  });
  const journalPath = path.join(options.backupRoot, `apply-journal-${stamp}.json`);
  const appliedGroups = [];
  const writeJournal = (status, extra = {}) =>
    replaceJsonFileAtomically(journalPath, {
      version: "event-zeka-moderation-policy-replay-journal:v1",
      status,
      manifestSha256,
      backup,
      appliedGroups,
      ...extra,
    });
  writeJournal("applying");
  try {
    for (const group of plan.groups) {
      const currentReceipt = await client.query(getOccurrenceReceiptQuery, {
        sourceIdentity: group.sourceIdentity,
        serviceSecret,
      });
      if (
        !currentReceipt ||
        currentReceipt._id !== group.expectedReceiptId ||
        currentReceipt.updatedAt !== group.expectedReceiptUpdatedAt ||
        currentReceipt.sourceFingerprint !== group.expectedSourceFingerprint
      ) {
        throw new Error(`Receipt changed before apply: ${group.sourceIdentity}.`);
      }
      const result = await client.mutation(applyPolicyMutation, {
        sourceIdentity: group.sourceIdentity,
        expectedReceiptId: group.expectedReceiptId,
        expectedReceiptUpdatedAt: group.expectedReceiptUpdatedAt,
        expectedSourceFingerprint: group.expectedSourceFingerprint,
        items: group.items.map(({ item }) => item),
        serviceSecret,
      });
      appliedGroups.push({
        sourceIdentity: group.sourceIdentity,
        expectedReceiptId: group.expectedReceiptId,
        expectedSourceFingerprint: group.expectedSourceFingerprint,
        items: group.items,
        result,
      });
      writeJournal("applying");
    }

    const afterById = await loadExactEvents(
      client,
      serviceSecret,
      targets.map((event) => event._id),
    );
    const eligibleIds = new Set(eligible.map((decision) => decision.id));
    const violations = [];
    for (const before of targets) {
      const after = afterById.get(before._id);
      const expectedStatus = eligibleIds.has(before._id) ? "approved" : "pending";
      if (after?.status !== expectedStatus) {
        violations.push({ id: before._id, expectedStatus, actualStatus: after?.status ?? null });
      }
    }
    if (violations.length > 0) {
      throw new Error(`Post-apply event reconciliation failed: ${JSON.stringify(violations)}.`);
    }
    const appliedEventCount = appliedGroups.reduce(
      (count, group) => count + group.result.updatedCount,
      0,
    );
    if (appliedEventCount !== eligible.length) {
      throw new Error(`Post-apply count mismatch: ${appliedEventCount}/${eligible.length}.`);
    }

    const report = {
      ...summary,
      backup,
      appliedEventCount,
      appliedGroups,
      approvedAfter: [...afterById.values()].filter((event) => event.status === "approved").length,
      pendingAfter: [...afterById.values()].filter((event) => event.status === "pending").length,
    };
    writeJournal("verified", { appliedEventCount });
    const reportFile = createExclusiveJsonFile(
      options.backupRoot,
      `postapply-${stamp}.json`,
      report,
    );
    console.log(JSON.stringify({ ...report, journalPath, reportFile }, null, 2));
  } catch (error) {
    const failures = [error];
    let rollbackSummary = {
      rollbackResults: [],
      skippedSourceIdentities: [],
      failures: [],
      completedGroupCount: 0,
      totalGroupCount: appliedGroups.length,
    };
    try {
      rollbackSummary = await rollbackAppliedGroups(client, serviceSecret, appliedGroups, {
        persistProgress: async ({ outcome }) => {
          writeJournal("rolling_back", { lastRollbackOutcome: outcome });
        },
      });
      writeJournal("rolled_back", { rollbackSummary });
    } catch (rollbackError) {
      failures.push(rollbackError);
      rollbackSummary = rollbackError?.rollbackSummary ?? rollbackSummary;
      try {
        writeJournal("rollback_failed", {
          applyError: error instanceof Error ? error.message : String(error),
          rollbackError: serializeError(rollbackError),
          rollbackSummary,
        });
      } catch (journalError) {
        failures.push(journalError);
      }
    }
    throw new AggregateError(
      failures,
      `Apply failed; ${rollbackSummary.completedGroupCount}/${appliedGroups.length} completed source group(s) were rolled back. Journal: ${journalPath}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
