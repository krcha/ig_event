import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { EVENT_DISCOVERY_VERSION } from "../lib/taxonomy/event-discovery";
import { nextEventUpdatedAt } from "../lib/events/event-update-precondition";
import {
  loadProgramme,
  required,
  theatreProgramme,
} from "./internal/eventRepairs/reviewedNovemberProgrammes";
import {
  reassignSavedEventReferences,
  writeEventAuditLog,
} from "./eventDomain/persistence";
import { refreshEventPublicationStates } from "./publicationPolicy";
import {
  assertReconciliationReceiptSatisfiable,
  loadReconciliationSourceDocument,
  upsertReconciliationProvenance,
} from "./repositories/reconciliationSourceContext";
import { markSourceOccurrenceTopologyMutation } from "./internal/sourceOccurrenceTopologyEpoch";

const caseValue = v.union(
  v.literal("bitef"),
  v.literal("bristol27"),
  v.literal("bristol28"),
);
const result = v.object({
  digest: v.string(),
  applied: v.boolean(),
  primaryId: v.id("events"),
  secondaryId: v.id("events"),
});
function summary(data: Awaited<ReturnType<typeof loadProgramme>>) {
  return {
    digest: data.digest,
    applied: data.applied,
    primaryId: data.primary._id,
    secondaryId: data.duplicate._id,
  };
}

export const preview = internalQuery({
  args: { which: caseValue },
  returns: result,
  handler: async (ctx, { which }) => summary(await loadProgramme(ctx, which)),
});

export const apply = internalMutation({
  args: { which: caseValue, expectedDigest: v.string() },
  returns: result,
  handler: async (ctx, { which, expectedDigest }) => {
    const state = await loadProgramme(ctx, which);
    if (state.applied) return summary(state);
    required(state.digest === expectedDigest, "changed since preview");
    const { primary, duplicate, early, kre, main, extra } = state;
    const affected = [primary._id, duplicate._id];
    if (which === "bitef") {
      for (const [n, event] of [kre, early].entries()) {
        const occurrence = main.occurrences[n];
        if (occurrence.state === "satisfied") continue;
        const sourceDocument = await loadReconciliationSourceDocument(
          ctx,
          occurrence,
        );
        required(sourceDocument, "weekly theatre programme is missing");
        await assertReconciliationReceiptSatisfiable({
          ctx,
          occurrence,
          targetEventId: event._id,
        });
        await upsertReconciliationProvenance({
          ctx,
          eventId: event._id,
          occurrence,
          sourceDocument,
        });
        await ctx.db.patch(occurrence._id, {
          canonicalEventId: event._id,
          state: "satisfied",
          updatedAt: nextEventUpdatedAt(occurrence.updatedAt),
        });
        affected.push(event._id);
      }
      await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
    }
    const updatedAt = nextEventUpdatedAt(primary.updatedAt);
    const timePatch =
      which === "bitef"
        ? {
            timeEvidenceText: "21.00",
            normalizedFieldsJson: JSON.stringify({
              ...JSON.parse(primary.normalizedFieldsJson!),
              timeEvidenceText: "21.00",
            }),
          }
        : {};
    await ctx.db.patch(primary._id, {
      ...timePatch,
      reviewedSourceUpdate: state.sourceUpdate,
      updatedAt,
    });
    // The event did not change date, time, performers, activity, or programme.
    // Preserve current evidence revisions while adding its second source URL.
    for (const table of [
      "eventDiscoveryLabels",
      "eventPerformerGenreResearch",
    ] as const) {
      const proof = await ctx.db
        .query(table)
        .withIndex("by_eventId", (q) => q.eq("eventId", primary._id))
        .unique();
      if (proof?.eventUpdatedAt === primary.updatedAt)
        await ctx.db.patch(proof._id, { eventUpdatedAt: updatedAt });
    }
    if (which === "bitef") {
      for (const [i, event] of [early, primary].entries()) {
        const previous = state.labels[i];
        const taxonomy = previous?.taxonomy ?? {
          primaryCategory: "culture" as const,
          categories: ["culture" as const],
          genres: [],
          formats: [],
        };
        const value = {
          eventId: event._id,
          eventUpdatedAt:
            event._id === primary._id ? updatedAt : event.updatedAt,
          version: EVENT_DISCOVERY_VERSION,
          model: theatreProgramme.review,
          taxonomy: {
            ...taxonomy,
            formats: [...new Set([...taxonomy.formats, "theatre" as const])],
          },
          auditJson: JSON.stringify({
            ...JSON.parse(previous?.auditJson ?? "{}"),
            reviewedProgramme: {
              ...theatreProgramme,
              listingUrl: event.instagramPostUrl,
              listingRow: JSON.parse(event.normalizedFieldsJson!).rowSourceText,
              reviewedAt: Date.now(),
              previousModel: previous?.model ?? null,
            },
          }),
        };
        if (previous) await ctx.db.patch(previous._id, value);
        else await ctx.db.insert("eventDiscoveryLabels", value);
      }
    }
    await ctx.db.patch(duplicate._id, {
      reviewedDuplicateOf: primary._id,
      updatedAt: nextEventUpdatedAt(duplicate.updatedAt),
    });
    const saved = await reassignSavedEventReferences(
      ctx,
      duplicate._id,
      primary._id,
    );
    await refreshEventPublicationStates(ctx, affected);
    const patch = {
      which,
      primaryId: primary._id,
      secondaryId: duplicate._id,
      originalSources: [main.url, extra.url],
      saved,
      expectedDigest,
      officialVenueUrl:
        which === "bitef"
          ? theatreProgramme.identityUrl
          : "https://elizabeth.rs/en/",
    };
    for (const event of [primary, duplicate])
      await writeEventAuditLog(
        ctx,
        event._id,
        "reviewed_programme_representative",
        { actor: "reviewed-november-programmes", patch },
      );
    const after = await loadProgramme(ctx, which);
    required(after.applied, "post-commit conditions were not met");
    return summary(after);
  },
});
