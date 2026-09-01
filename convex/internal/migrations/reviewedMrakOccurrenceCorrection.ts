import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { writeEventAuditLog } from "../../eventDomain/persistence";
import { markSourceOccurrenceTopologyMutation } from "../sourceOccurrenceTopologyEpoch";
import { buildEventOccurrenceIndexPatch } from "../../sourceOccurrences";
import { exactJsonValue } from "../../../lib/events/exact-json-value";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../../lib/events/source-occurrence-representation";
import {
  recordEventDomainMigrationProgress,
  type EventDomainMigrationBatchArgs,
  type EventDomainMigrationBatchCounts,
} from "./eventDomainShared";

export const REVIEWED_MRAK_OCCURRENCE_CORRECTION_KEY =
  "reviewed-mrak-source-occurrence-correction-v1";

const TARGET_EVENT_ID = "j57ev5k2p036j2g69zjv16a7th8cxac9";
const TARGET_EVENT_PRE_APPLY_UPDATED_AT = 1_787_599_918_040;
const TARGET_LINK_ID = "kx7dsz84qr55zyz89daen71ayd8cwd3b";
const TARGET_RECEIPT_ID = "mh73hxccz95prkpvdhnh6t04dd8cws2r";
const TARGET_SOURCE_IDENTITY = "instagram-source-identity-v1:DcQ1OaZDLOP";
const TARGET_SOURCE_OCCURRENCE_KEY =
  "instagram-occurrence-v2:470cd78d69181c6163754826bb4dff5535a2c274675c0cb5fa0acc134e370e3a";
const TARGET_SOURCE_ROW = "BLACK ROOM\n@lirikadare";
const TARGET_TITLE = "Lirikadare";
const AUDIT_ACTION = "reviewed_source_occurrence_corrected";
const AUDIT_NOTE =
  "Human-reviewed source-occurrence correction: the Lirikadare receipt row was previously persisted as a duplicate Cerqeta event.";
const MAX_EVENT_AUDIT_ROWS = 100;

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseObject(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return readObject(JSON.parse(value));
  } catch {
    return null;
  }
}

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && exactJsonValue(value, expected);
}

function sourceEvidenceContainsTargetRow(event: Doc<"events">): boolean {
  const raw = parseObject(event.rawExtractionJson);
  const entries = Array.isArray(raw?.schedule_entries)
    ? raw.schedule_entries.map(readObject).filter(Boolean)
    : [];
  const matches = entries.filter(
    (entry) =>
      entry?.source_text === TARGET_SOURCE_ROW &&
      entry?.title === "@lirikadare" &&
      entry?.date === "04.09.2026" &&
      entry?.time === "" &&
      entry?.venue === "Club Drugstore" &&
      exactStringArray(entry?.artists, ["@lirikadare"]),
  );
  return matches.length === 1;
}

function normalizedPreApplyEvidenceIsExact(
  event: Doc<"events">,
  fields: Record<string, unknown>,
): boolean {
  return (
    event.updatedAt === TARGET_EVENT_PRE_APPLY_UPDATED_AT &&
    event.status === "approved" &&
    event.title === "Cerqeta" &&
    exactJsonValue(event.artists, ["Cerqeta"]) &&
    event.date === "2026-09-04" &&
    event.time === "TBD" &&
    event.venue === "" &&
    event.description === "Black Room set" &&
    event.sourceOccurrenceKey === TARGET_SOURCE_OCCURRENCE_KEY &&
    fields.extractionContractVersion === "event_evidence_v2" &&
    fields.venueEvidenceVerified === true &&
    fields.sourceOccurrenceAmbiguousProvenance === true &&
    fields.sourceOccurrenceKey === TARGET_SOURCE_OCCURRENCE_KEY &&
    fields.title === "Cerqeta" &&
    exactStringArray(fields.artists, ["Cerqeta"]) &&
    fields.splitEventIndex === 5 &&
    fields.rowSourceText === "BLACK ROOM\n@cerqeta" &&
    !Object.hasOwn(fields, "reviewedSourceOccurrenceCorrection") &&
    sourceEvidenceContainsTargetRow(event)
  );
}

