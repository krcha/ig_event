import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ConvexHttpClient } from "convex/browser";

import {
  buildDuplicateUpdatePatch,
  prepareEventsForInsert,
} from "../lib/pipeline/run-instagram-ingestion.ts";
import { hasCompleteSourceGroundedAutoApproval } from "../lib/events/event-update-precondition.ts";

const REPROCESS_REASON = "caption_source_event_mismatch";
const REPROCESS_PUBLIC_DATE = "2026-07-20";
const BACKUP_ROOT = "/root/backups/ig-event-source-grounding-reprocess-20260720";
const PUBLIC_EVENT_FIELDS = [
  "title",
  "date",
  "time",
  "timeSource",
  "timeEvidenceText",
  "timeConfidence",
  "timeStatus",
  "venue",
  "artists",
  "description",
  "imageUrl",
  "instagramPostUrl",
  "instagramPostId",
  "ticketPrice",
  "eventType",
  "sourceCaption",
  "sourcePostedAt",
];
const ALLOWED_NORMALIZED_FIELD_CHANGES = new Set([
  "approvalCaptionSourceCoherent",
  "extractionScorecard",
  "moderationAutoApproveRule",
  "moderationAutoApproved",
  "moderationPendingReasons",
  "moderationSignals",
  "sourceGroundingArtistsVerified",
  "sourceGroundingDateVerified",
  "sourceGroundingIdentityContextVerified",
  "sourceGroundingIdentityVerified",
  "sourceGroundingRowVerified",
  "sourceGroundingTimeVerified",
  "sourceGroundingTitleVerified",
  "sourceGroundingVerified",
]);

