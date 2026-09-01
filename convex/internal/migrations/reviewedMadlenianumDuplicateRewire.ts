import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { writeEventAuditLog } from "../../eventDomain/persistence";
import { buildEventOccurrenceIndexPatch } from "../../sourceOccurrences";
import { exactJsonValue } from "../../../lib/events/exact-json-value";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../../lib/events/source-occurrence-representation";
import { markSourceOccurrenceTopologyMutation } from "../sourceOccurrenceTopologyEpoch";
import {
  recordEventDomainMigrationProgress,
  type EventDomainMigrationBatchArgs,
  type EventDomainMigrationBatchCounts,
} from "./eventDomainShared";

export const REVIEWED_MADLENIANUM_DUPLICATE_REWIRE_KEY =
  "reviewed-madlenianum-duplicate-source-rewire-v1";

const DUPLICATE_EVENT_ID = "j57dmmvenvj30pjy915j4dktn98cy8p5";
const PRIMARY_EVENT_ID = "j57bvxmxagvee6c0psbkxm7w958b36gm";
const DUPLICATE_PRE_APPLY_UPDATED_AT = 1_787_416_214_788;
const PRIMARY_PRE_APPLY_UPDATED_AT = 1_786_428_709_942;
const SOURCE_LINK_ID = "kx705hv9w29yqhg01d0cnvt7r18cyva6";
const RECEIPT_ID = "mh76wgeqyrak03jsqr0z82fb698cy4qb";
const SOURCE_IDENTITY = "instagram-source-identity-v1:DcS7mUtoz-f";
const SOURCE_FINGERPRINT =
  "instagram-source-v2:3a7c28ce01cb303467f0579069bbb477b911ac824c1b515ee47645abb0ff18c2";
const SOURCE_OCCURRENCE_KEY =
  "instagram-occurrence-v2:2da97c0656be2ce4a42fd5b15e32c95ac8cad1cbdd098ee70785c0aad54173e6";
const TARGET_TITLE = "„JA, EMA – Ljubavni život Eme Bovari";
const TARGET_ROW =
  "„JA, EMA – Ljubavni život Eme Bovari“ | Premijera: 29. septembar";
const VENUE_ID = "k177cby57143wkhs02n0q9d6rn896fff";
const VENUE_NAME = "Opera & Theater Madlenianum";
const VENUE_HANDLE = "madlenianum";
const DUPLICATE_AUDIT_ACTION = "reviewed_duplicate_venue_bound";
const PRIMARY_AUDIT_ACTION = "reviewed_duplicate_source_rewired";
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

function exactExpectedOccurrence(
  occurrence: Record<string, unknown> | undefined,
  venue: string,
): boolean {
  return Boolean(
    occurrence &&
      occurrence.key === SOURCE_OCCURRENCE_KEY &&
      occurrence.date === "2026-09-29" &&
      occurrence.time === "TBD" &&
      occurrence.venue === venue &&
      occurrence.title === TARGET_TITLE &&
      exactJsonValue(occurrence.artists, []),
  );
}

function exactPreApplyDuplicate(
  event: Doc<"events">,
  fields: Record<string, unknown>,
): boolean {
  const raw = parseObject(event.rawExtractionJson);
  const scheduleEntries = Array.isArray(raw?.schedule_entries)
    ? raw.schedule_entries.map(readObject).filter(Boolean)
    : [];
  return (
    event.updatedAt === DUPLICATE_PRE_APPLY_UPDATED_AT &&
    event.status === "rejected" &&
    event.title === TARGET_TITLE &&
    exactJsonValue(event.artists, []) &&
    event.date === "2026-09-29" &&
    event.time === "TBD" &&
    event.venue === "" &&
    !event.venueId &&
    event.sourceOccurrenceKey === SOURCE_OCCURRENCE_KEY &&
    event.moderationNote ===
      `Rejected as same_event_reannouncement of approved event ${PRIMARY_EVENT_ID}; exact date, time, source venue, and reviewed title identity match.` &&
    fields.extractionContractVersion === "event_evidence_v2" &&
    fields.venueEvidenceVerified === true &&
    fields.trustedVenueSource === true &&
    fields.venueSource === "handle_map" &&
    fields.sourceGroundingInstagramHandle === VENUE_HANDLE &&
    fields.normalizedVenue === "" &&
    fields.rowSourceText === TARGET_ROW &&
    !Object.hasOwn(fields, "reviewedDuplicateVenueRewire") &&
    scheduleEntries.length === 1 &&
    scheduleEntries[0]?.source_text === TARGET_ROW &&
    scheduleEntries[0]?.venue === VENUE_NAME
  );
}