function reviewedMarkerIsExact(fields: Record<string, unknown>): boolean {
  const marker = readObject(fields.reviewedSourceOccurrenceCorrection);
  return Boolean(
    marker &&
      marker.operationId === REVIEWED_MRAK_OCCURRENCE_CORRECTION_KEY &&
      marker.policyVersion === 1 &&
      marker.sourceOccurrenceKey === TARGET_SOURCE_OCCURRENCE_KEY &&
      marker.fromTitle === "Cerqeta" &&
      marker.toTitle === TARGET_TITLE,
  );
}

function reviewedVenueStateIsExact(
  event: Doc<"events">,
  expected: NonNullable<
    Doc<"instagramSourceOccurrenceReceipts">["expectedOccurrences"]
  >[number],
  fields: Record<string, unknown>,
): boolean {
  if (!expected.venue) return event.venue === "";
  if (event.venue !== expected.venue || fields.normalizedVenue !== expected.venue) {
    return false;
  }
  const normalization = readObject(fields.auditedLegacyVenueNormalization);
  if (
    normalization?.policyVersion === 1 &&
    normalization.sourcePolicy ===
      "exact_schedule_entry_event_evidence_v2" &&
    typeof normalization.normalizedVenueIdentity === "string" &&
    normalization.normalizedVenueIdentity === event.normalizedVenueIdentity &&
    event.occurrenceVenueIdentity ===
      `name:${normalization.normalizedVenueIdentity}`
  ) {
    return true;
  }
  const canonicalization = readObject(
    fields.auditedLegacyVenueCanonicalization,
  );
  return Boolean(
    canonicalization?.policyVersion === 1 &&
      canonicalization.sourcePolicy ===
        "exact_schedule_entry_event_evidence_v2" &&
      typeof canonicalization.targetVenueId === "string" &&
      canonicalization.targetVenueId === event.venueId &&
      event.occurrenceVenueIdentity ===
        `id:${canonicalization.targetVenueId}`,
  );
}

function auditMatchesPostApply(
  event: Doc<"events">,
  audit: Doc<"eventAuditLog">,
): boolean {
  if (!audit.patchJson) return false;
  const patch = parseObject(audit.patchJson);
  const before = readObject(patch?.eventBefore);
  const after = readObject(patch?.eventAfter);
  const afterFields =
    typeof after?.normalizedFieldsJson === "string"
      ? parseObject(after.normalizedFieldsJson)
      : null;
  return Boolean(
    patch &&
      patch.operationId === REVIEWED_MRAK_OCCURRENCE_CORRECTION_KEY &&
      patch.policyVersion === 1 &&
      patch.sourceLinkId === TARGET_LINK_ID &&
      patch.receiptId === TARGET_RECEIPT_ID &&
      before?.updatedAt === TARGET_EVENT_PRE_APPLY_UPDATED_AT &&
      before?.title === "Cerqeta" &&
      exactStringArray(before?.artists, ["Cerqeta"]) &&
      after?.updatedAt === event.updatedAt &&
      after?.title === TARGET_TITLE &&
      exactStringArray(after?.artists, [TARGET_TITLE]) &&
      afterFields &&
      afterFields.title === TARGET_TITLE &&
      exactStringArray(afterFields.artists, [TARGET_TITLE]) &&
      afterFields.splitEventIndex === 4 &&
      afterFields.rowSourceText === TARGET_SOURCE_ROW &&
      afterFields.splitSourceLine === TARGET_SOURCE_ROW &&
      reviewedMarkerIsExact(afterFields),
  );
}

type Inspection = {
  auditRows: Doc<"eventAuditLog">[];
  event: Doc<"events"> | null;
  expected: NonNullable<
    Doc<"instagramSourceOccurrenceReceipts">["expectedOccurrences"]
  >[number] | null;
  fields: Record<string, unknown> | null;
  issues: string[];
  link: Doc<"instagramEventSources"> | null;
  receipt: Doc<"instagramSourceOccurrenceReceipts"> | null;
  state: "blocked" | "post_apply" | "pre_apply";
};

