import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { requireAdminOrServiceSecret } from "./authz";
import { eventDiscoveryTaxonomy, performerGenreMatch } from "./eventDiscoveryValues";
import { readEventEvidenceRecord } from "../lib/events/confirmed-event-schema-facts";
import { formatUtcDateKey, parseDateKeyToUtcNoon } from "../lib/events/nightlife-date";
import { EVENT_DISCOVERY_VERSION, getEventDiscoveryTaxonomy } from "../lib/taxonomy/event-discovery";
import {
  EMPTY_RESEARCH_RETRY_MS,
  PERFORMER_GENRE_RESEARCH_VERSION,
  applyPerformerGenreResearch,
  canPublishPerformerGenreSource,
  getPerformerGenreResearchActs,
  getPerformerGenreResearchFormat,
} from "../lib/taxonomy/performer-genre-research";

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

function loadGenreResearch(ctx: Pick<QueryCtx, "db">, eventId: Id<"events">) {
  return ctx.db.query("eventPerformerGenreResearch")
    .withIndex("by_eventId", (q) => q.eq("eventId", eventId)).unique();
}

function researchIsCurrent(row: Doc<"eventPerformerGenreResearch"> | null, updatedAt: number) {
  return row?.version === PERFORMER_GENRE_RESEARCH_VERSION && row.eventUpdatedAt === updatedAt;
}

function labelIsCurrent(label: Doc<"eventDiscoveryLabels"> | null, updatedAt: number) {
  return label?.version === EVENT_DISCOVERY_VERSION && label.eventUpdatedAt === updatedAt;
}

function requireUpcomingDate(fromDate: string) {
  const parsed = parseDateKeyToUtcNoon(fromDate);
  if (!parsed || formatUtcDateKey(parsed) !== fromDate) throw new Error("Invalid upcoming date.");
  return fromDate;
}

function upcomingEvents(ctx: QueryCtx, fromDate: string) {
  return ctx.db.query("events").withIndex("by_publicationState_date", (q) =>
    q.eq("publicationState", "publishable").gte("date", fromDate)).order("asc");
}

export async function loadPublicEventDiscoveryLabels(
  ctx: QueryCtx,
  event: Pick<Doc<"events">, "_id" | "updatedAt" | "title" | "eventType" | "venue" | "artists">,
  includePerformerGenreResearch: boolean,
) {
  const label = await loadLabel(ctx, event._id);
  if (!label || !labelIsCurrent(label, event.updatedAt)) return;
  const taxonomy = label.taxonomy ?? getEventDiscoveryTaxonomy(event);
  if (includePerformerGenreResearch && getPerformerGenreResearchFormat(taxonomy)) {
    const row = await loadGenreResearch(ctx, event._id);
    if (row?.matches.length && researchIsCurrent(row, event.updatedAt)) {
      return applyPerformerGenreResearch(taxonomy, row.matches);
    }
  }
  return label.taxonomy ? { eventTaxonomy: label.taxonomy } : undefined;
}

const researchCandidate = v.object({
  key: v.id("events"),
  expectedUpdatedAt: v.number(),
  title: v.string(),
  venue: v.string(),
  date: v.string(),
  city: v.string(),
  format: v.union(v.literal("party"), v.literal("live"), v.literal("dj-set"), v.literal("concert"), v.literal("live-performance")),
  acts: v.array(v.object({ billedName: v.string(), billedHandle: v.optional(v.string()), titleOnly: v.optional(v.boolean()) })),
});

function getResearchTarget(event: Doc<"events"> | null, label: Doc<"eventDiscoveryLabels"> | null) {
  if (!event || event.status !== "approved" || event.publicationState !== "publishable" ||
    !label || !labelIsCurrent(label, event.updatedAt)) return;
  const format = getPerformerGenreResearchFormat(label.taxonomy ?? getEventDiscoveryTaxonomy(event));
  if (!format) return;
  const acts = getPerformerGenreResearchActs(event, format);
  if (!acts.length) return;
  return { key: event._id, expectedUpdatedAt: event.updatedAt, title: event.title,
    venue: event.venue, date: event.date, city: "Belgrade", format, acts };
}

async function queuedResearchTarget(
  ctx: QueryCtx,
  event: Doc<"events"> | null,
  label: Doc<"eventDiscoveryLabels"> | null,
  retryBefore: number,
) {
  const target = getResearchTarget(event, label);
  if (!target) return null;
  const row = await loadGenreResearch(ctx, target.key);
  return row && researchIsCurrent(row, target.expectedUpdatedAt) &&
    (row.matches.length || row.researchedAt > retryBefore) ? null : target;
}

