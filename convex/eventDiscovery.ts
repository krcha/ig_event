import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { requireAdminOrServiceSecret } from "./authz";
import { eventDiscoveryTaxonomy } from "./eventDiscoveryValues";
import { readEventEvidenceRecord } from "../lib/events/confirmed-event-schema-facts";
import { EVENT_DISCOVERY_VERSION } from "../lib/taxonomy/event-discovery";

const eventInput = v.object({
  key: v.id("events"),
  expectedUpdatedAt: v.number(),
  title: v.string(),
  description: v.optional(v.string()),
  occurrenceText: v.optional(v.string()),
  venue: v.string(),
  artists: v.array(v.string()),
});

function loadLabel(ctx: Pick<QueryCtx, "db">, eventId: Id<"events">) {
  return ctx.db.query("eventDiscoveryLabels")
    .withIndex("by_eventId", (q) => q.eq("eventId", eventId)).unique();
}

export async function loadPublicEventDiscoveryTaxonomy(
  ctx: QueryCtx,
  event: { _id: Id<"events">; updatedAt: number },
) {
  const label = await loadLabel(ctx, event._id);
  return label?.version === EVENT_DISCOVERY_VERSION &&
    label.eventUpdatedAt === event.updatedAt
    ? label.taxonomy ?? undefined : undefined;
}

export const listRecentInputs = query({
  args: { serviceSecret: v.string(), cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    events: v.array(eventInput),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { serviceSecret, cursor }) => {
    await requireAdminOrServiceSecret(ctx, serviceSecret);
    const result = await ctx.db.query("events").withIndex("by_updatedAt").order("desc")
      .paginate({ cursor, numItems: 60 });
    const eligible = result.page.filter((event) => event.status === "approved" &&
      event.publicationState === "publishable");
    const events = await Promise.all(eligible.map(async (event) => {
      const label = await loadLabel(ctx, event._id);
      if (label?.version === EVENT_DISCOVERY_VERSION && label.eventUpdatedAt === event.updatedAt) return null;
      const evidence = readEventEvidenceRecord(event.normalizedFieldsJson);
      const row = evidence.rowSourceText ?? evidence.splitSourceLine;
      const occurrenceText = typeof row === "string" && row.trim() ? row.slice(0, 800) : undefined;
      return {
        key: event._id,
        expectedUpdatedAt: event.updatedAt,
        title: event.title,
        ...(event.description ? { description: event.description.slice(0, 800) } : {}),
        ...(occurrenceText ? { occurrenceText } : {}),
        venue: event.venue,
        artists: event.artists.slice(0, 20),
      };
    }));
    return { events: events.filter((event) => event !== null), cursor: result.isDone ? null : result.continueCursor };
  },
});

export const recordBatch = mutation({
  args: {
    serviceSecret: v.string(),
    model: v.string(),
    results: v.array(v.object({
      eventId: v.id("events"),
      expectedUpdatedAt: v.number(),
      taxonomy: v.union(eventDiscoveryTaxonomy, v.null()),
      auditJson: v.string(),
    })),
  },
  returns: v.object({ written: v.number(), unchanged: v.number(), stale: v.number() }),
  handler: async (ctx, { serviceSecret, model, results }) => {
    await requireAdminOrServiceSecret(ctx, serviceSecret);
    if (!model.trim() || model.length > 100 || results.length > 50 ||
      new Set(results.map(({ eventId }) => eventId)).size !== results.length) {
      throw new Error("Invalid discovery batch.");
    }
    let written = 0, unchanged = 0, stale = 0;
    for (const { eventId, expectedUpdatedAt, taxonomy, auditJson } of results) {
      if (auditJson.length > 16_000 || (taxonomy && (
        !taxonomy.categories.includes(taxonomy.primaryCategory) ||
        new Set(taxonomy.categories).size !== taxonomy.categories.length ||
        new Set(taxonomy.genres).size !== taxonomy.genres.length ||
        new Set(taxonomy.formats).size !== taxonomy.formats.length ||
        (taxonomy.categories.length > 1 && taxonomy.categories.includes("other"))
      ))) throw new Error("Invalid discovery classification.");
      const event = await ctx.db.get(eventId);
      if (!event || event.status !== "approved" || event.updatedAt !== expectedUpdatedAt) {
        stale++;
        continue;
      }
      const label = await loadLabel(ctx, eventId);
      if (label?.version === EVENT_DISCOVERY_VERSION && label.eventUpdatedAt === event.updatedAt) {
        unchanged++;
        continue;
      }
      const value = { eventId, eventUpdatedAt: event.updatedAt, version: EVENT_DISCOVERY_VERSION, model, taxonomy, auditJson };
      if (label) await ctx.db.replace(label._id, value);
      else await ctx.db.insert("eventDiscoveryLabels", value);
      written++;
    }
    return { written, unchanged, stale };
  },
});