function exactPrimary(event: Doc<"events">): boolean {
  return (
    event.updatedAt === PRIMARY_PRE_APPLY_UPDATED_AT &&
    event.status === "approved" &&
    event.date === "2026-09-29" &&
    event.time === "TBD" &&
    event.title === "Ja, Ema – Ljubavni život Eme Bovari" &&
    event.venue === VENUE_NAME &&
    String(event.venueId ?? "") === VENUE_ID &&
    event.venueInstagramHandle === VENUE_HANDLE
  );
}

function exactPostApplyDuplicate(
  event: Doc<"events">,
  fields: Record<string, unknown>,
): boolean {
  const marker = readObject(fields.reviewedDuplicateVenueRewire);
  return (
    event.updatedAt === DUPLICATE_PRE_APPLY_UPDATED_AT &&
    event.status === "rejected" &&
    event.venue === VENUE_NAME &&
    String(event.venueId ?? "") === VENUE_ID &&
    event.venueInstagramHandle === VENUE_HANDLE &&
    event.normalizedVenueIdentity === "opera theater madlenianum" &&
    event.normalizedVenueInstagramHandle === VENUE_HANDLE &&
    fields.normalizedVenue === VENUE_NAME &&
    marker?.operationId === REVIEWED_MADLENIANUM_DUPLICATE_REWIRE_KEY &&
    marker?.policyVersion === 1 &&
    marker?.primaryEventId === PRIMARY_EVENT_ID &&
    marker?.targetVenueId === VENUE_ID
  );
}

type Inspection = {
  duplicate: Doc<"events"> | null;
  duplicateFields: Record<string, unknown> | null;
  expectedOccurrence: Record<string, unknown> | null;
  issues: string[];
  link: Doc<"instagramEventSources"> | null;
  primary: Doc<"events"> | null;
  receipt: Doc<"instagramSourceOccurrenceReceipts"> | null;
  state: "blocked" | "post_apply" | "pre_apply";
};