export const listGenreResearchInputs = query({
  args: {
    serviceSecret: v.string(), cursor: v.union(v.string(), v.null()), retryBefore: v.number(),
    upcomingFrom: v.optional(v.string()), eventIds: v.optional(v.array(v.id("events"))),
  },
  returns: v.object({ events: v.array(researchCandidate), cursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, { serviceSecret, cursor, retryBefore, upcomingFrom, eventIds }) => {
    await requireAdminOrServiceSecret(ctx, serviceSecret);
    if (eventIds && (upcomingFrom === undefined || cursor !== null ||
      eventIds.length > 12 || new Set(eventIds).size !== eventIds.length)) {
      throw new Error("Invalid priority research batch.");
    }
    if (upcomingFrom !== undefined) {
      requireUpcomingDate(upcomingFrom);
      const result = eventIds ? null : await upcomingEvents(ctx, upcomingFrom).paginate({ cursor, numItems: 36 });
      const events = result?.page ?? await Promise.all((eventIds ?? []).map((eventId) => ctx.db.get(eventId)));
      const targets = await Promise.all(events.map(async (event) => {
        if (!event || event.date < upcomingFrom || event.status !== "approved" ||
          event.publicationState !== "publishable") return null;
        return queuedResearchTarget(ctx, event, await loadLabel(ctx, event._id), retryBefore);
      }));
      return { events: targets.filter((target) => target !== null), cursor: result && !result.isDone ? result.continueCursor : null };
    }
    const result = await ctx.db.query("eventDiscoveryLabels").order("desc").paginate({ cursor, numItems: 36 });
    const events = await Promise.all(result.page.map(async (label) => {
      if (label.version !== EVENT_DISCOVERY_VERSION ||
        (label.taxonomy && !getPerformerGenreResearchFormat(label.taxonomy))) return null;
      return queuedResearchTarget(ctx, await ctx.db.get(label.eventId), label, retryBefore);
    }));
    return { events: events.filter((event) => event !== null), cursor: result.isDone ? null : result.continueCursor };
  },
});

export const recordGenreResearch = mutation({
  args: {
    serviceSecret: v.string(),
    results: v.array(v.object({
      eventId: v.id("events"), expectedUpdatedAt: v.number(), model: v.string(),
      matches: v.array(performerGenreMatch), auditJson: v.string(),
    })),
  },
  returns: v.object({ written: v.number(), resolved: v.number(), unchanged: v.number(), stale: v.number() }),
  handler: async (ctx, { serviceSecret, results }) => {
    await requireAdminOrServiceSecret(ctx, serviceSecret);
    if (results.length > 30 || new Set(results.map((result) => result.eventId)).size !== results.length) {
      throw new Error("Invalid performer genre research batch.");
    }
    const counts = { written: 0, resolved: 0, unchanged: 0, stale: 0 };
    for (const { eventId, expectedUpdatedAt, model, matches, auditJson } of results) {
      if (!model.trim() || model.length > 100 || auditJson.length > 16_000 || matches.length > 8 ||
        new Set(matches.map(({ performer, genre }) => JSON.stringify([performer, genre]))).size !== matches.length ||
        matches.some(({ url, identityUrl }) => !canPublishPerformerGenreSource(url) || !canPublishPerformerGenreSource(identityUrl))) {
        throw new Error("Invalid performer genre research.");
      }
      const target = getResearchTarget(await ctx.db.get(eventId), await loadLabel(ctx, eventId));
      if (!target || target.expectedUpdatedAt !== expectedUpdatedAt ||
        matches.some(({ performer }) => !target.acts.some(({ billedName }) => billedName === performer))) {
        counts.stale++;
        continue;
      }
      const row = await loadGenreResearch(ctx, eventId);
      const now = Date.now();
      if (row && researchIsCurrent(row, expectedUpdatedAt) &&
        (row.matches.length || (!matches.length && now - row.researchedAt < EMPTY_RESEARCH_RETRY_MS))) {
        counts.unchanged++;
        continue;
      }
      const data = { eventId, eventUpdatedAt: expectedUpdatedAt, version: PERFORMER_GENRE_RESEARCH_VERSION,
        researchedAt: now, model, matches, auditJson };
      if (row) await ctx.db.replace(row._id, data);
      else await ctx.db.insert("eventPerformerGenreResearch", data);
      counts.written++;
      if (matches.length) counts.resolved++;
    }
    return counts;
  },
});

export const listRecentInputs = query({
  args: { serviceSecret: v.string(), cursor: v.union(v.string(), v.null()), upcomingFrom: v.optional(v.string()) },
  returns: v.object({
    events: v.array(eventInput),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { serviceSecret, cursor, upcomingFrom }) => {
    await requireAdminOrServiceSecret(ctx, serviceSecret);
    const result = upcomingFrom === undefined
      ? await ctx.db.query("events").withIndex("by_updatedAt").order("desc").paginate({ cursor, numItems: 60 })
      : await upcomingEvents(ctx, requireUpcomingDate(upcomingFrom)).paginate({ cursor, numItems: 12 });
    const eligible = result.page.filter((event) => event.status === "approved" &&
      event.publicationState === "publishable");
    const events = await Promise.all(eligible.map(async (event) => {
      const label = await loadLabel(ctx, event._id);
      if (labelIsCurrent(label, event.updatedAt)) return null;
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
      if (!event || event.status !== "approved" || event.publicationState !== "publishable" ||
        event.updatedAt !== expectedUpdatedAt) {
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
