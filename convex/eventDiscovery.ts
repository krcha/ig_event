import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireAdminOrServiceSecret } from "./authz";
import { eventDiscoveryTaxonomy, musicGenre, performerGenreMatch } from "./eventDiscoveryValues";
import { canonicalizeSourceUrl } from "../lib/domain/source-url";
import { readEventEvidenceRecord } from "../lib/events/confirmed-event-schema-facts";
import { formatUtcDateKey, parseDateKeyToUtcNoon } from "../lib/events/nightlife-date";
import { EVENT_DISCOVERY_VERSION, getEventDiscoveryTaxonomy, MUSIC_GENRES, type EventDiscoveryTaxonomy, type MusicGenre } from "../lib/taxonomy/event-discovery";
import {
  EMPTY_RESEARCH_RETRY_MS,
  PERFORMER_GENRE_RESEARCH_VERSION,
  applyPerformerGenreResearch,
  canPublishPerformerGenreSource,
  getPerformerGenreResearchActs,
  getPerformerGenreResearchFormat,
} from "../lib/taxonomy/performer-genre-research";

const CAPTION_MAX_LENGTH = 2200;
const genreKeys: ReadonlySet<string> = new Set(MUSIC_GENRES.map(({ key }) => key));

const eventInputFields = {
  key: v.id("events"),
  expectedUpdatedAt: v.number(),
  title: v.string(),
  description: v.optional(v.string()),
  occurrenceText: v.optional(v.string()),
  venue: v.string(),
  artists: v.array(v.string()),
};
const eventInput = v.object(eventInputFields);
const discoveryInputFields = {
  ...eventInputFields, date: v.string(), eventType: v.string(), sourceCaption: v.optional(v.string()),
};
const dailyInput = v.object(discoveryInputFields);
const unknownGenreInput = v.object({ ...discoveryInputFields, currentTaxonomy: eventDiscoveryTaxonomy });
const webGenreResult = v.object({ model: v.string(), matches: v.array(performerGenreMatch), auditJson: v.string() });
const genreDiscoveryResult = v.object({
  eventId: v.id("events"), expectedUpdatedAt: v.number(), taxonomy: v.union(eventDiscoveryTaxonomy, v.null()),
  auditJson: v.string(), estimatedGenres: v.optional(v.array(musicGenre)), webResearch: v.optional(webGenreResult),
});
const genreDiscoveryCounts = v.object({ written: v.number(), unchanged: v.number(), stale: v.number() });
type GenreDiscoveryResult = Infer<typeof genreDiscoveryResult>;
type WebGenreResult = Infer<typeof webGenreResult>;

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

