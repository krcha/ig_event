import { syncPerformerRegistryForEvent, lookupPerformerRegistryProgramme, lookupPerformerRegistrySearchHints } from "./performerRegistry";
import { schedulePublishedDiscovery } from "./internal/schedulePublishedDiscovery";
import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireAdminOrServiceSecret } from "./authz";
import { eventDiscoveryTaxonomy, musicGenre, performerGenreMatch } from "./eventDiscoveryValues";
import { PUBLICATION_POLICY_VERSION } from "../lib/domain/publication/policy";
import { loadScopedPerformerHandles, occurrenceTextFromEvidence, readScopedInstagramCaption, scopedPerformerHandles } from "./occurrencePerformerCredits";
import { readEventEvidenceRecord } from "../lib/events/confirmed-event-schema-facts";
import { normalizeEventTime } from "../lib/events/event-time";
import { addDaysToDateKey, formatUtcDateKey, getNightlifeDefaultDateKey, parseDateKeyToUtcNoon } from "../lib/events/nightlife-date";
import { getBelgradeDayKey } from "../lib/pipeline/belgrade-day-key";
import { classifyExplicitEventDiscovery, discoveryQuoteMatchesOccurrence, DISCOVERY_TEXT_SOURCES, getExcludedDiscoveryGenres, isExternalMusicRoleExcluded, hasConflictingProgrammeEvidence, hasExplicitGenreEvidence, scopedProgrammeGenreEvidence, type ExplicitDiscoveryEvidence } from "../lib/taxonomy/explicit-event-discovery";
import { DISCOVERY_CATEGORIES, DISCOVERY_FORMATS, EVENT_DISCOVERY_VERSION, getStoredOrLegacyEventTaxonomy, MUSIC_GENRES, type EventDiscoveryTaxonomy, type MusicGenre } from "../lib/taxonomy/event-discovery";
import {
  EMPTY_RESEARCH_RETRY_MS,
  PERFORMER_GENRE_RESEARCH_VERSION,
  applyPerformerGenreResearch,
  canPublishPerformerGenreSource,
  getEventListingResearchAct,
  BILLED_PROGRAMME_REVIEW_VERSION,
  getBilledProgrammeActs,
  billedHandleContextKey,
  type PerformerHandleCredit,
  getPerformerGenreResearchActs,
  getPerformerGenreResearchFormat,
} from "../lib/taxonomy/performer-genre-research";
import { categoryWindow, discoveryBudgets, type CategoryScanPhase, PRIORITY_CATEGORY_VERSION } from "../lib/taxonomy/priority-event-discovery";
import { revalidateEventDiscoveryClassification } from "../lib/ai/classify-event-discovery";
import { normalizeTaxonomyText } from "../lib/taxonomy/venue-types";
import { isVenuePublic } from "../lib/venues/venue-lifecycle";

const ENRICHMENT_LEASE_MS = 240_000;
const ENRICHMENT_RETRY_MS = 60 * 60 * 1000;
const genreKeys: ReadonlySet<string> = new Set(MUSIC_GENRES.map(({ key }) => key));

const eventInputFields = {
  key: v.id("events"),
  expectedUpdatedAt: v.number(),
  title: v.string(),
  description: v.optional(v.string()),
  occurrenceText: v.optional(v.string()),
  venue: v.string(),
  artists: v.array(v.string()),
  performerHandles: v.optional(v.array(v.object({performer:v.string(),handle:v.string()}))),
};
const eventInput = v.object(eventInputFields);
const discoveryInputFields = {
  ...eventInputFields, date: v.string(), time: v.optional(v.string()), eventType: v.string(), sourceCaption: v.optional(v.string()),
};
const dailyInput = v.object(discoveryInputFields);
const upcomingInput = v.object({ ...discoveryInputFields, currentTaxonomy: v.optional(eventDiscoveryTaxonomy),
  preferPerformerResearch: v.optional(v.boolean()),
  performerSearchHints: v.optional(v.array(v.object({ performer: v.string(), profileUrl: v.string() }))) });
const unknownGenreInput = v.object({ ...discoveryInputFields, currentTaxonomy: eventDiscoveryTaxonomy });
const webGenreResult = v.object({ model: v.string(), matches: v.array(performerGenreMatch), auditJson: v.string() });
const genreDiscoveryResult = v.object({
  eventId: v.id("events"), expectedUpdatedAt: v.number(), taxonomy: v.union(eventDiscoveryTaxonomy, v.null()),
  auditJson: v.string(), estimatedGenres: v.optional(v.array(musicGenre)), webResearch: v.optional(webGenreResult),
  deferred: v.optional(v.literal(true)),
});
const genreDiscoveryCounts = v.object({ written: v.number(), unchanged: v.number(), stale: v.number() });
type GenreDiscoveryResult = Infer<typeof genreDiscoveryResult>;
type WebGenreResult = Infer<typeof webGenreResult>;

