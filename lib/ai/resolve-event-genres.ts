import {
  classifyEventDiscoveryBatch,
  EVENT_DISCOVERY_BATCH_LIMIT,
  type EventDiscoveryBatchResult,
  type EventDiscoveryClassification,
  type EventDiscoveryInput,
  type EventDiscoveryOptions,
} from "@/lib/ai/classify-event-discovery";
import { estimatePerformerGenresBatch } from "@/lib/ai/estimate-performer-genres";
import {
  PERFORMER_GENRE_RESEARCH_BATCH_LIMIT,
  researchPerformerGenresBatch,
  type PerformerGenreResearchInput,
  type PerformerGenreResearchResult,
} from "@/lib/ai/research-performer-genres";
import { getEventDiscoveryTaxonomy, type EventDiscoveryTaxonomy, type MusicGenre } from "@/lib/taxonomy/event-discovery";
import { classifyExplicitEventDiscovery, corroborateLiveProgrammeGenre, getExcludedDiscoveryGenres } from "@/lib/taxonomy/explicit-event-discovery";
import {
  canPublishPerformerGenreSource,
  getEventListingResearchAct,
  getPerformerGenreResearchActs,
  getPerformerGenreResearchFormat,
  type PerformerGenreAct,
  type PerformerGenreFormat,
  type PerformerGenreMatch,
} from "@/lib/taxonomy/performer-genre-research";

export type EventGenreCandidate = EventDiscoveryInput & {
  key: string;
  expectedUpdatedAt: number;
  eventType: string;
  artists: string[];
  venue: string;
  date: string;
  time?: string;
  description?: string;
  currentTaxonomy?: EventDiscoveryTaxonomy;
};

export type EventGenreResolution = {
  eventId: string;
  expectedUpdatedAt: number;
  taxonomy: EventDiscoveryTaxonomy | null;
  auditJson: string;
  estimatedGenres?: MusicGenre[];
  webResearch?: { model: string; matches: PerformerGenreMatch[]; auditJson: string };
  method: "instagram" | "announcement" | "estimate" | "web" | "unknown";
  deferred?: true;
};

type ResolverOptions = EventDiscoveryOptions & {
  deadlineAt?: number;
  classify?: typeof classifyEventDiscoveryBatch;
  estimate?: typeof estimatePerformerGenresBatch;
  research?: typeof researchPerformerGenresBatch;
};
type Lookup = {
  event: EventGenreCandidate;
  result: EventGenreResolution;
  format: PerformerGenreFormat;
  acts: PerformerGenreAct[];
  excludedGenres: ReadonlySet<MusicGenre>;
  discoveryOnly?: true;
};

const DEFAULT_DEADLINE_MS = 220_000;
const WEB_CONCURRENCY = 3;

function providerOptions(options: ResolverOptions, deadlineAt: number): EventDiscoveryOptions {
  const transport = options.fetch ?? fetch;
  const signal = AbortSignal.timeout(Math.max(1, Math.floor(deadlineAt - Date.now())));
  return {
    apiKey: options.apiKey,
    model: options.model,
    beforeTransport: async () => {
      if (Date.now() >= deadlineAt) throw new Error("Event genre provider deadline reached.");
      signal.throwIfAborted();
      await options.beforeTransport?.();
      signal.throwIfAborted();
    },
    fetch: (input, init) => transport(input, {
      ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
    }),
  };
}

function groupWebLookups(lookups: readonly Lookup[]): Lookup[][] {
  const groups: Lookup[][] = [];
  let remaining = 0;
  for (const lookup of lookups) {
    if (lookup.acts.length > remaining) {
      groups.push([]);
      remaining = PERFORMER_GENRE_RESEARCH_BATCH_LIMIT;
    }
    groups.at(-1)!.push(lookup);
    remaining -= lookup.acts.length;
  }
  return groups;
}

function validDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const instant = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === date;
}

function sourcedMatches(acts: readonly PerformerGenreResearchResult[], lookup: Lookup): PerformerGenreMatch[] {
  const listingTitle = getEventListingResearchAct(lookup.event)?.billedName;
  const listing = listingTitle ? acts.find((act) => act.listing?.title === listingTitle)?.listing : undefined;
  if (listing && canPublishPerformerGenreSource(listing.identityEvidence.url)) {
    const url = listing.identityEvidence.url;
    const exactStyles = listing.genreEvidence.filter((proof) => proof.url === url && !lookup.excludedGenres.has(proof.genre));
    if (exactStyles.length) return exactStyles.map(({ genre }) => ({ performer: listing.title, genre, url, identityUrl: url }));
  }
  return acts.flatMap((act, index) => {
    const billed = lookup.acts[index];
    if (act.status !== "resolved" || act.billedName !== billed.billedName || !act.identityEvidence ||
      !canPublishPerformerGenreSource(act.identityEvidence.url)) return [];
    const identityUrl = act.identityEvidence.url;
    return act.genreEvidence.filter(({ url }) => canPublishPerformerGenreSource(url) &&
      (!billed.titleOnly || url === identityUrl)).filter(({ genre }) => !lookup.excludedGenres.has(genre))
      .map(({ genre, url }) => ({ performer: act.billedName, genre, url, identityUrl }));
  });
}