function parseArgs(argv) {
  const options = {
    apply: false,
    expectedEligibleCount: null,
    expectedManifestSha256: null,
    expectedTargetCount: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    const value = argv[index + 1];
    if (arg === "--expect-target-count") {
      options.expectedTargetCount = Number.parseInt(value ?? "", 10);
      index += 1;
      continue;
    }
    if (arg === "--expect-eligible-count") {
      options.expectedEligibleCount = Number.parseInt(value ?? "", 10);
      index += 1;
      continue;
    }
    if (arg === "--expect-manifest-sha256") {
      options.expectedManifestSha256 = value ?? null;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalize(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function comparable(value) {
  return value === undefined || value === null ? null : value;
}

function valuesEqual(left, right) {
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function changedObjectKeys(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !valuesEqual(before[key], after[key]))
    .sort();
}

function buildPost(existing, normalizedFields) {
  const username = normalize(normalizedFields.sourceGroundingInstagramHandle).replace(/^@/u, "");
  const postType = normalize(normalizedFields.postType) || null;
  const locationName = normalize(normalizedFields.locationName) || null;
  const altText =
    typeof normalizedFields.postAltText === "string" && normalizedFields.postAltText.trim()
      ? normalizedFields.postAltText
      : null;
  return {
    postId: existing.instagramPostId ?? "",
    caption: existing.sourceCaption ?? "",
    altText,
    imageUrl: existing.imageUrl ?? null,
    imageUrls: existing.imageUrl ? [existing.imageUrl] : [],
    postType,
    locationName,
    instagramPostUrl: existing.instagramPostUrl ?? "",
    postedAt: existing.sourcePostedAt ?? null,
    username,
  };
}

function buildExtracted(existing, normalizedFields) {
  const raw = parseObject(existing.rawExtractionJson);
  return {
    ...raw,
    title: raw.title ?? existing.title,
    date: raw.date ?? existing.date,
    time: raw.time ?? existing.time ?? "",
    venue: raw.venue ?? existing.venue,
    artists: Array.isArray(raw.artists) ? raw.artists : existing.artists ?? [],
    description: raw.description ?? existing.description ?? "",
    category: raw.category ?? existing.eventType,
    price: raw.price ?? "",
    currency: raw.currency ?? "",
    confidence: raw.confidence ?? normalizedFields.confidence ?? 0,
    source_caption: raw.source_caption ?? existing.sourceCaption ?? "",
    field_confirmation:
      raw.field_confirmation && typeof raw.field_confirmation === "object"
        ? raw.field_confirmation
        : {},
    schedule_entries: Array.isArray(raw.schedule_entries) ? raw.schedule_entries : [],
  };
}

function prepareExistingEvent(existing) {
  const previousNormalizedFields = parseObject(existing.normalizedFieldsJson);
  const post = buildPost(existing, previousNormalizedFields);
  const extracted = buildExtracted(existing, previousNormalizedFields);
  const venueSource = normalize(previousNormalizedFields.venueSource);
  const venueMap =
    venueSource === "handle_map" && post.username && existing.venue
      ? { [post.username]: existing.venue }
      : {};
  const filterDateToday =
    typeof previousNormalizedFields.filterDateToday === "string" &&
    /^\d{4}-\d{2}-\d{2}$/u.test(previousNormalizedFields.filterDateToday)
      ? previousNormalizedFields.filterDateToday
      : null;
  const eventDateFilterNow = filterDateToday
    ? new Date(`${filterDateToday}T12:00:00.000Z`)
    : undefined;
  const prepared = prepareEventsForInsert(
    post,
    extracted,
    existing.imageUrl ?? null,
    venueMap,
    {},
    venueMap,
    { eventDateFilterNow },
  ).filter((result) => result.kind === "ok");
  const exact =
    prepared.find(
      (result) =>
        result.event.date === existing.date && normalize(result.event.title) === normalize(existing.title),
    ) ?? (prepared.length === 1 && prepared[0].event.date === existing.date ? prepared[0] : null);
  if (!exact) {
    return { decision: "no_exact_prepared_match", existing };
  }

  const duplicateDecision = buildDuplicateUpdatePatch(existing, exact.event);
  const changedPublicFields = PUBLIC_EVENT_FIELDS.filter(
    (field) => !valuesEqual(existing[field], exact.event[field]),
  );
  const preparedNormalizedFields = parseObject(exact.event.normalizedFieldsJson);
  const nextNormalizedFields = { ...previousNormalizedFields };
  for (const key of ALLOWED_NORMALIZED_FIELD_CHANGES) {
    if (Object.hasOwn(preparedNormalizedFields, key)) {
      nextNormalizedFields[key] = preparedNormalizedFields[key];
    }
  }
  const nextNormalizedFieldsJson = JSON.stringify(nextNormalizedFields);
  const normalizedChangedKeys = changedObjectKeys(previousNormalizedFields, nextNormalizedFields);
  const disallowedNormalizedChanges = normalizedChangedKeys.filter(
    (key) => !ALLOWED_NORMALIZED_FIELD_CHANGES.has(key),
  );
  const eligible =
    exact.event.status === "approved" &&
    duplicateDecision.statusAutoApproved === true &&
    duplicateDecision.patch.status === "approved" &&
    changedPublicFields.length === 0 &&
    disallowedNormalizedChanges.length === 0 &&
    hasCompleteSourceGroundedAutoApproval(nextNormalizedFieldsJson, existing) &&
    nextNormalizedFieldsJson !== existing.normalizedFieldsJson;

  return {
    decision: eligible ? "eligible_guarded_reprocess" : "remain_pending",
    existing,
    nextNormalizedFieldsJson,
    changedPublicFields,
    normalizedChangedKeys,
    disallowedNormalizedChanges,
    preparedStatus: exact.event.status,
    statusAutoApproved: duplicateDecision.statusAutoApproved,
  };
}

function createExclusiveBackup(targets, manifestSha256) {
  fs.mkdirSync(BACKUP_ROOT, { recursive: true, mode: 0o700 });
  fs.chmodSync(BACKUP_ROOT, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupPath = path.join(BACKUP_ROOT, `preapply-${stamp}.json`);
  const payload = `${JSON.stringify({ manifestSha256, targets }, null, 2)}\n`;
  fs.writeFileSync(backupPath, payload, { flag: "wx", mode: 0o600 });
  fs.chmodSync(backupPath, 0o600);
  const reread = fs.readFileSync(backupPath, "utf8");
  const parsed = JSON.parse(reread);
  const expectedIds = targets.map((event) => event._id).sort();
  const backedUpIds = parsed.targets.map((event) => event._id).sort();
  if (
    reread !== payload ||
    parsed.manifestSha256 !== manifestSha256 ||
    parsed.targets.length !== targets.length ||
    JSON.stringify(backedUpIds) !== JSON.stringify(expectedIds)
  ) {
    throw new Error("Exclusive pre-apply backup verification failed.");
  }
  return { backupPath, backupSha256: sha256(reread) };
}

export async function loadExactTargetRows(client, serviceSecret, targets) {
  const dates = [...new Set(targets.map((event) => event.date))];
  const rows = [];
  for (const date of dates) {
    rows.push(...(await client.query("events:listByDate", { date, serviceSecret })));
  }
  const targetIds = new Set(targets.map((event) => event._id));
  const byId = new Map(rows.filter((event) => targetIds.has(event._id)).map((event) => [event._id, event]));
  if (byId.size !== targetIds.size) {
    throw new Error(`Exact post-apply readback found ${byId.size}/${targetIds.size} target rows.`);
  }
  return byId;
}

function reconcile({ beforeTargets, afterById, eligibleIds }) {
  const allowedEligibleChanges = ["normalizedFieldsJson", "status", "updatedAt"];
  const eligibleIdSet = new Set(eligibleIds);
  const violations = [];
  let approved = 0;
  let pending = 0;
  for (const before of beforeTargets) {
    const after = afterById.get(before._id);
    const changedKeys = changedObjectKeys(before, after);
    if (eligibleIdSet.has(before._id)) {
      if (JSON.stringify(changedKeys) !== JSON.stringify(allowedEligibleChanges)) {
        violations.push({ id: before._id, changedKeys, expected: allowedEligibleChanges });
      }
      if (after.status !== "approved") violations.push({ id: before._id, status: after.status });
    } else {
      if (changedKeys.length > 0) violations.push({ id: before._id, changedKeys, expected: [] });
      if (after.status !== "pending") violations.push({ id: before._id, status: after.status });
    }
    if (after.status === "approved") approved += 1;
    if (after.status === "pending") pending += 1;
  }
  if (violations.length > 0) {
    throw new Error(`Post-apply reconciliation failed: ${JSON.stringify(violations)}`);
  }
  return { approved, pending, violations: [] };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const serviceSecret = process.env.CRON_SECRET?.trim();
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
  if (!serviceSecret || !convexUrl) {
    throw new Error("Missing production Convex configuration.");
  }
  const client = new ConvexHttpClient(convexUrl);
  const pending = await client.query("events:listByStatus", {
    status: "pending",
    limit: 1000,
    serviceSecret,
  });
  const targets = pending
    .filter((event) => {
      const fields = parseObject(event.normalizedFieldsJson);
      return (
        Array.isArray(fields.moderationPendingReasons) &&
        fields.moderationPendingReasons.includes(REPROCESS_REASON)
      );
    })
    .sort((left, right) => left._id.localeCompare(right._id));
  const decisions = targets.map(prepareExistingEvent);
  const eligible = decisions.filter((decision) => decision.decision === "eligible_guarded_reprocess");
  const eligibleItems = eligible.map((decision) => ({
    id: decision.existing._id,
    expectedUpdatedAt: decision.existing.updatedAt,
    expectedNormalizedFieldsJson: decision.existing.normalizedFieldsJson,
    nextNormalizedFieldsJson: decision.nextNormalizedFieldsJson,
  }));
  const manifest = {
    reason: REPROCESS_REASON,
    targets: decisions.map((decision) => ({
      id: decision.existing._id,
      updatedAt: decision.existing.updatedAt,
      expectedNormalizedFieldsSha256: sha256(decision.existing.normalizedFieldsJson ?? ""),
      decision: decision.decision,
      nextNormalizedFieldsSha256: decision.nextNormalizedFieldsJson
        ? sha256(decision.nextNormalizedFieldsJson)
        : null,
    })),
  };
  const manifestJson = JSON.stringify(manifest);
  const manifestSha256 = sha256(manifestJson);
  const summary = {
    mode: options.apply ? "apply" : "dry-run",
    pendingScanned: pending.length,
    targetCount: targets.length,
    eligibleCount: eligible.length,
    remainPendingCount: targets.length - eligible.length,
    eligibleToday: eligible
      .filter((decision) => decision.existing.date === REPROCESS_PUBLIC_DATE)
      .map((decision) => ({
        id: decision.existing._id,
        title: decision.existing.title,
        venue: decision.existing.venue,
      })),
    manifestSha256,
    decisions: decisions.map((decision) => ({
      id: decision.existing._id,
      title: decision.existing.title,
      date: decision.existing.date,
      decision: decision.decision,
      changedPublicFields: decision.changedPublicFields ?? [],
      normalizedChangedKeys: decision.normalizedChangedKeys ?? [],
      disallowedNormalizedChanges: decision.disallowedNormalizedChanges ?? [],
    })),
  };

  if (!options.apply) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (
    !Number.isSafeInteger(options.expectedTargetCount) ||
    !Number.isSafeInteger(options.expectedEligibleCount) ||
    !/^[a-f0-9]{64}$/u.test(options.expectedManifestSha256 ?? "")
  ) {
    throw new Error(
      "Apply requires --expect-target-count, --expect-eligible-count, and --expect-manifest-sha256.",
    );
  }
  if (
    targets.length !== options.expectedTargetCount ||
    eligible.length !== options.expectedEligibleCount ||
    manifestSha256 !== options.expectedManifestSha256
  ) {
    throw new Error(
      `Apply manifest guard failed: targets=${targets.length}, eligible=${eligible.length}, manifest=${manifestSha256}.`,
    );
  }
  if (eligible.some((decision) => decision.changedPublicFields.length > 0)) {
    throw new Error("Apply refused because an eligible candidate changes a public/source field.");
  }

  const publicBeforeDate = "2026-07-21";
  const beforeTodayRows = await client.query("events:listPublicCalendarEventsWindow", {
    fromDate: REPROCESS_PUBLIC_DATE,
    beforeDate: publicBeforeDate,
  });
  const publicDateCountBefore = beforeTodayRows.length;
  const backup = createExclusiveBackup(targets, manifestSha256);
  const mutationResult = await client.mutation("events:reprocessPendingSourceGroundingBatch", {
    serviceSecret,
    items: eligibleItems,
  });
  const afterById = await loadExactTargetRows(client, serviceSecret, targets);
  const reconciliation = reconcile({
    beforeTargets: targets,
    afterById,
    eligibleIds: eligibleItems.map((item) => item.id),
  });
  const afterTodayRows = await client.query("events:listPublicCalendarEventsWindow", {
    fromDate: REPROCESS_PUBLIC_DATE,
    beforeDate: publicBeforeDate,
  });
  const publicDateCountAfter = afterTodayRows.length;
  const expectedTodayDelta = eligible.filter(
    (decision) => decision.existing.date === REPROCESS_PUBLIC_DATE,
  ).length;
  if (publicDateCountAfter - publicDateCountBefore !== expectedTodayDelta) {
    throw new Error(
      `Unexpected ${REPROCESS_PUBLIC_DATE} public delta: before=${publicDateCountBefore}, after=${publicDateCountAfter}, expectedDelta=${expectedTodayDelta}.`,
    );
  }
  if (
    mutationResult.updatedCount !== eligible.length ||
    reconciliation.approved !== eligible.length ||
    reconciliation.pending !== targets.length - eligible.length
  ) {
    throw new Error("Transactional reprocessing count verification failed.");
  }

  const report = {
    ...summary,
    ...backup,
    mutationResult,
    reconciliation,
    publicDateCountBefore,
    publicDateCountAfter,
    publicDelta: publicDateCountAfter - publicDateCountBefore,
  };
  const reportPath = path.join(path.dirname(backup.backupPath), "postapply-report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  fs.chmodSync(reportPath, 0o600);
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