async function readScopedInstagramCaption(
  ctx: Pick<QueryCtx, "db">, event: Doc<"events">, fields: Record<string, unknown>,
) {
  const raw = event.sourceCaption?.trim().slice(0, CAPTION_MAX_LENGTH);
  const source = canonicalizeSourceUrl("instagram", event.instagramPostUrl ?? event.canonicalSourceUrl);
  if (!raw || !source.ok || fields.sourceOccurrencePlanUnverified === true) return;
  const sharedByEvidence = fields.multiEventSplitDetected === true || fields.dateRangeExpanded === true ||
    ["multiEventSplitCount", "splitEventTotal", "dateRangeExpandedCount", "expandedDateTotal"].some((key) => {
      const count = fields[key];
      return typeof count === "number" && count > 1;
    });
  const sharedByIndex = async () => {
    const other = (rows: Doc<"events">[]) => rows.some(({ _id }) => _id !== event._id);
    if (event.instagramPostId && other(await ctx.db.query("events").withIndex("by_instagramPostId", (q) =>
      q.eq("instagramPostId", event.instagramPostId)).take(2))) return true;
    const { canonicalUrl } = source.value;
    if (event.canonicalSourceUrl === canonicalUrl) {
      return other(await ctx.db.query("events").withIndex("by_canonicalSourceUrl", (q) =>
        q.eq("canonicalSourceUrl", canonicalUrl)).take(2));
    }
    if (event.normalizedInstagramPostUrl === canonicalUrl) {
      return other(await ctx.db.query("events").withIndex("by_normalizedInstagramPostUrl", (q) =>
        q.eq("normalizedInstagramPostUrl", canonicalUrl)).take(2));
    }
    const originalUrl = event.instagramPostUrl;
    return !!originalUrl && other(await ctx.db.query("events").withIndex("by_instagramPostUrl", (q) =>
      q.eq("instagramPostUrl", originalUrl)).take(2));
  };
  if (!sharedByEvidence && !await sharedByIndex()) return raw;

  // Shared posts can contain several lineups. Reuse only evidence assigned to
  // this occurrence during extraction and present verbatim in the source.
  const excerpts = [fields.rowSourceText, fields.splitSourceLine];
  if (Array.isArray(fields.carouselTextEvidence)) {
    for (const item of fields.carouselTextEvidence.slice(0, 8)) {
      if (item?.source === "caption") excerpts.push(item.text);
    }
  }
  const exact = excerpts.flatMap((item) => {
    const text = typeof item === "string" ? item.trim() : "";
    return text && text !== raw && raw.includes(text) ? [text] : [];
  });
  const scoped = [...new Set(exact)].join("\n\n").slice(0, CAPTION_MAX_LENGTH);
  return scoped || undefined;
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

function occurrenceTextFromEvidence(evidence: Record<string, unknown>) {
  const row = evidence.rowSourceText ?? evidence.splitSourceLine;
  return typeof row === "string" && row.trim() ? row.slice(0, 800) : undefined;
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
  const taxonomy = label.taxonomy ?? getEventDiscoveryTaxonomy(event);
  if (includePerformerGenreResearch && getPerformerGenreResearchFormat(taxonomy)) {
    const enriched = projectGenreFallback(taxonomy, label, await loadGenreResearch(ctx, event._id));
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

async function discoveryCandidate(ctx: QueryCtx, event: Doc<"events">) {
  const evidence = readEventEvidenceRecord(event.normalizedFieldsJson);
  const occurrenceText = occurrenceTextFromEvidence(evidence);
  const sourceCaption = await readScopedInstagramCaption(ctx, event, evidence);
  return { key: event._id, expectedUpdatedAt: event.updatedAt, title: event.title, venue: event.venue,
    date: event.date, eventType: event.eventType, artists: event.artists.slice(0, 20),
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
  if (result.estimatedGenres?.length && getPerformerGenreResearchActs(event, format).some(({ titleOnly }) => !titleOnly)) {
    return { estimatedGenres: result.estimatedGenres };
  }
  const webResearch = result.webResearch;
  if (webResearch?.matches.length) {
    const listingActs = getPerformerGenreResearchActs(event, format, true);
    if (webResearch.matches.every(({ performer, url, identityUrl }) => listingActs.some(({ billedName, titleOnly }) =>
      billedName === performer && (!titleOnly || url === identityUrl)))) {
      return { webResearch };
    }
  }
  return {};
}

function serializeGenreAudit(audit: Record<string, unknown>, estimatedGenres: MusicGenre[] | undefined) {
  delete audit.estimatedGenres;
  return JSON.stringify(estimatedGenres ? { estimatedGenres, ...audit } : audit);
}

async function storeWebGenreResearch(ctx: MutationCtx, event: Doc<"events">, webResearch: WebGenreResult) {
  const row = await loadGenreResearch(ctx, event._id);
  if (researchIsCurrent(row, event.updatedAt) && row?.matches.some(({ url, identityUrl }) =>
    canPublishPerformerGenreSource(url) && canPublishPerformerGenreSource(identityUrl))) return;
  const data = { ...webResearch, eventId: event._id, eventUpdatedAt: event.updatedAt,
    version: PERFORMER_GENRE_RESEARCH_VERSION, researchedAt: Date.now() };
  if (row) await ctx.db.replace(row._id, data);
  else await ctx.db.insert("eventPerformerGenreResearch", data);
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
      if (!await cameFromDailyRun(ctx, event, runId, window) || await loadLabel(ctx, event._id)) return null;
      return discoveryCandidate(ctx, event);
    }));
    return { events: events.filter((event) => event !== null), cursor: page.isDone ? null : page.continueCursor };
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
      if (!await captionClaimsAreCurrent(ctx, event, readCaptionClaims(auditJson))) {
        // Another occurrence may have been added while the model was working.
        counts.stale++;
        continue;
      }
      const { estimatedGenres, webResearch } = verifiedGenreFallback(event, taxonomy ?? getEventDiscoveryTaxonomy(event), result);
      await ctx.db.insert("eventDiscoveryLabels", { eventId, eventUpdatedAt: event.updatedAt,
        version: EVENT_DISCOVERY_VERSION, model, taxonomy, auditJson: serializeGenreAudit(readEventEvidenceRecord(auditJson), estimatedGenres) });
      if (webResearch) await storeWebGenreResearch(ctx, event, webResearch);
      counts.written++;
    }
    return counts;
  },
});

async function loadUnknownGenreState(ctx: Pick<QueryCtx, "db">, event: Doc<"events">) {
  const label = await loadLabel(ctx, event._id);
  const currentLabel = label && labelIsCurrent(label, event.updatedAt) ? label : null;
  const taxonomy = currentLabel?.taxonomy ?? getEventDiscoveryTaxonomy(event);
  if (taxonomy.genres.length) return { label, currentLabel, taxonomy, known: true };
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
      counts.written++;
    }
    return counts;
  },
});