async function inspectReviewedMrakCorrection(
  ctx: MutationCtx,
): Promise<Inspection> {
  const issues: string[] = [];
  const targetId = ctx.db.normalizeId("events", TARGET_EVENT_ID);
  const event = targetId ? await ctx.db.get(targetId) : null;
  if (!event) issues.push("target_event_missing");

  const links = targetId
    ? await ctx.db
        .query("instagramEventSources")
        .withIndex("by_event", (q) => q.eq("eventId", targetId))
        .take(2)
    : [];
  const link = links.length === 1 ? links[0]! : null;
  if (
    !link ||
    String(link._id) !== TARGET_LINK_ID ||
    link.sourceIdentity !== TARGET_SOURCE_IDENTITY ||
    link.sourceOccurrenceKey !== TARGET_SOURCE_OCCURRENCE_KEY
  ) {
    issues.push("source_link_mismatch");
  }

  const receiptRows = link
    ? await ctx.db
        .query("instagramSourceOccurrenceReceipts")
        .withIndex("by_sourceIdentity", (q) =>
          q.eq("sourceIdentity", link.sourceIdentity),
        )
        .take(2)
    : [];
  const receipt = receiptRows.length === 1 ? receiptRows[0]! : null;
  if (
    !receipt ||
    String(receipt._id) !== TARGET_RECEIPT_ID ||
    receipt.sourceFingerprint !== link?.sourceFingerprint
  ) {
    issues.push("source_receipt_mismatch");
  }
  const expectedMatches = receipt?.expectedOccurrences?.filter(
    (occurrence) => occurrence.key === TARGET_SOURCE_OCCURRENCE_KEY,
  );
  const satisfiedMatches = receipt?.satisfiedOccurrences.filter(
    (occurrence) => occurrence.key === TARGET_SOURCE_OCCURRENCE_KEY,
  );
  const expected = expectedMatches?.length === 1 ? expectedMatches[0]! : null;
  if (
    !expected ||
    expected.title !== TARGET_TITLE ||
    !exactJsonValue(expected.artists, [TARGET_TITLE]) ||
    expected.date !== "2026-09-04" ||
    expected.time !== "TBD" ||
    satisfiedMatches?.length !== 1 ||
    satisfiedMatches[0]!.eventId !== targetId
  ) {
    issues.push("source_receipt_occurrence_mismatch");
  }

  const occurrenceRows = link
    ? await ctx.db
        .query("sourceOccurrences")
        .withIndex("by_source_occurrence", (q) =>
          q
            .eq("sourceIdentity", link.sourceIdentity)
            .eq("sourceOccurrenceKey", link.sourceOccurrenceKey),
        )
        .take(2)
    : [];
  if (
    occurrenceRows.length > 1 ||
    (occurrenceRows.length === 1 &&
      (occurrenceRows[0]!.canonicalEventId !== targetId ||
        occurrenceRows[0]!.state !== "satisfied"))
  ) {
    issues.push("first_class_occurrence_mismatch");
  }

  const auditRows = targetId
    ? await ctx.db
        .query("eventAuditLog")
        .withIndex("by_event", (q) => q.eq("eventId", targetId))
        .take(MAX_EVENT_AUDIT_ROWS + 1)
    : [];
  if (auditRows.length > MAX_EVENT_AUDIT_ROWS) {
    issues.push("event_audit_bound_exceeded");
  }
  const matchingAudits = auditRows.filter(
    (audit) => audit.action === AUDIT_ACTION,
  );
  const fields = event ? parseObject(event.normalizedFieldsJson) : null;
  const preApply = Boolean(
    event &&
      fields &&
      expected &&
      matchingAudits.length === 0 &&
      normalizedPreApplyEvidenceIsExact(event, fields) &&
      !sourceOccurrenceRepresentativeMatchesExpected(event, expected),
  );
  const postApply = Boolean(
    event &&
      fields &&
      expected &&
      matchingAudits.length === 1 &&
      event.status === "approved" &&
      event.title === TARGET_TITLE &&
      exactJsonValue(event.artists, [TARGET_TITLE]) &&
      event.date === expected.date &&
      event.time === expected.time &&
      event.venue === expected.venue &&
      event.sourceOccurrenceKey === expected.key &&
      fields.title === TARGET_TITLE &&
      exactStringArray(fields.artists, [TARGET_TITLE]) &&
      fields.splitEventIndex === 4 &&
      fields.rowSourceText === TARGET_SOURCE_ROW &&
      fields.splitSourceLine === TARGET_SOURCE_ROW &&
      reviewedMarkerIsExact(fields) &&
      reviewedVenueStateIsExact(event, expected, fields) &&
      sourceOccurrenceRepresentativeMatchesExpected(event, expected) &&
      auditMatchesPostApply(event, matchingAudits[0]!),
  );
  if (issues.length === 0 && !preApply && !postApply) {
    issues.push("target_state_unrecognized");
  }
  return {
    auditRows: matchingAudits,
    event,
    expected,
    fields,
    issues,
    link,
    receipt,
    state:
      issues.length > 0 ? "blocked" : postApply ? "post_apply" : "pre_apply",
  };
}

