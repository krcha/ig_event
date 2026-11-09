import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { evaluateAutomaticUniqueApproval } from "./internal/automaticUniqueApprovalPreflight";
import { persistAutomaticUniqueApproval } from "./internal/automaticUniqueApproval";
import { loadPendingConflictRepairProof, preparePendingBenignSourceConflict, repairPendingBenignSourceConflictHandler } from "./internal/eventRepairs/pendingBenignSourceConflicts";
import { buildPendingSourceConflictContext, readBoundExtractionSourceConflicts } from "../lib/events/pending-source-conflict-reclassification";
import { partitionEventEvidenceSourceConflicts, selectEarlierConflictingStartTime, type EventEvidenceSourceConflict } from "../lib/events/event-evidence-conflict-policy";
import { nextEventUpdatedAt } from "../lib/events/event-update-precondition";
import { normalizeEventTime } from "../lib/events/event-time";
import { eventRepresentsExpectedOccurrence } from "./internal/sourceOccurrenceReceipts";
import { assertApprovalCandidatePolicy, assertHumanApprovalSourcePolicy } from "./eventDomain/sourceApproval";
import { resolveVenueForWrite } from "./venueResolver";
import { sourceOccurrenceProvenanceRepository } from "./repositories/sourceOccurrenceProvenance";
import { refreshCanonicalEventDerivedStates, writeEventAuditLog } from "./eventDomain/persistence";
import { isEventPubliclyVisible } from "./publicationPolicy";
import {
  previewPendingCinemaSourceConflictReclassificationHandler,
  reclassifyPendingCinemaSourceConflictsHandler,
} from "./internal/eventRepairs/pendingSourceConflictReclassification";

const version = v.object({
  id: v.id("events"),
  expectedUpdatedAt: v.number(),
  expectedNormalizedFieldsJson: v.string(),
  expectedSourceLinkId: v.id("instagramEventSources"),
  expectedSourceLinkUpdatedAt: v.number(),
});

export const preview = query({
  args: {
    sourceIdentity: v.string(),
    eventIds: v.array(v.id("events")),
    serviceSecret: v.string(),
  },
  returns: v.object({
    sourceIdentity: v.string(),
    expectedReceiptId: v.id("instagramSourceOccurrenceReceipts"),
    expectedReceiptUpdatedAt: v.number(),
    expectedSourceFingerprint: v.string(),
    items: v.array(
      v.object({
        id: v.id("events"),
        expectedUpdatedAt: v.number(),
        expectedNormalizedFieldsJson: v.string(),
        expectedSourceLinkId: v.id("instagramEventSources"),
        expectedSourceLinkUpdatedAt: v.number(),
        previousMaterialCount: v.number(),
        nextBenignCount: v.number(),
      }),
    ),
  }),
  handler: previewPendingCinemaSourceConflictReclassificationHandler,
});

export const apply = mutation({
  args: {
    sourceIdentity: v.string(),
    expectedReceiptId: v.id("instagramSourceOccurrenceReceipts"),
    expectedReceiptUpdatedAt: v.number(),
    expectedSourceFingerprint: v.string(),
    items: v.array(version),
    serviceSecret: v.string(),
  },
  returns: v.object({
    updatedCount: v.number(),
    receiptUpdatedAt: v.number(),
    updated: v.array(
      v.object({ id: v.id("events"), updatedAt: v.number() }),
    ),
  }),
  handler: reclassifyPendingCinemaSourceConflictsHandler,
});

const exactConflictArgs = {
  id: v.id("events"),
  expectedUpdatedAt: v.number(),
};

const exactConflictResult = v.object({
  outcome: v.union(v.literal("verified"), v.literal("approved"), v.literal("held"), v.literal("stale")),
  reason: v.string(),
  updatedAt: v.number(),
  reclassifiedCount: v.number(),
});

/** Dry run: same immutable evidence, source receipt and event version checks as recheckExact. */
export const previewExact = internalQuery({
  args: exactConflictArgs,
  returns: exactConflictResult,
  handler: async (ctx, exact) => {
    if (!Number.isSafeInteger(exact.expectedUpdatedAt)) throw new Error("Exact event version required.");
    const result = await preparePendingBenignSourceConflict(ctx, exact);
    if (result.outcome !== "verified") return result;
    return { outcome: "verified" as const, reason: "verified_benign_source_conflicts", updatedAt: result.event.updatedAt,
      reclassifiedCount: result.prepared.previousMaterialCount };
  },
});