async function inspectReviewedRewire(ctx: MutationCtx): Promise<Inspection> {
  const issues: string[] = [];
  const duplicateId = ctx.db.normalizeId("events", DUPLICATE_EVENT_ID);
  const primaryId = ctx.db.normalizeId("events", PRIMARY_EVENT_ID);
  const duplicate = duplicateId ? await ctx.db.get(duplicateId) : null;
  const primary = primaryId ? await ctx.db.get(primaryId) : null;
  const duplicateFields = duplicate
    ? parseObject(duplicate.normalizedFieldsJson)
    : null;
  if (!duplicate || !duplicateFields) issues.push("duplicate_event_mismatch");
  if (!primary || !exactPrimary(primary)) issues.push("primary_event_mismatch");

  const links = await ctx.db
    .query("instagramEventSources")
    .withIndex("by_source_occurrence", (q) =>
      q
        .eq("sourceIdentity", SOURCE_IDENTITY)
        .eq("sourceOccurrenceKey", SOURCE_OCCURRENCE_KEY),
    )
    .take(2);
  const link = links.length === 1 ? links[0]! : null;
  if (
    !link ||
    String(link._id) !== SOURCE_LINK_ID ||
    link.sourceFingerprint !== SOURCE_FINGERPRINT
  ) {
    issues.push("source_link_mismatch");
  }

  const receipts = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", SOURCE_IDENTITY))
    .take(2);
  const receipt = receipts.length === 1 ? receipts[0]! : null;
  const expected = receipt?.expectedOccurrences?.filter(
    (occurrence) => occurrence.key === SOURCE_OCCURRENCE_KEY,
  );
  const satisfied = receipt?.satisfiedOccurrences.filter(
    (occurrence) => occurrence.key === SOURCE_OCCURRENCE_KEY,
  );
  const expectedOccurrence =
    expected?.length === 1
      ? (expected[0] as unknown as Record<string, unknown>)
      : null;
  if (
    !receipt ||
    String(receipt._id) !== RECEIPT_ID ||
    receipt.sourceFingerprint !== SOURCE_FINGERPRINT ||
    expected?.length !== 1 ||
    satisfied?.length !== 1
  ) {
    issues.push("source_receipt_mismatch");
  }

  const occurrences = await ctx.db
    .query("sourceOccurrences")
    .withIndex("by_source_occurrence", (q) =>
      q
        .eq("sourceIdentity", SOURCE_IDENTITY)
        .eq("sourceOccurrenceKey", SOURCE_OCCURRENCE_KEY),
    )
    .take(1);
  if (occurrences.length !== 0) issues.push("unexpected_first_class_occurrence");

  const duplicateAudits = duplicateId
    ? await ctx.db
        .query("eventAuditLog")
        .withIndex("by_event", (q) => q.eq("eventId", duplicateId))
        .take(MAX_EVENT_AUDIT_ROWS + 1)
    : [];
  const primaryAudits = primaryId
    ? await ctx.db
        .query("eventAuditLog")
        .withIndex("by_event", (q) => q.eq("eventId", primaryId))
        .take(MAX_EVENT_AUDIT_ROWS + 1)
    : [];
  if (
    duplicateAudits.length > MAX_EVENT_AUDIT_ROWS ||
    primaryAudits.length > MAX_EVENT_AUDIT_ROWS
  ) {
    issues.push("event_audit_bound_exceeded");
  }
  const duplicateMatches = duplicateAudits.filter(
    (audit) => audit.action === DUPLICATE_AUDIT_ACTION,
  );
  const primaryMatches = primaryAudits.filter(
    (audit) => audit.action === PRIMARY_AUDIT_ACTION,
  );

  const preApply = Boolean(
    duplicate &&
      duplicateFields &&
      duplicateId &&
      link?.eventId === duplicateId &&
      exactPreApplyDuplicate(duplicate, duplicateFields) &&
      exactExpectedOccurrence(expectedOccurrence ?? undefined, "") &&
      satisfied?.[0]?.eventId === duplicateId &&
      duplicateMatches.length === 0 &&
      primaryMatches.length === 0,
  );
  const postApply = Boolean(
    duplicate &&
      duplicateFields &&
      primary &&
      primaryId &&
      link?.eventId === primaryId &&
      exactPostApplyDuplicate(duplicate, duplicateFields) &&
      exactExpectedOccurrence(expectedOccurrence ?? undefined, VENUE_NAME) &&
      satisfied?.[0]?.eventId === primaryId &&
      sourceOccurrenceRepresentativeMatchesExpected(
        primary,
        expectedOccurrence as Parameters<
          typeof sourceOccurrenceRepresentativeMatchesExpected
        >[1],
      ) &&
      duplicateMatches.length === 1 &&
      primaryMatches.length === 1,
  );
  if (issues.length === 0 && !preApply && !postApply) {
    issues.push("target_state_unrecognized");
  }
  return {
    duplicate,
    duplicateFields,
    expectedOccurrence,
    issues,
    link,
    primary,
    receipt,
    state:
      issues.length > 0 ? "blocked" : postApply ? "post_apply" : "pre_apply",
  };
}

