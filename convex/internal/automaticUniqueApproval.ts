import type { FunctionReference } from "convex/server";
import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import {
  AUTOMATIC_UNIQUE_APPROVAL_POLICY_VERSION,
  AUTOMATIC_UNIQUE_APPROVAL_RULE,
  hasAutomaticUniqueStructuredSourceAttestation,
  hasHumanReviewableStructuredSourceAttestation,
  nextEventUpdatedAt,
} from "../../lib/events/event-update-precondition";
import { buildEventOccurrenceIndexPatch } from "../sourceOccurrences";
import { hasCompleteAutomaticUniqueSourceProof } from "./automaticUniqueSourceProof";
import { buildPendingModerationUniquenessReview } from "../eventDomain/moderationUniqueness";
import {
  refreshCanonicalEventDerivedStates,
  writeEventAuditLog,
} from "../eventDomain/persistence";
import { assertPersistedServiceSourcePolicy } from "../eventDomain/sourceApproval";
import { requireCanonicalInstagramPostUrl } from "../eventDomain/sourceUrlPolicy";
import { isCanonicallyGroundedApprovedEvent } from "../publicEventGrounding";

const STATE_KEY = "automatic-unique-approval-v1" as const;
const PAGE_SIZE = 1;
const DEFAULT_MAX_PAGES = 60;
const MAX_PAGES = 300;
const COMPLETED_CYCLE_COOLDOWN_MS = 3 * 60 * 1_000;
const SYSTEM_ACTOR = "service:auto-unique";
const CLASSIFICATION_NOTE =
  "Automatic source and uniqueness verification; no human moderation is claimed.";
const VENUE_TOPOLOGY_FIELDS = [
  "venue",
  "venueId",
  "normalizedVenueIdentity",
  "normalizedVenueInstagramHandle",
] as const;

const sweepPageReference =
  "internal/automaticUniqueApproval:sweepPage" as unknown as FunctionReference<
    "mutation",
    "internal",
    Record<string, never>,
    {
      approvedCount: number;
      blocked: boolean;
      cycleComplete: boolean;
      scannedCount: number;
    }
  >;

function buildAutomaticFields(
  normalizedFieldsJson: string | undefined,
  canonicalVenue: string,
): string | null {
  let fields: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(normalizedFieldsJson ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    fields = parsed as Record<string, unknown>;
    if (
      fields.humanReviewedLegacySourcePolicyVersion !== undefined ||
      fields.humanReviewedStructuredSourcePolicyVersion !== undefined
    ) return null;
  } catch {
    return null;
  }
  return JSON.stringify({
    ...fields,
    normalizedVenue: canonicalVenue,
    automaticUniqueApprovalPolicyVersion: AUTOMATIC_UNIQUE_APPROVAL_POLICY_VERSION,
    ...(fields.sourceOccurrenceAmbiguousProvenance === true
      ? { automaticUniqueCollisionProofVersion: 1 }
      : {}),
    moderationAutoApproved: true,
    moderationAutoApproveRule: AUTOMATIC_UNIQUE_APPROVAL_RULE,
    moderationPendingReasons: [],
    moderationSignals: Array.isArray(fields.moderationSignals)
      ? fields.moderationSignals.filter(
          (signal) => signal !== "requires_human_approval",
        )
      : [],
  });
}