const categoryValue = v.union(...DISCOVERY_CATEGORIES.map(({ key }) => v.literal(key)));
const formatValue = v.union(...DISCOVERY_FORMATS.map(({ key }) => v.literal(key)));
const categoryState = v.object({ primaryCategory: categoryValue, categories: v.array(categoryValue), formats: v.array(formatValue) });
type CategoryState = Infer<typeof categoryState>;
const categoryRefreshFields = { eventId: v.id("events"), expectedUpdatedAt: v.number(), before: categoryState, after: categoryState };
const categoryRefreshProposal = v.object({
  ...categoryRefreshFields, title: v.string(), date: v.string(), evidence: v.array(v.object({
    kind: v.union(v.literal("category"), v.literal("format"), v.literal("genre")), label: v.union(categoryValue, formatValue, musicGenre),
    source: v.union(v.literal("title"), v.literal("description"), v.literal("occurrenceText"), v.literal("sourceCaption")), quote: v.string(),
  })),
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

function readCaptionClaims(auditJson: string) {
  const { evidence } = readEventEvidenceRecord(auditJson);
  return Array.isArray(evidence) ? evidence.filter((claim) => claim?.source === "sourceCaption") : [];
}

function readDirectGenreClaims(auditJson: string) {
  const { evidence } = readEventEvidenceRecord(auditJson);
  return Array.isArray(evidence) ? evidence.filter((claim) => claim?.kind === "genre" &&
    ["sourceCaption", "occurrenceText", "title", "description"].includes(claim.source)) : [];
}

function readEstimatedGenres(auditJson: string): MusicGenre[] {
  // Legacy classifier and web research audits keep their original structure.
  if (!auditJson.startsWith('{"estimatedGenres":')) return [];
  const { estimatedGenres } = readEventEvidenceRecord(auditJson);
  return Array.isArray(estimatedGenres)
    ? estimatedGenres.filter((genre): genre is MusicGenre => typeof genre === "string" && genreKeys.has(genre)).slice(0, 2)
    : [];
}

function projectGenreFallback(
  taxonomy: EventDiscoveryTaxonomy, label: Doc<"eventDiscoveryLabels">, row: Doc<"eventPerformerGenreResearch"> | null,
) {
  if (row?.matches.length && researchIsCurrent(row, label.eventUpdatedAt)) {
    const researched = applyPerformerGenreResearch(taxonomy, row.matches);
    if (researched.eventTaxonomy.genres.length) return researched;
  }
  const estimatedGenres = readEstimatedGenres(label.auditJson ?? "");
  if (estimatedGenres.length) {
    return { eventTaxonomy: { ...taxonomy, genres: estimatedGenres },
      performerGenreResearch: { sources: [], estimated: true as const } };
  }
}

export async function loadPublicEventDiscoveryLabels(
  ctx: QueryCtx,
  event: Pick<Doc<"events">, "_id" | "updatedAt" | "title" | "eventType" | "description" | "venue" | "artists">,
  includePerformerGenreResearch: boolean,
) {
  const label = await loadLabel(ctx, event._id);
  if (!label || !labelIsCurrent(label, event.updatedAt)) return;
  const taxonomy = label.taxonomy ?? getStoredOrLegacyEventTaxonomy(event);
  if (!label.taxonomy && Array.isArray(readEventEvidenceRecord(label.auditJson).scopedProgrammeGenres)) {
    const full = await ctx.db.get(event._id);
    if (full) {
      const genres = await currentScopedProgrammeGenres(ctx, full, label);
      if (genres.length) return { eventTaxonomy: { ...taxonomy, genres } };
    }
  }
  const registryCategory = label.model === REGISTRY_MODEL || readEventEvidenceRecord(label.auditJson).performerRegistryCategory === true;
  const includeGenre = includePerformerGenreResearch && !!getPerformerGenreResearchFormat(taxonomy);
  let research = includeGenre ? await loadGenreResearch(ctx, event._id) : null;
  if (registryCategory || research?.model === REGISTRY_MODEL) {
    const full = await ctx.db.get(event._id);
    if (!full) return;
    const candidate = await discoveryCandidate(ctx, full);
    const programme = hasConflictingProgrammeEvidence(candidate) ? { category: undefined, matches: [] } :
      await usableRegistryProgramme(ctx, full, candidate, taxonomy);
    if (registryCategory && taxonomy.primaryCategory !== programme.category) return;
    if (research?.model === REGISTRY_MODEL) research = { ...research, matches: programme.matches };
  }
  if (includeGenre) {
    const enriched = projectGenreFallback(taxonomy, label, research);
    if (enriched) return enriched;
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
  const format = getPerformerGenreResearchFormat(label.taxonomy ?? getStoredOrLegacyEventTaxonomy(event));
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
  if (!target || !event) return null;
  if (label && !label.taxonomy && Array.isArray(readEventEvidenceRecord(label.auditJson).scopedProgrammeGenres) &&
    (await currentScopedProgrammeGenres(ctx, event, label)).length) return null;
  const row = await loadGenreResearch(ctx, target.key);
  if (row && researchIsCurrent(row, target.expectedUpdatedAt) && (row.matches.length || row.researchedAt > retryBefore)) return null;
  const performerHandles = await loadScopedPerformerHandles(ctx,event);
  return performerHandles.length
    ? { ...target, acts: getPerformerGenreResearchActs({ ...event, performerHandles },target.format) }
    : target;
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
      if (row && row.model !== REGISTRY_MODEL && researchIsCurrent(row, expectedUpdatedAt) &&
        (row.matches.length || (!matches.length && now - row.researchedAt < EMPTY_RESEARCH_RETRY_MS))) {
        counts.unchanged++;
        continue;
      }
      const data = { eventId, eventUpdatedAt: expectedUpdatedAt, version: PERFORMER_GENRE_RESEARCH_VERSION,
        researchedAt: now, model, matches, auditJson };
      if (row) await ctx.db.replace(row._id, data);
      else await ctx.db.insert("eventPerformerGenreResearch", data);
      await schedulePublishedDiscovery(ctx, eventId);
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
      const occurrenceText = occurrenceTextFromEvidence(evidence);
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
      if (labelIsCurrent(label, event.updatedAt)) {
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

async function completedDailyWindow(ctx: Pick<QueryCtx, "db">, runId: Id<"ingestionRuns">) {
  const run = await ctx.db.get(runId);
  if (run?.mode !== "daily" || run.status !== "completed" || !run.dailyDayKey) return;
  // The durable executor can dispatch only after the queue is ready. Daily
  // runs do not necessarily write the older optional startedAt field.
  const from = run.startedAt ?? run.dispatchReadyAt ?? run.queueBuildCompletedAt ?? run.createdAt;
  if (!Number.isFinite(from) || typeof run.finishedAt !== "number" || !Number.isFinite(run.finishedAt) || from > run.finishedAt) return;
  return { from, to: run.finishedAt };
}

async function cameFromDailyRun(
  ctx: Pick<QueryCtx, "db">, event: Doc<"events">, runId: Id<"ingestionRuns">, window: { from: number; to: number },
) {
  const postId = event.instagramPostId;
  if (!postId || event.status !== "approved" || event.publicationState !== "publishable" ||
    event._creationTime < window.from || event._creationTime > window.to ||
    event.createdAt < window.from || event.createdAt > window.to) return false;
  // A time window alone would also pick up manual imports or a concurrent
  // recovery. Match this exact Instagram post against the run's saved receipt.
  const posts = await ctx.db.query("scrapedPosts").withIndex("by_postId", (q) => q.eq("postId", postId)).take(8);
  const receipts = await Promise.all(posts.map((post) => ctx.db.query("ingestionRunHandleReceipts")
    .withIndex("by_run_handle", (q) => q.eq("runId", runId).eq("handle", post.handle)).unique()));
  return posts.some((post, index) => {
    const receipt = receipts[index];
    return receipt?.scrapedPostId === post._id || receipt?.savedPostLinks?.some((link) =>
      link.scrapedPostId === post._id && link.postId === postId);
  });
}

function confirmedDiscoveryTime(event: Doc<"events">, evidence: Record<string, unknown>) {
  if (event.timeStatus !== "confirmed" || event.timeEvidenceKind !== "start_time_stated" || !event.timeEvidenceText?.trim() ||
    evidence.timeEvidenceVerified !== true || typeof evidence.time !== "string" ||
    !["caption", "poster", "alt_text", "schedule_entry"].includes(event.timeSource ?? "") ||
    (event.sourceConflictFields?.length ?? 0) > 0) return;
  const time = normalizeEventTime(event.time).startLabel;
  return time && normalizeEventTime(evidence.time).startLabel === time ? time : undefined;
}

async function discoveryCandidate(ctx: Pick<QueryCtx, "db">, event: Doc<"events">) {
  const evidence = readEventEvidenceRecord(event.normalizedFieldsJson);
  const occurrenceText = occurrenceTextFromEvidence(evidence);
  const sourceCaption = await readScopedInstagramCaption(ctx, event, evidence);
  const time = confirmedDiscoveryTime(event, evidence);
  const performerHandles = scopedPerformerHandles(event, evidence, occurrenceText, sourceCaption);
  return { key: event._id, expectedUpdatedAt: event.updatedAt, title: event.title, venue: event.venue,
    date: event.date, eventType: event.eventType, artists: event.artists.slice(0, 20),
    ...(performerHandles.length ? { performerHandles } : {}),
    ...(time ? { time } : {}),
    ...(event.description ? { description: event.description.slice(0, 800) } : {}),
    ...(occurrenceText ? { occurrenceText } : {}), ...(sourceCaption ? { sourceCaption } : {}) };
}

function validateGenreDiscoveryBatch(model: string, results: GenreDiscoveryResult[]) {
  if (!model.trim() || model.length > 100 || results.length > 12 ||
    new Set(results.map(({ eventId }) => eventId)).size !== results.length) throw new Error("Invalid genre discovery batch.");
  for (const { taxonomy, auditJson, estimatedGenres = [], webResearch } of results) {
    if (auditJson.length > 15_600 || estimatedGenres.length > 2 || new Set(estimatedGenres).size !== estimatedGenres.length ||
      (taxonomy && (!taxonomy.categories.includes(taxonomy.primaryCategory) ||
        new Set(taxonomy.categories).size !== taxonomy.categories.length || new Set(taxonomy.genres).size !== taxonomy.genres.length ||
        new Set(taxonomy.formats).size !== taxonomy.formats.length ||
        (taxonomy.categories.length > 1 && taxonomy.categories.includes("other"))))) throw new Error("Invalid genre discovery result.");
    if (webResearch && (!webResearch.model.trim() || webResearch.model.length > 100 || webResearch.auditJson.length > 16_000 ||
      webResearch.matches.length > 8 ||
      new Set(webResearch.matches.map(({ performer, genre }) => JSON.stringify([performer, genre]))).size !== webResearch.matches.length ||
      webResearch.matches.some(({ url, identityUrl }) => !canPublishPerformerGenreSource(url) || !canPublishPerformerGenreSource(identityUrl)))) {
      throw new Error("Invalid web genre research result.");
    }
  }
}

// A previous web image can finish a lease after backend rollout. Recheck the
// current scoped programme at the actual write boundary as well as in the worker.
async function conflictsWithNewClassification(ctx: MutationCtx, event: Doc<"events">, result: GenreDiscoveryResult) {
  if (!result.taxonomy && !result.estimatedGenres?.length && !result.webResearch?.matches.length) return false;
  const candidate = await discoveryCandidate(ctx, event);
  const taxonomy = result.taxonomy ?? getStoredOrLegacyEventTaxonomy(event);
  const role = taxonomy.categories.find(c => c === "party" || c === "live");
  return hasConflictingProgrammeEvidence(candidate) || !!(role && isExternalMusicRoleExcluded(candidate, role));
}

async function captionClaimsAreCurrent(ctx: Pick<QueryCtx, "db">, event: Doc<"events">, claims: ReturnType<typeof readCaptionClaims>) {
  if (!claims.length) return true;
  const caption = await readScopedInstagramCaption(ctx, event, readEventEvidenceRecord(event.normalizedFieldsJson));
  return claims.every(({ quote }) => typeof quote === "string" && quote.trim() && caption?.includes(quote));
}

function verifiedGenreFallback(event: Doc<"events">, taxonomy: EventDiscoveryTaxonomy, result: GenreDiscoveryResult): {
  estimatedGenres?: MusicGenre[]; webResearch?: WebGenreResult;
} {
  const format = getPerformerGenreResearchFormat(taxonomy);
  if (!format) return {};
  const webResearch = result.webResearch;
  if (webResearch?.matches.length) {
    const performerActs = getPerformerGenreResearchActs(event, format).filter(({ titleOnly }) => !titleOnly);
    const listingAct = getEventListingResearchAct(event);
    if (webResearch.matches.every(({ performer, url, identityUrl }) => performerActs.some(({ billedName }) => billedName === performer) ||
      (!!listingAct && url === identityUrl && normalizeTaxonomyText(performer) === normalizeTaxonomyText(listingAct.billedName)))) {
      return { webResearch };
    }
  }
  if (result.estimatedGenres?.length && getPerformerGenreResearchActs(event, format).some(({ titleOnly }) => !titleOnly)) {
    return { estimatedGenres: result.estimatedGenres };
  }
  return {};
}

function serializeGenreAudit(audit: Record<string, unknown>, estimatedGenres: MusicGenre[] | undefined) {
  delete audit.estimatedGenres;
  return JSON.stringify(estimatedGenres ? { estimatedGenres, ...audit } : audit);
}

function enrichmentAudit(result: GenreDiscoveryResult, now: number): Record<string, unknown> {
  return { ...readEventEvidenceRecord(result.auditJson), performerReviewDeferred: Boolean(result.deferred), upcomingGenreRetryAt:
    now + (result.deferred ? ENRICHMENT_RETRY_MS : EMPTY_RESEARCH_RETRY_MS) };
}

function hasPerformerEvidence(auditJson: string) {
  const audit = readEventEvidenceRecord(auditJson);
  return !!(audit.billedProgramme || audit.partialProgramme);
}

async function storeWebGenreResearch(ctx: MutationCtx, event: Doc<"events">, webResearch: WebGenreResult) {
  const row = await loadGenreResearch(ctx, event._id);
  if (row?.model !== REGISTRY_MODEL && researchIsCurrent(row, event.updatedAt) && row?.matches.some(({ url, identityUrl }) =>
    canPublishPerformerGenreSource(url) && canPublishPerformerGenreSource(identityUrl))) return;
  const data = { ...webResearch, eventId: event._id, eventUpdatedAt: event.updatedAt,
    version: PERFORMER_GENRE_RESEARCH_VERSION, researchedAt: Date.now() };
  if (row) await ctx.db.replace(row._id, data);
  else await ctx.db.insert("eventPerformerGenreResearch", data);
  await schedulePublishedDiscovery(ctx, event._id);
}

export const listDailyInputs = query({
  args: { serviceSecret: v.string(), runId: v.id("ingestionRuns"), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ events: v.array(dailyInput), cursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, { serviceSecret, runId, cursor }) => {
    await requireAdminOrServiceSecret(ctx, serviceSecret);
    const window = await completedDailyWindow(ctx, runId);
    if (!window) return { events: [], cursor: null };
    const page = await ctx.db.query("events").withIndex("by_creation_time", (q) =>
      q.gte("_creationTime", window.from).lte("_creationTime", window.to)).paginate({ cursor, numItems: 12 });
    const events = await Promise.all(page.page.map(async (event) => {
      if (!await cameFromDailyRun(ctx, event, runId, window) || await loadLabel(ctx, event._id) ||
        await ingestionWork(ctx, event._id)) return null;
      // The per-publication transaction will persist any reusable data even if
      // this older daily callback races the freshly scheduled local mutation.
      const candidate = await discoveryCandidate(ctx, event);
      const programme = await lookupPerformerRegistryProgramme(ctx, event, candidate.performerHandles ?? []);
      if (programme.matches.length || programme.category) return null;
      return candidate;
    }));
    return { events: events.filter((event) => event !== null), cursor: page.isDone ? null : page.continueCursor };
  },
});

// A daily completion can race its publication tasks. This callback always
// schedules local work; only the shared, budgeted sweep can start paid work.
export const scheduleDailyPage = mutation({
  args: { serviceSecret: v.string(), runId: v.id("ingestionRuns"), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ scheduled: v.number(), cursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, { serviceSecret, runId, cursor }) => {
    await requireAdminOrServiceSecret(ctx, serviceSecret);
    const window = await completedDailyWindow(ctx, runId);
    if (!window) return { scheduled: 0, cursor: null };
    const page = await ctx.db.query("events").withIndex("by_creation_time", q =>
      q.gte("_creationTime", window.from).lte("_creationTime", window.to)).paginate({ cursor, numItems: 12 });
    let scheduled = 0;
    for (const event of page.page) {
      if (!await cameFromDailyRun(ctx, event, runId, window)) continue;
      await schedulePublishedDiscovery(ctx, event._id);
      scheduled++;
    }
    return { scheduled, cursor: page.isDone ? null : page.continueCursor };
  },
});

export const recordDailyBatch = mutation({
  args: { serviceSecret: v.string(), runId: v.id("ingestionRuns"), model: v.string(), results: v.array(genreDiscoveryResult) },
  returns: genreDiscoveryCounts,
  handler: async (ctx, { serviceSecret, runId, model, results }) => {
    await requireAdminOrServiceSecret(ctx, serviceSecret);
    validateGenreDiscoveryBatch(model, results);
    const window = await completedDailyWindow(ctx, runId);
    const counts = { written: 0, unchanged: 0, stale: 0 };
    if (!window) return { ...counts, stale: results.length };
    for (const result of results) {
      const { eventId, expectedUpdatedAt, taxonomy, auditJson } = result;
      const event = await ctx.db.get(eventId);
      if (!event || event.updatedAt !== expectedUpdatedAt || !await cameFromDailyRun(ctx, event, runId, window)) {
        counts.stale++;
        continue;
      }
      if (await loadLabel(ctx, eventId)) {
        counts.unchanged++;
        continue;
      }
      if (await conflictsWithNewClassification(ctx, event, result) || !await captionClaimsAreCurrent(ctx, event, readCaptionClaims(auditJson))) {
        // Another occurrence may have been added while the model was working.
        counts.stale++;
        continue;
      }
      const { estimatedGenres, webResearch } = verifiedGenreFallback(event, taxonomy ?? getStoredOrLegacyEventTaxonomy(event), result);
      await ctx.db.insert("eventDiscoveryLabels", { eventId, eventUpdatedAt: event.updatedAt,
        version: EVENT_DISCOVERY_VERSION, model, taxonomy, auditJson: serializeGenreAudit(enrichmentAudit(result, Date.now()), estimatedGenres) });
      if (webResearch) await storeWebGenreResearch(ctx, event, webResearch);
      else if (hasPerformerEvidence(result.auditJson)) await schedulePublishedDiscovery(ctx, event._id);
      counts.written++;
    }
    return counts;
  },
});

function loadEnrichmentState(ctx: Pick<QueryCtx, "db">) {
  return ctx.db.query("eventDiscoveryEnrichmentState").withIndex("by_key", (q) => q.eq("key", "upcoming")).unique();
}

function dueForFirstBilledReview(event: Doc<"events">, taxonomy: EventDiscoveryTaxonomy | null | undefined,
  audit: Record<string, unknown>, now: number, handles?: readonly PerformerHandleCredit[]) {
  if (audit.performerReviewDeferred || typeof audit.upcomingGenreRetryAt !== "number" ||
    audit.upcomingGenreRetryAt <= now + ENRICHMENT_RETRY_MS) return false;
  const key = billedHandleContextKey(handles);
  const newIdentityEvidence = key !== undefined && audit.billedHandleContext !== key;
  if (!newIdentityEvidence && (audit.performerReviewVersion === BILLED_PROGRAMME_REVIEW_VERSION ||
    audit.ambiguousPerformerIdentity || audit.partialProgramme)) return false;
  const music = getPerformerGenreResearchFormat(taxonomy ?? getStoredOrLegacyEventTaxonomy(event));
  return music ? getPerformerGenreResearchActs(event, music).some(act => !act.titleOnly) :
    (!taxonomy || taxonomy.primaryCategory === "other") && getBilledProgrammeActs(event).length > 0;
}

async function upcomingEnrichmentState(ctx: Pick<QueryCtx, "db">, event: Doc<"events">, now: number) {
  if (event.status !== "approved" || event.publicationState !== "publishable" ||
      event.date < getNightlifeDefaultDateKey(new Date(now))) return null;
  if (event.date < getBelgradeDayKey(now) && (event.timeStatus !== "confirmed" || categoryWindow(now).tier(event) !== "confirmed")) return null;
  const row = await loadLabel(ctx, event._id);
  const current = labelIsCurrent(row, event.updatedAt) ? row : null;
  const taxonomy = current?.taxonomy;
  if (taxonomy?.genres.length) return null;
  const format = taxonomy && getPerformerGenreResearchFormat(taxonomy);
  if (!format && taxonomy && taxonomy.primaryCategory !== "other") return null;
  let preferPerformerResearch = false;
  if (current) {
    const audit = readEventEvidenceRecord(current.auditJson);
    if (!taxonomy && Array.isArray(audit.scopedProgrammeGenres) && (await currentScopedProgrammeGenres(ctx, event, current)).length) return null;
    const music = format ?? getPerformerGenreResearchFormat(getStoredOrLegacyEventTaxonomy(event));
    const previousVersion = audit.performerReviewVersion !== BILLED_PROGRAMME_REVIEW_VERSION;
    preferPerformerResearch = Boolean((previousVersion || audit.performerReviewDeferred === true) && music && readEstimatedGenres(current.auditJson).length &&
      getPerformerGenreResearchActs(event, music).some(act => !act.titleOnly));
    const retryAt = audit.upcomingGenreRetryAt;
    if (typeof retryAt === "number" && retryAt > now) {
      // Existing completed v0 attempts searched only a listing for an unknown
      // programme. Give the regular, budgeted sweep one chance to verify a billed
      // act. Transient retries and current-version negative results keep their delay.
      const handles = await loadScopedPerformerHandles(ctx, event);
      const upgrade = dueForFirstBilledReview(event, taxonomy, audit, now, handles);
      if (upgrade && handles.length && music) preferPerformerResearch = true;
      if (!upgrade) return null;
      if (!format) {
        const candidate = await discoveryCandidate(ctx, event);
        const local = classifyExplicitEventDiscovery(candidate);
        if (hasConflictingProgrammeEvidence(candidate) || (local?.complete && !getPerformerGenreResearchFormat(local.taxonomy))) return null;
      }
    }
    if (music) {
      const research = await loadGenreResearch(ctx, event._id);
      if (researchIsCurrent(research, event.updatedAt) && research?.matches.length &&
        (format || research.model === REGISTRY_MODEL)) return null;
    }
  }
  return { row, current, currentTaxonomy: format && taxonomy ? taxonomy : undefined, preferPerformerResearch };
}

const priorityCounts = v.object({ scanned: v.number(), eligible: v.number(), known: v.number(),
  written: v.number(), attempted: v.number(), unresolved: v.number() });
const CATEGORY_RESCAN_MS = 30 * 60_000;
type CategoryEvidence = ExplicitDiscoveryEvidence;

function hasKnownCategory(row: Doc<"eventDiscoveryLabels"> | null, event: Doc<"events">) {
  if (!row || !labelIsCurrent(row, event.updatedAt) || !row.taxonomy) return false;
  const taxonomy = row.taxonomy;
  return taxonomy.primaryCategory !== "other" || taxonomy.genres.length > 0 || taxonomy.formats.length > 0 ||
    readPriorityEvidence(row.auditJson).some(claim => claim.kind === "category" && claim.label === "other");
}

function readPriorityEvidence(auditJson: string): CategoryEvidence[] {
  const { evidence } = readEventEvidenceRecord(auditJson);
  if (!Array.isArray(evidence)) return [];
  return evidence.filter((claim): claim is CategoryEvidence => claim && (claim.kind === "category" || claim.kind === "format" || claim.kind === "genre") &&
    typeof claim.label === "string" && DISCOVERY_TEXT_SOURCES.includes(claim.source) && typeof claim.quote === "string" &&
    claim.quote.trim().length > 0 && claim.quote.length <= 120);
}

function scopedProof(event: Doc<"events">, candidate: Awaited<ReturnType<typeof discoveryCandidate>>, music: EventDiscoveryTaxonomy) {
  const fields = readEventEvidenceRecord(event.normalizedFieldsJson);
  if (fields.sourceOccurrencePlanUnverified === true || fields.sourceOccurrenceAmbiguousProvenance === true) return [];
  return scopedProgrammeGenreEvidence(candidate, music);
}

async function currentScopedProgrammeGenres(ctx: Pick<QueryCtx, "db">, event: Doc<"events">, label: Doc<"eventDiscoveryLabels">) {
  const stored = readEventEvidenceRecord(label.auditJson).scopedProgrammeGenres;
  if (!Array.isArray(stored) || !stored.length || !labelIsCurrent(label, event.updatedAt)) return [];
  const fresh = scopedProof(event, await discoveryCandidate(ctx, event), getStoredOrLegacyEventTaxonomy(event));
  return fresh.filter(claim => stored.some(old => old?.label === claim.label && old.source === claim.source && old.quote === claim.quote))
    .map(claim => claim.label as MusicGenre);
}

async function savePriorityCategory(ctx: MutationCtx, event: Doc<"events">, existing: Doc<"eventDiscoveryLabels"> | null,
  candidate: Awaited<ReturnType<typeof discoveryCandidate>>, taxonomy: EventDiscoveryTaxonomy, evidence: CategoryEvidence[], model: string) {
  const current = existing && labelIsCurrent(existing, event.updatedAt) ? existing : null;
  const audit = readEventEvidenceRecord(current?.auditJson);
  const excluded = getExcludedDiscoveryGenres(candidate, DISCOVERY_TEXT_SOURCES);
  const musical = taxonomy.categories.some(category => category === "live" || category === "party");
  const direct = musical ? classifyExplicitEventDiscovery({ ...candidate, currentTaxonomy: { ...taxonomy, genres: [] } }) : null;
  const summary = musical ? classifyExplicitEventDiscovery({ title: candidate.title, description: candidate.description,
    date: candidate.date, venue: candidate.venue, artists: candidate.artists, currentTaxonomy: { ...taxonomy, genres: [] } }) : null;
  const previousScoped = musical && Array.isArray(audit.scopedProgrammeGenres) ? scopedProof(event, candidate, taxonomy) : [];
  const genreProof = [...evidence, ...previousScoped, ...(direct?.evidence ?? []), ...(summary?.evidence ?? [])].filter(claim =>
    musical && claim.kind === "genre" && genreKeys.has(claim.label) && !excluded.has(claim.label as MusicGenre) &&
    hasExplicitGenreEvidence(candidate, claim.source, claim.quote, claim.label as MusicGenre));
  const genres = [...new Set(genreProof.map(claim => claim.label as MusicGenre))].slice(0, 5);
  const proof = [...evidence.filter(claim => claim.kind !== "genre"), ...genres.map(genre => genreProof.find(c => c.label === genre)!)];
  const priorMusic = getStoredOrLegacyEventTaxonomy({ ...event, eventTaxonomy: current?.taxonomy ?? undefined }).primaryCategory;
  const estimate = current && musical && priorMusic === taxonomy.primaryCategory && !genres.length && !audit.partialProgramme && !audit.ambiguousPerformerIdentity
    ? readEstimatedGenres(current.auditJson).filter(genre => !excluded.has(genre)) : [];
  // Earlier attempts may have been unable to identify either a programme or
  // genre. A newly confirmed music programme gives the regular sweep new input.
  delete audit.upcomingGenreRetryAt;
  delete audit.performerRegistryCategory;
  delete audit.scopedProgrammeGenres;
  const value = { eventId: event._id, eventUpdatedAt: event.updatedAt, version: EVENT_DISCOVERY_VERSION, model,
    taxonomy: { ...taxonomy, genres }, auditJson: serializeGenreAudit({ ...audit, evidence: proof,
      categoryPriority: { version: PRIORITY_CATEGORY_VERSION, confirmedAt: Date.now(), model } }, estimate.length ? estimate : undefined) };
  if (existing) await ctx.db.replace(existing._id, value);
  else await ctx.db.insert("eventDiscoveryLabels", value);
}

const REGISTRY_MODEL = "performer-registry-v1";
const LOCAL_MODEL = "ingestion-programme-evidence-v1";

function ingestionWork(ctx: Pick<QueryCtx, "db">, eventId: Id<"events">) {
  return ctx.db.query("eventDiscoveryIngestionQueue").withIndex("by_eventId", q => q.eq("eventId", eventId)).unique();
}

async function setIngestionWork(ctx: MutationCtx, event: Doc<"events">, needed: boolean, now: number, retryAt = now,
  reason: Doc<"eventDiscoveryIngestionQueue">["reason"] = "category") {
  const old = await ingestionWork(ctx, event._id);
  const window = categoryWindow(now);
  const tier = window.tier(event);
  if (!needed || event.date < getNightlifeDefaultDateKey(new Date(now)) ||
    (event.timeStatus === "confirmed" && event.date <= getBelgradeDayKey(now) && !tier)) {
    if (old) await ctx.db.delete(old._id);
    return;
  }
  const priority = tier === "confirmed" ? 0 : tier && tier !== "local-only" ? 1 : 2;
  const activeAttempt = old?.eventUpdatedAt === event.updatedAt && old.lastAttemptAt ? old.lastAttemptAt + ENRICHMENT_RETRY_MS : 0;
  const readyAt = retryAt > now || old?.eventUpdatedAt !== event.updatedAt ? Math.max(activeAttempt, retryAt) :
    Math.max(activeAttempt, Math.min(old.readyAt, now));
  const value = { eventId: event._id, eventUpdatedAt: event.updatedAt, date: event.date, priority, readyAt, reason,
    ...(old?.eventUpdatedAt === event.updatedAt && old.lastAttemptAt ? { lastAttemptAt: old.lastAttemptAt } : {}) };
  if (!old) await ctx.db.insert("eventDiscoveryIngestionQueue", value);
  else if (old.eventUpdatedAt !== event.updatedAt || old.priority !== priority || old.readyAt !== readyAt || old.reason !== reason) await ctx.db.replace(old._id, value);
}

async function usableRegistryProgramme(ctx: Pick<QueryCtx, "db">, event: Doc<"events">, candidate: Awaited<ReturnType<typeof discoveryCandidate>>,
  taxonomy: EventDiscoveryTaxonomy | null) {
  const programme = await lookupPerformerRegistryProgramme(ctx, event, candidate.performerHandles ?? []);
  const programmeRole = (taxonomy ?? getStoredOrLegacyEventTaxonomy(event)).categories.find(c => c === "party" || c === "live");
  if ((programme.category && isExternalMusicRoleExcluded(candidate, programme.category)) ||
    (programmeRole && isExternalMusicRoleExcluded(candidate, programmeRole))) return { matches: [], category: undefined };
  const excluded = getExcludedDiscoveryGenres(candidate, DISCOVERY_TEXT_SOURCES);
  const permitted = programme.matches.filter(match => !excluded.has(match.genre));
  const complete = programme.matches.every(match => permitted.some(item => item.performer === match.performer));
  return { category: programme.category, matches: complete ? permitted : [] };
}

// The same transaction handles ingestion, catch-up and the last local check before a paid claim.
async function enrichFromAvailableEvidence(ctx: MutationCtx, event: Doc<"events">, now: number) {
  let row = await loadLabel(ctx, event._id);
  const current = row && labelIsCurrent(row, event.updatedAt) ? row : null;
  let known = hasKnownCategory(current, event);
  let taxonomy = known ? current!.taxonomy : null;
  const flags = { categoryWritten: false, directGenreWritten: false, registryGenreWritten: false };
  const audit = readEventEvidenceRecord(current?.auditJson);
  const registryCategory = audit.performerRegistryCategory === true;
  if (known && taxonomy && !getPerformerGenreResearchFormat(taxonomy) && !registryCategory) {
    await setIngestionWork(ctx, event, false, now);
    return flags;
  }
  const candidate = await discoveryCandidate(ctx, event);
  if (hasConflictingProgrammeEvidence(candidate)) {
    if (current && !current.taxonomy && Array.isArray(audit.scopedProgrammeGenres)) {
      delete audit.scopedProgrammeGenres;
      await ctx.db.patch(current._id, { auditJson: JSON.stringify(audit) });
    }
    await setIngestionWork(ctx, event, false, now);
    return flags;
  }
  const explicit = classifyExplicitEventDiscovery(candidate);
  const provesCategory = explicit && (explicit.complete || (explicit.titleCategory && explicit.taxonomy.categories.length === 1)) &&
    explicit.evidence.some(claim => claim.kind === "category" && claim.label === explicit.taxonomy.primaryCategory);
  if ((!known || registryCategory) && explicit && provesCategory) {
    await savePriorityCategory(ctx, event, row, candidate, explicit.taxonomy, explicit.evidence, LOCAL_MODEL);
    flags.categoryWritten = !known;
    row = await loadLabel(ctx, event._id);
    taxonomy = row!.taxonomy;
    flags.directGenreWritten = !!taxonomy?.genres.length;
    known = true;
  } else if (taxonomy && !taxonomy.genres.length && !registryCategory) {
    const direct = classifyExplicitEventDiscovery({ ...candidate, currentTaxonomy: taxonomy });
    const evidence = direct?.evidence.filter(claim => claim.kind === "genre" && hasExplicitGenreEvidence(candidate, claim.source, claim.quote, claim.label as MusicGenre)) ?? [];
    if (evidence.length) {
      const genres = [...new Set(evidence.map(claim => claim.label as MusicGenre))].slice(0, 5);
      taxonomy = { ...taxonomy, genres };
      await ctx.db.patch(row!._id, { taxonomy, auditJson: serializeGenreAudit({ ...audit,
        evidence: [...readPriorityEvidence(row!.auditJson).filter(c => c.kind !== "genre"), ...evidence] }, undefined) });
      flags.directGenreWritten = true;
    }
  }
  if (taxonomy && !getPerformerGenreResearchFormat(taxonomy) && (!registryCategory || provesCategory)) {
    await setIngestionWork(ctx, event, false, now);
    return flags;
  }
  const research = await loadGenreResearch(ctx, event._id);
  const genuine = research?.model !== REGISTRY_MODEL && researchIsCurrent(research, event.updatedAt) && !!research?.matches.length;
  const programme = await usableRegistryProgramme(ctx, event, candidate, taxonomy);
  if (!known || (registryCategory && !provesCategory)) {
    const category = programme.category;
    if (category) {
      taxonomy = { primaryCategory: category, categories: [category], formats: [], genres: [] };
      if (!known || current?.taxonomy?.primaryCategory !== category) {
        const retained = Array.isArray(audit.scopedProgrammeGenres) ? scopedProof(event, candidate, taxonomy) : [];
        if (retained.length) taxonomy = { ...taxonomy, genres: retained.map(claim => claim.label as MusicGenre) };
        const value = { eventId: event._id, eventUpdatedAt: event.updatedAt, version: EVENT_DISCOVERY_VERSION, model: REGISTRY_MODEL,
          taxonomy, auditJson: JSON.stringify({ performerRegistryCategory: true, source: "performer-registry", ...(retained.length ? { evidence: retained } : {}) }) };
        if (row) await ctx.db.replace(row._id, value);
        else await ctx.db.insert("eventDiscoveryLabels", value);
        flags.categoryWritten = true;
      }
      known = true;
    } else if (registryCategory && row) {
      await ctx.db.patch(row._id, { taxonomy: null, auditJson: "{}" });
      known = false;
      taxonomy = null;
    }
  }
  if (!known && (!current?.taxonomy || registryCategory)) {
    const proof = scopedProof(event, candidate, getStoredOrLegacyEventTaxonomy(event));
    if (proof.length) {
      if (JSON.stringify(audit.scopedProgrammeGenres) !== JSON.stringify(proof)) {
        const auditJson = JSON.stringify({ ...audit, scopedProgrammeGenres: proof });
        if (current && !registryCategory) await ctx.db.patch(current._id, { auditJson });
        else {
          const value = { eventId: event._id, eventUpdatedAt: event.updatedAt, version: EVENT_DISCOVERY_VERSION,
            model: LOCAL_MODEL, taxonomy: null, auditJson: JSON.stringify({ scopedProgrammeGenres: proof }) };
          if (row) await ctx.db.replace(row._id, value);
          else await ctx.db.insert("eventDiscoveryLabels", value);
        }
        flags.directGenreWritten = true;
      }
      await setIngestionWork(ctx, event, false, now);
      return flags;
    }
    if (current && !current.taxonomy && Array.isArray(audit.scopedProgrammeGenres)) {
      delete audit.scopedProgrammeGenres;
      await ctx.db.patch(current._id, { auditJson: JSON.stringify(audit) });
    }
  }
  const canUseGenres = getPerformerGenreResearchFormat(taxonomy ?? getStoredOrLegacyEventTaxonomy(event));
  const cacheHit = canUseGenres && programme.matches.length > 0;
  if (!genuine && cacheHit && (!researchIsCurrent(research, event.updatedAt) || research?.model !== REGISTRY_MODEL ||
    JSON.stringify(research.matches) !== JSON.stringify(programme.matches))) {
    if (!known && !labelIsCurrent(row, event.updatedAt)) {
      const empty = { eventId: event._id, eventUpdatedAt: event.updatedAt, version: EVENT_DISCOVERY_VERSION, model: LOCAL_MODEL, taxonomy: null, auditJson: "{}" };
      if (row) await ctx.db.replace(row._id, empty);
      else await ctx.db.insert("eventDiscoveryLabels", empty);
    }
    const value = { eventId: event._id, eventUpdatedAt: event.updatedAt, version: PERFORMER_GENRE_RESEARCH_VERSION,
      researchedAt: now, model: REGISTRY_MODEL, matches: programme.matches, auditJson: JSON.stringify({ source: "performer-registry" }) };
    if (research) await ctx.db.replace(research._id, value);
    else await ctx.db.insert("eventPerformerGenreResearch", value);
    flags.registryGenreWritten = true;
  } else if (research?.model === REGISTRY_MODEL && !cacheHit) {
    await ctx.db.delete(research._id);
  }
  await setIngestionWork(ctx, event, !known || (!!canUseGenres && !genuine && !cacheHit), now,
    flags.categoryWritten || dueForFirstBilledReview(event, taxonomy, audit, now, candidate.performerHandles) || typeof audit.upcomingGenreRetryAt !== "number" ? now : audit.upcomingGenreRetryAt,
    !known ? "category" : event.artists.length ? "performer_genre" : "listing_genre");
  return flags;
}

export const processPublishedEvent = internalMutation({
  args: { eventId: v.id("events") }, returns: v.null(),
  handler: async (ctx, { eventId }) => {
    await syncPerformerRegistryForEvent(ctx, eventId);
    const event = await ctx.db.get(eventId);
    if (event && await isUpcomingDiscoveryPublic(ctx, event, event.date)) {
      await enrichFromAvailableEvidence(ctx, event, Date.now());
    } else {
      const work = await ingestionWork(ctx, eventId);
      if (work) await ctx.db.delete(work._id);
    }
    return null;
  },
});

export const backfillPublishedDiscovery = internalMutation({
  args: { fromDate: v.string(), throughDate: v.string(), cursor: v.union(v.null(), v.string()) },
  returns: v.object({ cursor: v.union(v.string(), v.null()), scanned: v.number(), categoryWritten: v.number(),
    directGenreWritten: v.number(), registryGenreWritten: v.number() }),
  handler: async (ctx, { fromDate, throughDate, cursor }) => {
    requireUpcomingDate(fromDate);
    requireUpcomingDate(throughDate);
    if (fromDate > throughDate) throw new Error("Invalid discovery backfill range.");
    const pageOptions = { cursor, numItems: 4, maximumBytesRead: 1_500_000 };
    const page = await ctx.db.query("events").withIndex("by_publicationState_date", q =>
      q.eq("publicationState", "publishable").gte("date", fromDate).lte("date", throughDate)).paginate(pageOptions);
    const counts = { scanned: page.page.length, categoryWritten: 0, directGenreWritten: 0, registryGenreWritten: 0 };
    for (const event of page.page) {
      if (!await isUpcomingDiscoveryPublic(ctx, event, fromDate)) continue;
      await syncPerformerRegistryForEvent(ctx, event._id);
      const flags = await enrichFromAvailableEvidence(ctx, event, Date.now());
      for (const key of ["categoryWritten", "directGenreWritten", "registryGenreWritten"] as const) if (flags[key]) counts[key]++;
    }
    return { ...counts, cursor: page.isDone ? null : page.continueCursor };
  },
});

// A separate opt-in RPC keeps older web workers on their existing contract during rollout.
export const claimPriorityCategories = mutation({
  args: { serviceSecret: v.string(), owner: v.string(), allowModel: v.boolean() },
  returns: v.object({ events: v.array(upcomingInput), more: v.boolean(), counts: priorityCounts }),
  handler: async (ctx, { serviceSecret, owner, allowModel }) => {
    await requireAdminOrServiceSecret(ctx, serviceSecret);
    if (!/^[0-9a-f-]{36}$/iu.test(owner)) throw new Error("Invalid category enrichment owner.");
    const state = await loadEnrichmentState(ctx);
    const now = Date.now();
    const counts = { scanned: 0, eligible: 0, known: 0, written: 0, attempted: 0, unresolved: 0 };
    const events: Awaited<ReturnType<typeof discoveryCandidate>>[] = [];
    if (state?.lease && state.lease.until > now) return { counts, events, more: false };
    const window = categoryWindow(now), budgets = discoveryBudgets(now, state);
    // Old cursors used a single model pass. Restart those on the highest tier,
    // as well as scans whose civil-day bounds have changed since the last call.
    const saved = state?.categoryScan;
    const scan = saved?.phase && saved.fromDate === window.fromDate && saved.throughDate === window.throughDate ? saved : undefined;
    if (scan?.completedAt && now - scan.completedAt < CATEGORY_RESCAN_MS) return { counts, events, more: false };
    const phase = scan?.completedAt ? "confirmed" : scan?.phase ?? "confirmed";
    const { fromDate, throughDate } = window;
    const lower = phase === "confirmed" ? fromDate : phase === "undated" ? addDaysToDateKey(fromDate, 1) : throughDate;
    const upper = phase === "undated" ? addDaysToDateKey(throughDate, -1) : throughDate;
    const page = await ctx.db.query("events").withIndex("by_publicationState_date", q =>
      q.eq("publicationState", "publishable").gte("date", lower).lte("date", upper)).paginate({
      cursor: scan?.cursor ?? null, numItems: 12,
    });
    const attempts = new Map((state?.categoryAttempts ?? []).filter(item => item.at > now - 4 * 86_400_000)
      .map(item => [item.eventId, item]));
    for (const event of page.page) {
      counts.scanned++;
      const tier = window.tier(event);
      if (!tier || (phase !== "confirmed" && tier !== phase) || !await isUpcomingDiscoveryPublic(ctx, event, fromDate)) continue;
      counts.eligible++;
      const label = await loadLabel(ctx, event._id);
      if (hasKnownCategory(label, event)) { counts.known++; continue; }
      const candidate = await discoveryCandidate(ctx, event);
      if (hasConflictingProgrammeEvidence(candidate)) { counts.unresolved++; continue; }
      const explicit = classifyExplicitEventDiscovery(candidate);
      if (explicit && (explicit.complete || (explicit.titleCategory && explicit.taxonomy.categories.length === 1)) &&
        explicit.evidence.some(c => c.kind === "category" && c.label === explicit.taxonomy.primaryCategory)) {
        await savePriorityCategory(ctx, event, label, candidate, explicit.taxonomy,
          explicit.evidence, "explicit-priority-category-v1");
        counts.written++;
        continue;
      }
      const programme = await lookupPerformerRegistryProgramme(ctx, event, candidate.performerHandles ?? []);
      if (programme.category) {
        const applied = await enrichFromAvailableEvidence(ctx, event, now);
        if (applied.categoryWritten) { counts.written++; continue; }
      }
      counts.unresolved++;
      const old = attempts.get(event._id);
      const same = old && old.version === PRIORITY_CATEGORY_VERSION && old.updatedAt === event.updatedAt ? old : undefined;
      if (tier !== phase || !allowModel || events.length >= budgets.urgent || (same && (same.tries >= 2 || now - same.at < ENRICHMENT_RETRY_MS))) continue;
      attempts.set(event._id, { eventId: event._id, updatedAt: event.updatedAt, version: PRIORITY_CATEGORY_VERSION,
        at: now, tries: (same?.tries ?? 0) + 1 });
      events.push(candidate);
    }
    counts.attempted = events.length;
    const remaining = budgets.remaining - events.length;
    const canSpendLater = allowModel && remaining > 0 && budgets.priority.attempted + events.length < 72;
    let nextPhase: CategoryScanPhase | undefined;
    if (!page.isDone) {
      if (phase === "confirmed" || canSpendLater) nextPhase = phase;
    } else if (canSpendLater) {
      if (phase === "confirmed") nextPhase = "undated";
      if (phase === "undated") nextPhase = "boundary";
    }
    const more = nextPhase !== undefined;
    // Keep a scarce last batch across cron ticks and old web callers. The hold
    // expires if priority scanning stops; it never extends a model lease.
    const reserve = more && allowModel && budgets.urgent > 0 && remaining > 0 && remaining <= 12;
    const categoryScan = { fromDate, throughDate, phase: nextPhase ?? phase, cursor: more && !page.isDone ? page.continueCursor : null,
      ...(reserve ? { reserveUntil: now + 20 * 60_000 } : {}), ...(!more ? { completedAt: now } : {}) };
    const lease = events.length ? { owner, until: now + ENRICHMENT_LEASE_MS, categoryOnly: true as const, nextCursor: null,
      events: events.map(({ key, expectedUpdatedAt }) => ({ eventId: key, expectedUpdatedAt })) } : undefined;
    const next = { dayKey: budgets.dayKey, attempted: budgets.total + events.length, categoryScan,
      categoryAttempts: [...attempts.values()], categoryBudget: { dayKey: budgets.dayKey,
        attempted: budgets.priority.attempted + events.length, consecutive: budgets.priority.consecutive + (lease ? 1 : 0) } };
    if (state) await ctx.db.patch(state._id, { ...next, lease });
    else await ctx.db.insert("eventDiscoveryEnrichmentState", { key: "upcoming", fromDate: getNightlifeDefaultDateKey(new Date(now)),
      cursor: null, ...next, ...(lease ? { lease } : {}) });
    return { events, more, counts };
  },
});

export const claimUpcomingBatch = mutation({
  args: { serviceSecret: v.string(), owner: v.string() },
  returns: v.object({ state: v.union(v.literal("busy"), v.literal("idle"), v.literal("scanned"), v.literal("claimed")),
    events: v.array(upcomingInput) }),
  handler: async (ctx, { serviceSecret, owner }) => {
    await requireAdminOrServiceSecret(ctx, serviceSecret);
    if (!/^[0-9a-f-]{36}$/iu.test(owner)) throw new Error("Invalid genre enrichment owner.");
    const state = await loadEnrichmentState(ctx);
    const now = Date.now();
    if (state?.lease && state.lease.until > now) return { state: "busy" as const, events: [] };
    const { dayKey, total: attempted, general: budget, remaining, urgent, priority } = discoveryBudgets(now, state);
    const reserved = urgent > 0 && remaining <= 12 && (state?.categoryScan?.reserveUntil ?? 0) > now;
    if (budget <= 0 || reserved) return { state: "idle" as const, events: [] };
    const cursor = state?.cursor ?? null;
    const fromDate = cursor && state ? state.fromDate : getNightlifeDefaultDateKey(new Date(now));
    const limit = Math.min(4, budget);
    const queue: Doc<"eventDiscoveryIngestionQueue">[] = [];
    for (const tier of [0, 1, 2]) {
      queue.push(...await ctx.db.query("eventDiscoveryIngestionQueue").withIndex("by_priority_readyAt", q =>
        q.eq("priority", tier).lte("readyAt", now)).take(limit - queue.length));
      if (queue.length === limit) break;
    }
    const ready: Doc<"events">[] = [];
    for (const item of queue) {
      const event = await ctx.db.get(item.eventId);
      if (!event || !await isUpcomingDiscoveryPublic(ctx, event, getNightlifeDefaultDateKey(new Date(now)))) {
        await ctx.db.delete(item._id);
        continue;
      }
      await enrichFromAvailableEvidence(ctx, event, now);
      const pending = await ingestionWork(ctx, event._id);
      if (!pending || pending.readyAt > now) continue;
      await ctx.db.patch(pending._id, { lastAttemptAt: now, readyAt: now + ENRICHMENT_RETRY_MS });
      ready.push(event);
    }
    const page = ready.length ? null : await ctx.db.query("events").withIndex("by_publicationState_date", (q) =>
      q.eq("publicationState", "publishable").gte("date", fromDate)).paginate({ cursor, numItems: Math.min(12, budget) });
    const events = (await Promise.all((page ? page.page : ready).map(async (event) => {
      if (page) {
        const queued = await ingestionWork(ctx, event._id);
        if (queued?.eventUpdatedAt === event.updatedAt && queued.lastAttemptAt &&
          queued.lastAttemptAt + ENRICHMENT_RETRY_MS > now) return null;
      }
      let discovery = await upcomingEnrichmentState(ctx, event, now);
      if (!discovery) return null;
      const candidate = await discoveryCandidate(ctx, event);
      if (page) {
        const programme = await lookupPerformerRegistryProgramme(ctx, event, candidate.performerHandles ?? []);
        if (programme.category || programme.matches.length) {
          await enrichFromAvailableEvidence(ctx, event, now);
          discovery = await upcomingEnrichmentState(ctx, event, now);
          if (!discovery) return null;
        }
      }
      const performerSearchHints = await lookupPerformerRegistrySearchHints(ctx, event, candidate.performerHandles ?? []);
      return { ...candidate,
        ...(performerSearchHints.length ? { performerSearchHints } : {}),
        ...(discovery.preferPerformerResearch ? { preferPerformerResearch: true } : {}),
        ...(discovery.currentTaxonomy ? { currentTaxonomy: discovery.currentTaxonomy } : {}) };
    }))).filter((event) => event !== null);
    const nextCursor = page ? (page.isDone ? null : page.continueCursor) : cursor;
    const lease = events.length ? { owner, until: now + ENRICHMENT_LEASE_MS, nextCursor,
      events: events.map(({ key, expectedUpdatedAt }) => ({ eventId: key, expectedUpdatedAt })) } : undefined;
    const updated = { fromDate, cursor: lease ? cursor : nextCursor, dayKey, attempted: attempted + events.length,
      categoryBudget: { ...priority, consecutive: 0 } };
    if (state) await ctx.db.patch(state._id, { ...updated, lease });
    else await ctx.db.insert("eventDiscoveryEnrichmentState", { key: "upcoming", ...updated, ...(lease ? { lease } : {}) });
    return { state: lease ? "claimed" as const : nextCursor ? "scanned" as const : "idle" as const, events };
  },
});

export const completeUpcomingBatch = mutation({
  args: { serviceSecret: v.string(), owner: v.string(), model: v.string(), results: v.array(genreDiscoveryResult) },
  returns: v.object({ completed: v.boolean(), counts: genreDiscoveryCounts }),
  handler: async (ctx, { serviceSecret, owner, model, results }) => {
    await requireAdminOrServiceSecret(ctx, serviceSecret);
    validateGenreDiscoveryBatch(model, results);
    const state = await loadEnrichmentState(ctx);
    const lease = state?.lease;
    const now = Date.now();
    const counts = { written: 0, unchanged: 0, stale: 0 };
    if (!state || !lease || lease.owner !== owner || lease.until <= now) return { completed: false, counts };
    const claimed = new Map(lease.events.map(({ eventId, expectedUpdatedAt }) => [eventId, expectedUpdatedAt]));
    if (lease.categoryOnly) {
      const window = categoryWindow(now);
      const terminal = new Set<Id<"events">>();
      for (const result of results) {
        const event = await ctx.db.get(result.eventId);
        if (!event || claimed.get(result.eventId) !== result.expectedUpdatedAt || event.updatedAt !== result.expectedUpdatedAt ||
          !window.includes(event) || !await isUpcomingDiscoveryPublic(ctx, event, window.fromDate)) { counts.stale++; continue; }
        if (result.deferred) continue; // The reserved attempt permits one retry after a transient failure.
        terminal.add(event._id);
        const row = await loadLabel(ctx, event._id);
        if (hasKnownCategory(row, event) || !result.taxonomy) { counts.unchanged++; continue; }
        const candidate = await discoveryCandidate(ctx, event);
        const evidence = readPriorityEvidence(result.auditJson);
        const checked = revalidateEventDiscoveryClassification(candidate, { key: event._id, taxonomy: result.taxonomy,
          credits: [], discardedClaims: 0, evidence });
        if (hasConflictingProgrammeEvidence(candidate) || !checked.taxonomy || checked.taxonomy.primaryCategory !== result.taxonomy.primaryCategory ||
          !checked.evidence.some(claim => claim.kind === "category" && claim.label === checked.taxonomy?.primaryCategory)) {
          counts.stale++; continue;
        }
        await savePriorityCategory(ctx, event, row, candidate, checked.taxonomy, checked.evidence, model);
        counts.written++;
      }
      await ctx.db.patch(state._id, { lease: undefined, categoryAttempts: state.categoryAttempts?.map(attempt =>
        terminal.has(attempt.eventId) ? { ...attempt, tries: 2 } : attempt) });
      return { completed: true, counts };
    }
    for (const result of results) {
      const { eventId, expectedUpdatedAt, taxonomy } = result;
      const event = await ctx.db.get(eventId);
      if (!event || claimed.get(eventId) !== expectedUpdatedAt || event.updatedAt !== expectedUpdatedAt ||
        !await isUpcomingDiscoveryPublic(ctx, event, getNightlifeDefaultDateKey(new Date(now)))) {
        counts.stale++;
        continue;
      }
      const enrichment = await upcomingEnrichmentState(ctx, event, now);
      if (!enrichment) {
        counts.unchanged++;
        continue;
      }
      if (await conflictsWithNewClassification(ctx, event, result) ||
        !await captionClaimsAreCurrent(ctx, event, readCaptionClaims(result.auditJson))) {
        counts.stale++;
        continue;
      }
      const confirmed = hasKnownCategory(enrichment.current, event) ? enrichment.current!.taxonomy : null;
      if (confirmed && taxonomy && confirmed.primaryCategory !== taxonomy.primaryCategory) {
        counts.stale++;
        continue;
      }
      const savedTaxonomy = confirmed ? { ...confirmed, genres: confirmed.genres.length ? confirmed.genres : taxonomy?.genres ?? [] } :
        taxonomy ?? enrichment.current?.taxonomy ?? null;
      const { estimatedGenres, webResearch } = verifiedGenreFallback(event, savedTaxonomy ?? getStoredOrLegacyEventTaxonomy(event), result);
      const currentAudit = enrichmentAudit(result, now);
      const previousEstimate = enrichment.current && !currentAudit.partialProgramme && !currentAudit.ambiguousPerformerIdentity
        ? readEstimatedGenres(enrichment.current.auditJson) : undefined;
      const audit = { ...readEventEvidenceRecord(enrichment.current?.auditJson), ...currentAudit };
      const prior = enrichment.current && readPriorityEvidence(enrichment.current.auditJson).filter(claim =>
        (claim.kind === "category" && savedTaxonomy?.categories.some(label => label === claim.label)) ||
        (claim.kind === "format" && savedTaxonomy?.formats.some(label => label === claim.label)));
      if (prior?.length) {
        const source = await discoveryCandidate(ctx, event);
        const retained = prior.filter(claim => source[claim.source]?.includes(claim.quote) && discoveryQuoteMatchesOccurrence(claim.quote, event.date));
        const combined = [...retained, ...readPriorityEvidence(result.auditJson)];
        audit.evidence = [...new Map(combined.map(c => [JSON.stringify([c.kind, c.label, c.source, c.quote]), c])).values()];
      }
      const label = { eventId, eventUpdatedAt: event.updatedAt, version: EVENT_DISCOVERY_VERSION, model,
        taxonomy: savedTaxonomy, auditJson: serializeGenreAudit(audit, webResearch || savedTaxonomy?.genres.length ? undefined :
          estimatedGenres ?? previousEstimate) };
      if (enrichment.row) await ctx.db.replace(enrichment.row._id, label);
      else await ctx.db.insert("eventDiscoveryLabels", label);
      if (webResearch) await storeWebGenreResearch(ctx, event, webResearch);
      else if (hasPerformerEvidence(result.auditJson)) await schedulePublishedDiscovery(ctx, event._id);
      const needsRetry = !savedTaxonomy || (!savedTaxonomy.genres.length && !webResearch && !!getPerformerGenreResearchFormat(savedTaxonomy));
      await setIngestionWork(ctx, event, needsRetry || !!result.deferred, now,
        now + (result.deferred ? ENRICHMENT_RETRY_MS : EMPTY_RESEARCH_RETRY_MS),
        !savedTaxonomy ? "category" : event.artists.length ? "performer_genre" : "listing_genre");
      counts.written++;
    }
    await ctx.db.patch(state._id, { cursor: lease.nextCursor, lease: undefined });
    return { completed: true, counts };
  },
});

async function loadUnknownGenreState(ctx: Pick<QueryCtx, "db">, event: Doc<"events">) {
  const label = await loadLabel(ctx, event._id);
  const currentLabel = label && labelIsCurrent(label, event.updatedAt) ? label : null;
  const taxonomy = currentLabel?.taxonomy ?? getStoredOrLegacyEventTaxonomy(event);
  if (taxonomy.genres.length) return { label, currentLabel, taxonomy, known: true };
  if (currentLabel && !currentLabel.taxonomy && Array.isArray(readEventEvidenceRecord(currentLabel.auditJson).scopedProgrammeGenres) &&
    (await currentScopedProgrammeGenres(ctx, event, currentLabel)).length) return { label, currentLabel, taxonomy, known: true };
  if (!getPerformerGenreResearchFormat(taxonomy)) return null;
  const known = !!currentLabel && !!projectGenreFallback(taxonomy, currentLabel, await loadGenreResearch(ctx, event._id));
  return { label, currentLabel, taxonomy, known };
}

function assertBackfillCutoff(cutoff: number) {
  if (!Number.isSafeInteger(cutoff) || cutoff <= 0) throw new Error("Invalid genre backfill cutoff.");
}

async function directGenresForBackfill(ctx: MutationCtx, event: Doc<"events">, result: GenreDiscoveryResult) {
  const captionClaims = readCaptionClaims(result.auditJson);
  if (!await captionClaimsAreCurrent(ctx, event, captionClaims)) return null;
  const claims = readDirectGenreClaims(result.auditJson).filter(({ label }) => result.taxonomy?.genres.includes(label));
  const captionGenres = claims.filter(({ source }) => source === "sourceCaption");
  if (captionGenres.length) {
    return result.taxonomy?.genres.filter((genre) => captionGenres.some(({ label }) => label === genre)) ?? [];
  }
  const evidence = readEventEvidenceRecord(event.normalizedFieldsJson);
  const texts = new Map<string, string | undefined>([["title", event.title], ["description", event.description],
    ["occurrenceText", occurrenceTextFromEvidence(evidence)]]);
  if (claims.some(({ source, quote }) => typeof quote !== "string" || !quote.trim() || !texts.get(source)?.includes(quote))) return null;
  return result.taxonomy?.genres.filter((genre) => claims.some(({ label }) => label === genre)) ?? [];
}

export const listUnknownGenreInputs = query({
  args: { serviceSecret: v.string(), cutoff: v.number(), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ events: v.array(unknownGenreInput), cursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, { serviceSecret, cutoff, cursor }) => {
    await requireAdminOrServiceSecret(ctx, serviceSecret);
    assertBackfillCutoff(cutoff);
    const page = await ctx.db.query("events").withIndex("by_creation_time", (q) => q.lte("_creationTime", cutoff))
      .paginate({ cursor, numItems: 48 });
    const events = await Promise.all(page.page.map(async (event) => {
      if (event.status !== "approved" || event.publicationState !== "publishable") return null;
      const state = await loadUnknownGenreState(ctx, event);
      if (!state || state.known) return null;
      return { ...await discoveryCandidate(ctx, event), currentTaxonomy: state.taxonomy };
    }));
    return { events: events.filter((event) => event !== null), cursor: page.isDone ? null : page.continueCursor };
  },
});

export const recordUnknownGenreBatch = mutation({
  args: { serviceSecret: v.string(), cutoff: v.number(), model: v.string(), results: v.array(genreDiscoveryResult) },
  returns: genreDiscoveryCounts,
  handler: async (ctx, { serviceSecret, cutoff, model, results }) => {
    await requireAdminOrServiceSecret(ctx, serviceSecret);
    assertBackfillCutoff(cutoff);
    validateGenreDiscoveryBatch(model, results);
    const counts = { written: 0, unchanged: 0, stale: 0 };
    for (const result of results) {
      const { eventId, expectedUpdatedAt, auditJson } = result;
      const event = await ctx.db.get(eventId);
      if (!event || event.updatedAt !== expectedUpdatedAt || event._creationTime > cutoff ||
        event.status !== "approved" || event.publicationState !== "publishable") {
        counts.stale++;
        continue;
      }
      const state = await loadUnknownGenreState(ctx, event);
      if (!state) {
        counts.stale++;
        continue;
      }
      if (state.known) {
        counts.unchanged++;
        continue;
      }

      const advertisedGenres = await directGenresForBackfill(ctx, event, result);
      if (advertisedGenres === null) {
        counts.stale++;
        continue;
      }
      const { estimatedGenres, webResearch } = advertisedGenres.length ? {} : verifiedGenreFallback(event, state.taxonomy, result);
      if (!advertisedGenres.length && !estimatedGenres && !webResearch) {
        counts.unchanged++;
        continue;
      }

      if (!state.currentLabel || advertisedGenres.length || estimatedGenres) {
        const audit = readEventEvidenceRecord(state.label?.auditJson);
        const data = { eventId, eventUpdatedAt: event.updatedAt, version: EVENT_DISCOVERY_VERSION,
          model: state.currentLabel?.model ?? model,
          taxonomy: advertisedGenres.length ? { ...state.taxonomy, genres: advertisedGenres } : state.currentLabel?.taxonomy ?? null,
          auditJson: serializeGenreAudit({ ...audit, genreBackfill: { model, ...readEventEvidenceRecord(auditJson) } }, estimatedGenres) };
        if (state.label) await ctx.db.replace(state.label._id, data);
        else await ctx.db.insert("eventDiscoveryLabels", data);
      }
      if (webResearch) await storeWebGenreResearch(ctx, event, webResearch);
      else if (hasPerformerEvidence(result.auditJson)) await schedulePublishedDiscovery(ctx, event._id);
      counts.written++;
    }
    return counts;
  },
});

function categoryRefreshDate(fromDate?: string) {
  const today = getBelgradeDayKey();
  const date = requireUpcomingDate(fromDate ?? today);
  if (date < today) throw new Error("Category refresh starts on the current Belgrade date or later.");
  return date;
}

function pickCategoryState({ primaryCategory, categories, formats }: EventDiscoveryTaxonomy): CategoryState {
  return { primaryCategory, categories, formats };
}

function sameCategoryState(first: CategoryState, second: CategoryState) {
  return first.primaryCategory === second.primaryCategory &&
    first.categories.length === second.categories.length && first.categories.every((category, index) => category === second.categories[index]) &&
    first.formats.length === second.formats.length && first.formats.every((format, index) => format === second.formats[index]);
}

async function isUpcomingDiscoveryPublic(ctx: Pick<QueryCtx, "db">, event: Doc<"events">, fromDate: string) {
  if (event.date < fromDate || event.status !== "approved" || event.publicationState !== "publishable" ||
    event.publicationPolicyVersion !== PUBLICATION_POLICY_VERSION ||
    event.publicationReason !== "canonical_source_grounding_verified" || !event.venueId) return false;
  const venue = await ctx.db.get(event.venueId);
  return !!venue && isVenuePublic(venue);
}

async function upcomingDiscoveryChange(ctx: Pick<QueryCtx, "db">, event: Doc<"events">) {
  const label = await loadLabel(ctx, event._id);
  const currentLabel = label && labelIsCurrent(label, event.updatedAt) ? label : null;
  const current = currentLabel?.taxonomy ?? getStoredOrLegacyEventTaxonomy(event);
  const before = pickCategoryState(current);
  const candidate = await discoveryCandidate(ctx, event);
  const classified = classifyExplicitEventDiscovery(candidate);
  if (!classified?.complete) return { outcome: "inconclusive" } as const;
  const after = pickCategoryState(classified.taxonomy);
  const evidence = classified.evidence.filter(({ kind }) => kind !== "genre");
  if (!after.categories.every((category) => evidence.some(({ kind, label }) => kind === "category" && label === category)) ||
    !after.formats.every((format) => evidence.some(({ kind, label }) => kind === "format" && label === format)) ||
    evidence.some(({ source, quote }) => !quote.trim() || !candidate[source]?.includes(quote))) {
    return { outcome: "inconclusive" } as const;
  }
  if (sameCategoryState(before, after)) return { outcome: "unchanged", after } as const;
  // A partial excerpt may confirm one activity without describing everything
  // on the program. Leave removals of existing specific labels for review.
  if (before.formats.some((format) => !after.formats.includes(format)) ||
    (before.categories.length > 1 && before.categories.some((category) => category !== "other" && !after.categories.includes(category)))) {
    return { outcome: "needsReview" } as const;
  }

  if (!after.categories.some((category) => category === "party" || category === "live")) {
    const hadMusic = before.categories.some((category) => category === "party" || category === "live");
    if (current.genres.length || (hadMusic && currentLabel &&
      projectGenreFallback(current, currentLabel, await loadGenreResearch(ctx, event._id)))) {
      return { outcome: "needsReview" } as const;
    }
  }
  // A former talk-only label with no program format can be corrected in one
  // write when the title explicitly bills live music and names its genre.
  // Other category refreshes continue to preserve genres as recorded.
  const titleGenreEvidence = before.primaryCategory === "talk" && before.categories.length === 1 &&
    !before.formats.length && !current.genres.length && classified.titleCategory === "live" &&
    !after.categories.includes("talk")
    ? classified.evidence.filter((claim) => claim.kind === "genre" && claim.source === "title" &&
      claim.quote.trim() && candidate.title.includes(claim.quote))
    : [];
  const genres = titleGenreEvidence.length
    ? classified.taxonomy.genres.filter((genre) => titleGenreEvidence.some(({ label }) => label === genre))
    : current.genres;
  const proposalEvidence = [...evidence, ...titleGenreEvidence];
  return { outcome: "proposed", before, after, evidence: proposalEvidence, genres, label, currentLabel } as const;
}

export const listUpcomingDiscoveryRefresh = query({
  args: { serviceSecret: v.string(), fromDate: v.optional(v.string()), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ fromDate: v.string(), cursor: v.union(v.string(), v.null()), proposals: v.array(categoryRefreshProposal),
    counts: v.object({ scanned: v.number(), eligible: v.number(), proposed: v.number(), unchanged: v.number(),
      inconclusive: v.number(), needsReview: v.number() }) }),
  handler: async (ctx, { serviceSecret, fromDate, cursor }) => {
    await requireAdminOrServiceSecret(ctx, serviceSecret);
    const date = categoryRefreshDate(fromDate);
    const page = await upcomingEvents(ctx, date).paginate({ cursor, numItems: 24 });
    const changes = await Promise.all(page.page.map(async (event) =>
      await isUpcomingDiscoveryPublic(ctx, event, date) ? { event, change: await upcomingDiscoveryChange(ctx, event) } : null));
    const counts = { scanned: page.page.length, eligible: 0, proposed: 0, unchanged: 0, inconclusive: 0, needsReview: 0 };
    const proposals = changes.flatMap((entry) => {
      if (!entry) return [];
      const { event, change } = entry;
      counts.eligible++;
      counts[change.outcome]++;
      if (change.outcome !== "proposed") return [];
      return [{ eventId: event._id, expectedUpdatedAt: event.updatedAt, title: event.title, date: event.date,
        before: change.before, after: change.after, evidence: change.evidence }];
    });
    return { fromDate: date, cursor: page.isDone ? null : page.continueCursor, proposals, counts };
  },
});

export const refreshUpcomingDiscoveryBatch = mutation({
  args: { serviceSecret: v.string(), fromDate: v.optional(v.string()), proposals: v.array(v.object(categoryRefreshFields)) },
  returns: v.object({ written: v.number(), unchanged: v.number(), stale: v.number(), needsReview: v.number() }),
  handler: async (ctx, { serviceSecret, fromDate, proposals }) => {
    await requireAdminOrServiceSecret(ctx, serviceSecret);
    const date = categoryRefreshDate(fromDate);
    if (proposals.length > 12 || new Set(proposals.map(({ eventId }) => eventId)).size !== proposals.length) {
      throw new Error("Invalid upcoming category refresh batch.");
    }
    const counts = { written: 0, unchanged: 0, stale: 0, needsReview: 0 };
    for (const { eventId, expectedUpdatedAt, before, after } of proposals) {
      const event = await ctx.db.get(eventId);
      if (!event || event.updatedAt !== expectedUpdatedAt || !await isUpcomingDiscoveryPublic(ctx, event, date)) {
        counts.stale++;
        continue;
      }
      const change = await upcomingDiscoveryChange(ctx, event);
      if (change.outcome === "needsReview") {
        counts.needsReview++;
        continue;
      }
      if (change.outcome === "unchanged" && sameCategoryState(change.after, after)) {
        counts.unchanged++;
        continue;
      }
      if (change.outcome !== "proposed" || !sameCategoryState(change.before, before) || !sameCategoryState(change.after, after)) {
        counts.stale++;
        continue;
      }

      const auditJson = change.currentLabel?.auditJson ?? "";
      const estimate = readEstimatedGenres(auditJson);
      const data = { eventId, eventUpdatedAt: event.updatedAt, version: EVENT_DISCOVERY_VERSION,
        model: change.currentLabel?.model ?? "explicit-category-refresh-v1",
        taxonomy: { ...after, genres: change.genres },
        auditJson: serializeGenreAudit({ ...readEventEvidenceRecord(auditJson), categoryRefresh: { evidence: change.evidence } },
          estimate.length ? estimate : undefined) };
      if (change.label) await ctx.db.replace(change.label._id, data);
      else await ctx.db.insert("eventDiscoveryLabels", data);
      counts.written++;
    }
    return counts;
  },
});