export async function rewireReviewedMadlenianumDuplicateHandler(
  ctx: MutationCtx,
  args: EventDomainMigrationBatchArgs,
) {
  const dryRun = args.dryRun ?? true;
  const inspection = await inspectReviewedRewire(ctx);
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
    inspection.duplicate &&
    inspection.duplicateFields &&
    inspection.expectedOccurrence &&
    inspection.link &&
    inspection.primary &&
    inspection.receipt
  ) {
    const primaryId = inspection.primary._id;
    const now = Math.max(
      Date.now(),
      inspection.duplicate.updatedAt + 1,
      inspection.primary.updatedAt + 1,
    );
    const normalizedFieldsJson = JSON.stringify({
      ...inspection.duplicateFields,
      normalizedVenue: VENUE_NAME,
      reviewedDuplicateVenueRewire: {
        operationId: REVIEWED_MADLENIANUM_DUPLICATE_REWIRE_KEY,
        policyVersion: 1,
        primaryEventId: PRIMARY_EVENT_ID,
        targetVenueId: VENUE_ID,
      },
    });
    const effectiveDuplicate: Doc<"events"> = {
      ...inspection.duplicate,
      normalizedFieldsJson,
      normalizedVenueIdentity: "opera theater madlenianum",
      normalizedVenueInstagramHandle: VENUE_HANDLE,
      venue: VENUE_NAME,
      venueCategory: "venue",
      venueId: VENUE_ID as Doc<"events">["venueId"],
      venueInstagramHandle: VENUE_HANDLE,
    };
    const expectedOccurrences = inspection.receipt.expectedOccurrences!.map(
      (occurrence) =>
        occurrence.key === SOURCE_OCCURRENCE_KEY
          ? { ...occurrence, venue: VENUE_NAME }
          : occurrence,
    );
    const satisfiedOccurrences = inspection.receipt.satisfiedOccurrences.map(
      (occurrence) =>
        occurrence.key === SOURCE_OCCURRENCE_KEY
          ? { ...occurrence, eventId: primaryId }
          : occurrence,
    );
    const nextExpected = expectedOccurrences.find(
      (occurrence) => occurrence.key === SOURCE_OCCURRENCE_KEY,
    );
    if (
      !nextExpected ||
      !sourceOccurrenceRepresentativeMatchesExpected(
        inspection.primary,
        nextExpected,
      )
    ) {
      throw new Error("Reviewed Madlenianum rewire lost primary receipt proof.");
    }
    await ctx.db.patch(inspection.duplicate._id, {
      normalizedFieldsJson,
      normalizedVenueIdentity: effectiveDuplicate.normalizedVenueIdentity,
      normalizedVenueInstagramHandle:
        effectiveDuplicate.normalizedVenueInstagramHandle,
      venue: VENUE_NAME,
      venueCategory: "venue",
      venueId: effectiveDuplicate.venueId,
      venueInstagramHandle: VENUE_HANDLE,
      ...buildEventOccurrenceIndexPatch(effectiveDuplicate),
    });
    await ctx.db.patch(inspection.link._id, {
      eventId: primaryId,
      updatedAt: now,
    });
    await ctx.db.patch(inspection.receipt._id, {
      expectedOccurrences,
      satisfiedOccurrences,
      updatedAt: now,
    });
    const auditPatch = {
      duplicateEventId: DUPLICATE_EVENT_ID,
      operationId: REVIEWED_MADLENIANUM_DUPLICATE_REWIRE_KEY,
      policyVersion: 1,
      primaryEventId: PRIMARY_EVENT_ID,
      receiptId: RECEIPT_ID,
      sourceLinkId: SOURCE_LINK_ID,
      sourceOccurrenceKey: SOURCE_OCCURRENCE_KEY,
      targetVenueId: VENUE_ID,
    };
    await writeEventAuditLog(
      ctx,
      inspection.duplicate._id,
      DUPLICATE_AUDIT_ACTION,
      { actor: REVIEWED_MADLENIANUM_DUPLICATE_REWIRE_KEY, patch: auditPatch },
    );
    await writeEventAuditLog(ctx, primaryId, PRIMARY_AUDIT_ACTION, {
      actor: REVIEWED_MADLENIANUM_DUPLICATE_REWIRE_KEY,
      patch: auditPatch,
    });
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
    key: REVIEWED_MADLENIANUM_DUPLICATE_REWIRE_KEY,
    phase: "reviewed_duplicate_source_rewire",
    restart: args.restart ?? false,
  });
  return {
    ...counts,
    continueCursor: "",
    dryRun,
    isDone: true,
  };
}