/** One transaction owns a single queue position and one possible approval. */
export const sweepPage = internalMutation({
  args: {},
  returns: v.object({
    approvedCount: v.number(),
    blocked: v.boolean(),
    cycleComplete: v.boolean(),
    scannedCount: v.number(),
  }),
  handler: async (ctx) => {
    const stateRows = await ctx.db
      .query("automaticUniqueApprovalState")
      .withIndex("by_key", (q) => q.eq("key", STATE_KEY))
      .take(2);
    if (stateRows.length > 1) {
      throw new Error("Automatic unique approval state is not a singleton.");
    }
    const state = stateRows[0] ?? null;
    // A completed scan need not reread the same historical pending rows on
    // every minute. New ingestions bypass the pause; edits to older rows are
    // retried after this short bound even if only their source was repaired.
    if (
      state?.cursor === null &&
      state.lastCycleCompletedAt !== undefined &&
      Date.now() - state.lastCycleCompletedAt < COMPLETED_CYCLE_COOLDOWN_MS
    ) {
      const newestPending = await ctx.db
        .query("events")
        .withIndex("by_status", (q) => q.eq("status", "pending"))
        .order("desc")
        .take(1);
      if (
        newestPending.length === 0 ||
        newestPending[0]!._creationTime <= state.lastCycleCompletedAt
      ) {
        return { approvedCount: 0, blocked: false, cycleComplete: true, scannedCount: 0 };
      }
    }
    const page = await ctx.db
      .query("events")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .order("desc")
      .paginate({ cursor: state?.cursor ?? null, numItems: PAGE_SIZE });
    if (page.pageStatus === "SplitRequired") {
      throw new Error("Automatic unique approval page requires a split.");
    }
    if (!page.isDone && (page.page.length === 0 || !page.continueCursor)) {
      throw new Error("Automatic unique approval pagination did not advance.");
    }

    let approvedCount = 0;
    let classificationErrorCount = 0;
    if (page.page.length > 0) {
      const event = page.page[0]!;
      // Classification and source policy can reject one malformed row. Keep
      // its pending status and advance the durable cursor; a later cycle may
      // retry it after source repair. Writes below remain outside this catch.
      const preflight = await (async () => {
        if (
          event.reviewedAt !== undefined ||
          event.reviewedBy !== undefined ||
          event.humanReviewedLegacySourcePolicyVersion !== undefined ||
          event.humanReviewedStructuredSourcePolicyVersion !== undefined
        ) return null;
        const review = await buildPendingModerationUniquenessReview(ctx, {
          items: [{ id: event._id, expectedUpdatedAt: event.updatedAt }],
          asOfMs: Date.now(),
          // This note is only an argument to the read-only classifier. No
          // human review note or human marker is persisted by this worker.
          moderationNote: CLASSIFICATION_NOTE,
        });
        const item = review.result.items[0];
        const approved = item?.disposition === "unique"
          ? review.approvals.get(event._id)
          : null;
        if (!approved) return null;
        const normalizedFieldsJson = buildAutomaticFields(
          event.normalizedFieldsJson,
          approved.prepared.candidate.venue,
        );
        if (!normalizedFieldsJson) return null;
        const nextCandidate = {
          ...approved.prepared.candidate,
          automaticUniqueApprovalPolicyVersion:
            AUTOMATIC_UNIQUE_APPROVAL_POLICY_VERSION as 1,
          normalizedFieldsJson,
        };
        // Approval changes only the event's moderation state. A venue identity
        // change rewrites occurrence topology and needs a separate certified
        // path; unrelated historical receipts must not block this local proof.
        if (VENUE_TOPOLOGY_FIELDS.some(
          (field) => event[field] !== nextCandidate[field],
        )) return null;
        if (
          !hasHumanReviewableStructuredSourceAttestation(
            nextCandidate.normalizedFieldsJson,
            nextCandidate,
          ) ||
          !hasAutomaticUniqueStructuredSourceAttestation(
            nextCandidate.normalizedFieldsJson,
            nextCandidate,
          ) ||
          !(await hasCompleteAutomaticUniqueSourceProof(ctx, event))
        ) return null;
        requireCanonicalInstagramPostUrl(
          nextCandidate.instagramPostUrl,
          `Automatic unique approval ${event._id}`,
        );
        await assertPersistedServiceSourcePolicy(ctx, nextCandidate, {
          allowHumanReviewedStructured: true,
        });
        return { approved, nextCandidate };
      })().catch((error: unknown) => {
        classificationErrorCount = 1;
        console.warn("Automatic unique approval skipped malformed candidate", {
          eventId: event._id,
          errorType: error instanceof Error ? error.name : "unknown",
        });
        return null;
      });
      if (preflight) {
        const { approved, nextCandidate } = preflight;
        const now = Date.now();
        await ctx.db.patch(event._id, {
          ...approved.prepared.venuePatch,
          automaticUniqueApprovalPolicyVersion:
            AUTOMATIC_UNIQUE_APPROVAL_POLICY_VERSION,
          normalizedFieldsJson: nextCandidate.normalizedFieldsJson,
          ...buildEventOccurrenceIndexPatch(nextCandidate),
          status: "approved",
          updatedAt: nextEventUpdatedAt(event.updatedAt, now),
        });
        await refreshCanonicalEventDerivedStates(ctx, [event._id]);
        const persisted = await ctx.db.get(event._id);
        if (!persisted || !(await isCanonicallyGroundedApprovedEvent(ctx, persisted))) {
          throw new Error("Automatic unique approval failed final public source proof.");
        }
        await writeEventAuditLog(ctx, event._id, "approved", {
          actor: SYSTEM_ACTOR,
          patch: {
            policy: AUTOMATIC_UNIQUE_APPROVAL_RULE,
            sourceOccurrenceKey: event.sourceOccurrenceKey,
          },
        });
        approvedCount = 1;
      }
    }

    const now = Date.now();
    const cycleComplete = page.isDone;
    const nextCursor = cycleComplete ? null : page.continueCursor;
    if (state) {
      await ctx.db.patch(state._id, {
        cursor: nextCursor,
        completedCycles: state.completedCycles + (cycleComplete ? 1 : 0),
        scannedCount: state.scannedCount + page.page.length,
        approvedCount: state.approvedCount + approvedCount,
        classificationErrorCount:
          (state.classificationErrorCount ?? 0) + classificationErrorCount,
        ...(cycleComplete ? { lastCycleCompletedAt: now } : {}),
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("automaticUniqueApprovalState", {
        key: STATE_KEY,
        cursor: nextCursor,
        completedCycles: cycleComplete ? 1 : 0,
        scannedCount: page.page.length,
        approvedCount,
        classificationErrorCount,
        ...(cycleComplete ? { lastCycleCompletedAt: now } : {}),
        createdAt: now,
        updatedAt: now,
      });
    }
    return {
      approvedCount,
      blocked: false,
      cycleComplete,
      scannedCount: page.page.length,
    };
  },
});

export const sweepUntilDone = internalAction({
  args: { maxPages: v.optional(v.number()) },
  returns: v.object({
    approvedCount: v.number(),
    blocked: v.boolean(),
    cycleComplete: v.boolean(),
    pagesRun: v.number(),
    scannedCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const maxPages = args.maxPages === undefined
      ? DEFAULT_MAX_PAGES
      : Math.max(1, Math.min(MAX_PAGES, Math.trunc(args.maxPages)));
    let approvedCount = 0;
    let scannedCount = 0;
    for (let pagesRun = 1; pagesRun <= maxPages; pagesRun += 1) {
      const result = await ctx.runMutation(sweepPageReference, {});
      approvedCount += result.approvedCount;
      scannedCount += result.scannedCount;
      if (result.blocked || result.cycleComplete) {
        return {
          approvedCount,
          blocked: result.blocked,
          cycleComplete: result.cycleComplete,
          pagesRun,
          scannedCount,
        };
      }
    }
    return {
      approvedCount,
      blocked: false,
      cycleComplete: false,
      pagesRun: maxPages,
      scannedCount,
    };
  },
});