export async function correctReviewedMrakSourceOccurrenceHandler(
  ctx: MutationCtx,
  args: EventDomainMigrationBatchArgs,
) {
  const dryRun = args.dryRun ?? true;
  const inspection = await inspectReviewedMrakCorrection(ctx);
  const counts: EventDomainMigrationBatchCounts = {
    errorCount: 0,
    mismatchCount: inspection.issues.length,
    scannedCount: 1,
    unchangedCount: inspection.state === "post_apply" ? 1 : 0,
    updatedCount: inspection.state === "pre_apply" ? 1 : 0,
  };
  if (
    !dryRun &&
    inspection.state === "pre_apply" &&
    inspection.event &&
    inspection.fields &&
    inspection.expected &&
    inspection.link &&
    inspection.receipt
  ) {
    const now = Math.max(Date.now(), inspection.event.updatedAt + 1);
    const normalizedFieldsJson = JSON.stringify({
      ...inspection.fields,
      artists: [TARGET_TITLE],
      reviewedSourceOccurrenceCorrection: {
        fromTitle: "Cerqeta",
        operationId: REVIEWED_MRAK_OCCURRENCE_CORRECTION_KEY,
        policyVersion: 1,
        sourceOccurrenceKey: TARGET_SOURCE_OCCURRENCE_KEY,
        toTitle: TARGET_TITLE,
      },
      rowSourceText: TARGET_SOURCE_ROW,
      splitEventIndex: 4,
      splitSourceLine: TARGET_SOURCE_ROW,
      title: TARGET_TITLE,
    });
    const effectiveEvent: Doc<"events"> = {
      ...inspection.event,
      artists: [TARGET_TITLE],
      moderationNote: AUDIT_NOTE,
      normalizedFieldsJson,
      reviewedAt: now,
      reviewedBy: REVIEWED_MRAK_OCCURRENCE_CORRECTION_KEY,
      title: TARGET_TITLE,
      updatedAt: now,
    };
    if (
      !sourceOccurrenceRepresentativeMatchesExpected(
        effectiveEvent,
        inspection.expected,
      )
    ) {
      throw new Error("Reviewed MRAK correction lost its receipt proof.");
    }
    await ctx.db.patch(inspection.event._id, {
      artists: effectiveEvent.artists,
      moderationNote: effectiveEvent.moderationNote,
      normalizedFieldsJson,
      reviewedAt: now,
      reviewedBy: effectiveEvent.reviewedBy,
      title: TARGET_TITLE,
      updatedAt: now,
      ...buildEventOccurrenceIndexPatch(effectiveEvent),
    });
    await writeEventAuditLog(
      ctx,
      inspection.event._id,
      AUDIT_ACTION,
      {
        actor: REVIEWED_MRAK_OCCURRENCE_CORRECTION_KEY,
        note: AUDIT_NOTE,
        patch: {
          eventAfter: {
            artists: effectiveEvent.artists,
            normalizedFieldsJson,
            title: TARGET_TITLE,
            updatedAt: now,
          },
          eventBefore: {
            artists: inspection.event.artists,
            normalizedFieldsJson: inspection.event.normalizedFieldsJson,
            title: inspection.event.title,
            updatedAt: inspection.event.updatedAt,
          },
          operationId: REVIEWED_MRAK_OCCURRENCE_CORRECTION_KEY,
          policyVersion: 1,
          receiptId: String(inspection.receipt._id),
          sourceLinkId: String(inspection.link._id),
        },
      },
    );
    await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
  }
  await recordEventDomainMigrationProgress({
    counts,
    ctx,
    cursor: "",
    detailJson: JSON.stringify({
      issues: inspection.issues,
      state: inspection.state,
    }),
    dryRun,
    inputCursor: args.cursor ?? null,
    isDone: true,
    key: REVIEWED_MRAK_OCCURRENCE_CORRECTION_KEY,
    phase: "reviewed_source_occurrence_correction",
    restart: args.restart ?? false,
  });
  return {
    ...counts,
    continueCursor: "",
    dryRun,
    isDone: true,
  };
}