export async function resolveEventGenresBatch(
  events: readonly EventGenreCandidate[], options: ResolverOptions = {},
): Promise<{
  model: string;
  results: EventGenreResolution[];
  usage: EventDiscoveryBatchResult["usage"];
  estimateUsage?: EventDiscoveryBatchResult["usage"];
  searchCalls: number;
  localClassified: number;
}> {
  if (!events.length || events.length > EVENT_DISCOVERY_BATCH_LIMIT || new Set(events.map(({ key }) => key)).size !== events.length) {
    throw new Error("Invalid event discovery batch size or duplicate key.");
  }
  const deadlineAt = options.deadlineAt ?? Date.now() + DEFAULT_DEADLINE_MS;
  const explicit = new Map(events.map((event) => [event.key, classifyExplicitEventDiscovery(event)]));
  const needsModel = events.filter(({ key }) => !explicit.get(key)?.complete);
  const classified = needsModel.length
    ? await (options.classify ?? classifyEventDiscoveryBatch)(needsModel, providerOptions(options, deadlineAt))
    : { model: "explicit-event-evidence", results: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  const byKey = new Map<string | number, EventDiscoveryClassification>(classified.results.map((row) => [row.key, row]));
  if (classified.results.length !== needsModel.length || byKey.size !== needsModel.length || needsModel.some(({ key }) => !byKey.has(key))) {
    throw new Error("Incomplete event genre classification.");
  }
  const lookups: Lookup[] = [];
  const results = events.map((event): EventGenreResolution => {
    const modelRow = byKey.get(event.key);
    const local = explicit.get(event.key);
    const titledCategory = local?.titleCategory === "other" ? undefined : local?.titleCategory;
    let row = modelRow?.taxonomy ? modelRow : local ? { ...local, credits: [], discardedClaims: 0 } : modelRow;
    if (!row) throw new Error("Missing event genre classification.");
    if (!event.currentTaxonomy && local && (titledCategory || local.taxonomy.categories.length > 1) && modelRow?.taxonomy) {
      const primaryCategory = titledCategory ?? (modelRow.taxonomy.primaryCategory === "other"
        ? local.taxonomy.primaryCategory : modelRow.taxonomy.primaryCategory);
      const categories = [...new Set([primaryCategory, ...local.taxonomy.categories, ...modelRow.taxonomy.categories])]
        .filter((category) => category !== "other").slice(0, 3);
      const formats = [...new Set([...local.taxonomy.formats, ...modelRow.taxonomy.formats])];
      const genres = modelRow.taxonomy.genres.length ? modelRow.taxonomy.genres : local.taxonomy.genres;
      const evidence = [...local.evidence.filter((claim) => claim.kind !== "genre" || !modelRow.taxonomy?.genres.length), ...modelRow.evidence]
        .filter((claim, index, all) => (claim.kind !== "category" || categories.some((category) => category === claim.label)) &&
          all.findIndex((item) => item.kind === claim.kind && item.label === claim.label) === index);
      row = { ...modelRow, evidence, taxonomy: { primaryCategory, categories, formats, genres } };
    }
    const excludedGenres = getExcludedDiscoveryGenres(event);
    const directGenres = row.taxonomy?.genres.filter((genre) => !excludedGenres.has(genre)) ?? [];
    const categoryTaxonomy = event.currentTaxonomy ?? row.taxonomy;
    const taxonomy = categoryTaxonomy ? {
      ...categoryTaxonomy,
      genres: event.currentTaxonomy?.genres.length ? event.currentTaxonomy.genres : directGenres,
    } : null;
    const evidence = event.currentTaxonomy
      ? row.evidence.filter((claim) => claim.kind === "genre" && taxonomy?.genres.includes(claim.label as MusicGenre))
      : row.evidence.filter((claim) => claim.kind !== "genre" || !excludedGenres.has(claim.label as MusicGenre));
    const result: EventGenreResolution = {
      eventId: event.key, expectedUpdatedAt: event.expectedUpdatedAt, taxonomy,
      method: taxonomy?.genres.length ? evidence.some((claim) => claim.kind === "genre" && claim.source === "sourceCaption")
        ? "instagram" : "announcement" : "unknown",
      auditJson: JSON.stringify({ credits: event.currentTaxonomy ? [] : row.credits, evidence, discardedClaims: row.discardedClaims }),
    };
    const fallback = taxonomy ?? getEventDiscoveryTaxonomy(event);
    const format = getPerformerGenreResearchFormat(fallback);
    const corroborated = taxonomy && corroborateLiveProgrammeGenre(event, taxonomy);
    if (corroborated) {
      result.method = "estimate";
      result.estimatedGenres = [corroborated.genre];
      result.auditJson = JSON.stringify({ ...JSON.parse(result.auditJson), programmeGenre: corroborated });
      return result;
    }
    if (format) {
      const acts = getPerformerGenreResearchActs(event, format, true);
      if (acts.length) lookups.push({ event, result, format, acts, excludedGenres });
    } else if (!event.currentTaxonomy && !local?.complete && fallback.primaryCategory === "other" &&
      !fallback.formats.length && event.venue.trim() && validDate(event.date)) {
      const listing = getEventListingResearchAct(event);
      if (listing && !/^(?:event|dogadjaj|tba|unknown|nepoznato)$/i.test(listing.billedName)) {
        lookups.push({ event, result, format: "live", acts: [listing], excludedGenres, discoveryOnly: true });
      }
    }
    return result;
  });

  const toEstimate = lookups.filter(({ acts }) => acts.some(({ titleOnly }) => !titleOnly));
  const estimated = toEstimate.length && Date.now() < deadlineAt
    ? await (options.estimate ?? estimatePerformerGenresBatch)(toEstimate.map(({ event, acts }) => ({
      key: event.key, eventTitle: event.title, acts: acts.filter(({ titleOnly }) => !titleOnly),
    })), providerOptions(options, deadlineAt)).catch(() => undefined) : undefined;
  for (const { event, result, excludedGenres } of toEstimate) {
    const genres = estimated?.results.get(event.key);
    const compatible = genres?.filter((genre) => !excludedGenres.has(genre));
    if (compatible?.length) {
      result.method = "estimate";
      result.estimatedGenres = compatible;
      result.auditJson = JSON.stringify({ ...JSON.parse(result.auditJson), estimateModel: estimated?.model });
    } else if (!genres) {
      result.deferred = true;
    }
  }

  const groups = groupWebLookups(lookups.filter(({ event, result }) => result.method === "unknown" && validDate(event.date)))
    .map((lookups) => ({ lookups, retried: false }));
  let nextGroup = 0;
  let searchCalls = 0;
  await Promise.all(Array.from({ length: Math.min(groups.length, WEB_CONCURRENCY) }, async () => {
    while (nextGroup < groups.length) {
      const { lookups: group, retried } = groups[nextGroup++];
      if (Date.now() >= deadlineAt) {
        for (const { result } of group) result.deferred = true;
        continue;
      }
      const inputs: PerformerGenreResearchInput[] = [];
      const rows = group.map((lookup) => ({ lookup, keys: lookup.acts.map((act, index) => {
        const key = inputs.length;
        const listingTitle = index === 0 && (!act.titleOnly || lookup.discoveryOnly)
          ? getEventListingResearchAct(lookup.event)?.billedName : undefined;
        inputs.push({ ...act, key, eventTitle: lookup.event.title, venue: lookup.event.venue,
          date: lookup.event.date, time: lookup.event.time, city: "Belgrade", trustedFormat: lookup.format, listingTitle,
          ...(lookup.discoveryOnly ? { discoveryOnly: true } : {}) });
        return key;
      }) }));
      try {
        const found = await (options.research ?? researchPerformerGenresBatch)(inputs, {
          ...providerOptions(options, deadlineAt), adaptive: true, singleAttempt: true,
        });
        searchCalls += found.searchCalls;
        for (const { lookup, keys } of rows) {
          const acts = keys.map((key) => found.results.get(key));
          const { result } = lookup;
          if (acts.some((act) => !act)) {
            result.deferred = true;
            continue;
          }
          if (lookup.discoveryOnly) {
            const listing = acts[0]?.listing;
            const discovered = listing?.discovery;
            if (!listing || !discovered || !canPublishPerformerGenreSource(listing.identityEvidence.url)) continue;
            result.taxonomy = { ...discovered.taxonomy, genres: [] };
            result.auditJson = JSON.stringify({ ...JSON.parse(result.auditJson), categoryListing: {
              identity: listing.identityEvidence, evidence: discovered.evidence,
            } });
            delete result.deferred;
            if (!getPerformerGenreResearchFormat(result.taxonomy)) continue;
          }
          const matches = sourcedMatches(acts as PerformerGenreResearchResult[], lookup);
          if (matches.length) {
            result.method = "web";
            result.webResearch = { model: found.model, matches,
              auditJson: JSON.stringify({ responseId: found.responseId, searchCalls: found.searchCalls, acts }) };
            delete result.deferred;
          }
        }
      } catch (error) {
        for (const { result } of group) if (result.method === "unknown") result.deferred = true;
        // Split a failed combined request once. A stubborn or throttled single
        // event cannot consume the rest of the ingestion's time and call budget.
        const status = (error as { status?: number } | null)?.status;
        if (!retried && group.length > 1 && status === undefined && Date.now() + 25_000 < deadlineAt) {
          groups.push(...group.map((lookup) => ({ lookups: [lookup], retried: true })));
        }
      }
    }
  }));
  return { model: classified.model, results, usage: classified.usage, estimateUsage: estimated?.usage,
    searchCalls, localClassified: events.length - needsModel.length };
}