/** Each call is fenced to one exact pending conflict; use the ordinary automatic publication gate. */
export const recheckExact = internalMutation({
  args: exactConflictArgs,
  returns: exactConflictResult,
  handler: async (ctx, exact) => {
    if (!Number.isSafeInteger(exact.expectedUpdatedAt)) throw new Error("Exact event version required.");
    const result = await repairPendingBenignSourceConflictHandler(ctx, { ...exact, actor: "service:source-conflict-recheck" });
    if (result.outcome !== "repaired") return result;
    const event = await ctx.db.get(exact.id);
    if (!event || event.status !== "pending" || event.updatedAt !== result.updatedAt) throw new Error("Conflict repair proof changed within transaction.");
    const evaluation = await evaluateAutomaticUniqueApproval(ctx, event);
    if (!evaluation.approval) return { ...result, outcome: "held" as const, reason: evaluation.diagnostic.holdReason };
    const approved = await persistAutomaticUniqueApproval(ctx, event, evaluation.approval);
    return { ...result, outcome: "approved" as const, reason: "verified_unique_public_event", updatedAt: approved.updatedAt };
  },
});

/** One explicitly reviewed display time; does not confirm the disputed clock. */
export const approveReviewedEarlierStart = internalMutation({
  args: { ...exactConflictArgs, expectedVenueId: v.id("venues"), selectedTime: v.string(), moderationNote: v.string(), dryRun: v.boolean() },
  returns: v.object({ outcome: v.union(v.literal("verified"), v.literal("approved")), updatedAt: v.number(), time: v.string() }),
  handler: async (ctx, args) => {
    if (!Number.isSafeInteger(args.expectedUpdatedAt) || !/^\d{2}:\d{2}$/u.test(args.selectedTime)) throw new Error("Exact reviewed event version and start required.");
    const moderationNote = args.moderationNote.trim();
    if (moderationNote.length < 20 || moderationNote.length > 1000) throw new Error("Substantive review note required.");
    const current = await ctx.db.get(args.id);
    if (!current || current.status !== "pending" || current.updatedAt !== args.expectedUpdatedAt) throw new Error("Reviewed pending event version changed.");
    const proof = await loadPendingConflictRepairProof(ctx, args.id);
    const { event, receipt, expected, source, link, occurrence } = proof;
    if (event.reviewedAt !== undefined || event.reviewedBy !== undefined ||
        event.humanReviewedLegacySourcePolicyVersion !== undefined || event.humanReviewedStructuredSourcePolicyVersion !== undefined ||
        receipt.expectedKeys.length !== 1 || normalizeEventTime(event.time).endLabel) {
      throw new Error("Reviewed start requires one unchanged, unreviewed occurrence.");
    }
    const fields = JSON.parse(event.normalizedFieldsJson ?? "null") as Record<string, unknown>;
    const raw = JSON.parse(event.rawExtractionJson ?? "null") as Record<string, unknown>;
    if (source.caption !== event.sourceCaption || fields.sourceGroundingSourceCaption !== event.sourceCaption ||
        fields.humanReviewedLegacySourcePolicyVersion !== undefined || fields.humanReviewedStructuredSourcePolicyVersion !== undefined ||
        fields.sourceOccurrenceAmbiguousProvenance === true || fields.sourceOccurrencePlanUnverified === true ||
        fields.dateEvidenceVerified !== true || fields.dateEvidenceResolvedDate !== event.date ||
        fields.identityEvidenceVerified !== true || fields.venueEvidenceVerified !== true) {
      throw new Error("Reviewed start requires independently verified date, identity and physical venue evidence.");
    }
    const conflicts = readBoundExtractionSourceConflicts(event, fields, raw);
    if (!Array.isArray(conflicts) || conflicts.some((c) => !c || typeof c.field !== "string" ||
        typeof c.poster_value !== "string" || typeof c.caption_value !== "string" || typeof c.reason !== "string") ||
        JSON.stringify(conflicts) !== JSON.stringify(fields.extractionSourceConflicts)) throw new Error("Reviewed start requires the exact retained conflict list.");
    const context = buildPendingSourceConflictContext(event, fields, raw);
    const partition = partitionEventEvidenceSourceConflicts(conflicts as EventEvidenceSourceConflict[], context);
    const timeConflict = partition.material.length === 1 ? partition.material[0] : undefined;
    const selection = timeConflict ? selectEarlierConflictingStartTime(timeConflict, context) : null;
    if (!selection || selection.time !== args.selectedTime || event.sourceConflictFields?.join(",") !== "time") {
      throw new Error("Selected start is not the earlier time of the one retained same-occurrence conflict.");
    }
    const venue = await resolveVenueForWrite(ctx, event.venue);
    if (venue.resolution.status !== "resolved" || venue.venueFields.venueId !== args.expectedVenueId || !venue.canonicalVenueName ||
        !venue.venueFields.venueLocation || (event.venueId && event.venueId !== args.expectedVenueId)) {
      throw new Error("Reviewed start requires a uniquely resolved public venue for the original physical claim.");
    }
    const timePatch = { time: selection.time, timeStatus: "inferred" as const, timeSource: selection.source,
      timeEvidenceText: selection.evidenceText, timeConfidence: 0, timeEvidenceKind: "start_time_stated" as const };
    const normalizedFieldsJson = JSON.stringify({ ...fields, ...timePatch, normalizedVenue: venue.canonicalVenueName,
      timeTbdApplied: false, timeEvidenceVerified: false, sourceGroundingTimeVerified: false, structuredEvidenceVerified: false,
      sourceConflictProvisionalStart: selection, moderationAutoApproved: false, moderationAutoApproveRule: null,
      moderationPendingReasons: [], reviewedSourceConflictStart: { policyVersion: 1, selection, previousTime: event.time ?? null } });
    const candidate = { ...event, ...venue.venueFields, ...timePatch, venue: venue.canonicalVenueName, normalizedFieldsJson };
    const reviewPatch = await assertHumanApprovalSourcePolicy(ctx, candidate, moderationNote);
    await assertApprovalCandidatePolicy(ctx, candidate, [event._id]);
    const approvedAt = Date.now();
    const updatedAt = nextEventUpdatedAt(event.updatedAt, approvedAt);
    const actor = "service:reviewed-source-start";
    const patch = { ...venue.venueFields, ...timePatch, venue: venue.canonicalVenueName, normalizedFieldsJson,
      ...reviewPatch, reviewedAt: approvedAt, reviewedBy: actor, moderationNote, status: "approved" as const, updatedAt };
    const representative = { ...event, ...patch };
    const nextExpected = { ...expected, time: selection.time, venue: venue.canonicalVenueName };
    if (!eventRepresentsExpectedOccurrence(representative, nextExpected)) throw new Error("Reviewed start would invalidate the occurrence receipt.");
    if (args.dryRun) return { outcome: "verified" as const, updatedAt: event.updatedAt, time: selection.time };

    await ctx.db.patch(event._id, patch);
    await ctx.db.patch(receipt._id, { expectedOccurrences: [nextExpected], updatedAt: nextEventUpdatedAt(receipt.updatedAt, approvedAt) });
    if (!(await sourceOccurrenceProvenanceRepository.updateSatisfiedOccurrenceFromExpected(ctx, { expected: nextExpected,
      representative, sourceFingerprint: receipt.sourceFingerprint, sourceLink: link, topologyEpochVerified: true }))) {
      throw new Error("Reviewed start lost its exact occurrence binding.");
    }
    await refreshCanonicalEventDerivedStates(ctx, [event._id]);
    const persisted = await ctx.db.get(event._id);
    if (!persisted || !(await isEventPubliclyVisible(ctx, persisted))) throw new Error("Reviewed event did not pass public publication checks.");
    await writeEventAuditLog(ctx, event._id, "approved_reviewed_earlier_source_start", { actor, note: moderationNote, patch: {
      policyVersion: 1, previousTime: event.time, selection, timeConflict, previousVenue: event.venue, venueId: args.expectedVenueId,
      sourceDocumentId: source._id, sourceRevision: source.sourceRevision ?? 1, sourceOccurrenceId: occurrence._id,
      sourceLinkId: link._id, receiptId: receipt._id, beforeUpdatedAt: event.updatedAt, updatedAt,
    } });
    return { outcome: "approved" as const, updatedAt, time: selection.time };
  },
});
