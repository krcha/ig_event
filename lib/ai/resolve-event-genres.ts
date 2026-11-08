import {
  classifyEventDiscoveryBatch,
  type EventDiscoveryBatchResult,
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
import {
  canPublishPerformerGenreSource,
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

function sourcedMatches(acts: readonly PerformerGenreResearchResult[], billed: readonly PerformerGenreAct[]): PerformerGenreMatch[] {
  return acts.flatMap((act, index) => {
    if (act.status !== "resolved" || act.billedName !== billed[index].billedName || !act.identityEvidence ||
      !canPublishPerformerGenreSource(act.identityEvidence.url)) return [];
    const identityUrl = act.identityEvidence.url;
    return act.genreEvidence.filter(({ url }) => canPublishPerformerGenreSource(url) &&
      (!billed[index].titleOnly || url === identityUrl)).map(({ genre, url }) => ({ performer: act.billedName, genre, url, identityUrl }));
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
}> {
  const deadlineAt = options.deadlineAt ?? Date.now() + DEFAULT_DEADLINE_MS;
  // The classifier is required. A failure must leave the whole input batch
  // eligible for retry because the advertised genres take precedence.
  const classified = await (options.classify ?? classifyEventDiscoveryBatch)(events, providerOptions(options, deadlineAt));
  const byKey = new Map(classified.results.map((row) => [row.key, row]));
  if (classified.results.length !== events.length || byKey.size !== events.length) throw new Error("Incomplete event genre classification.");
  const lookups: Lookup[] = [];
  const results = events.map((event): EventGenreResolution => {
    const row = byKey.get(event.key);
    if (!row) throw new Error("Missing event genre classification.");
    const taxonomy = event.currentTaxonomy ? {
      ...event.currentTaxonomy, genres: event.currentTaxonomy.genres.length ? event.currentTaxonomy.genres : row.taxonomy?.genres ?? [],
    } : row.taxonomy;
    const evidence = event.currentTaxonomy
      ? row.evidence.filter((claim) => claim.kind === "genre" && taxonomy?.genres.includes(claim.label as MusicGenre)) : row.evidence;
    const result: EventGenreResolution = {
      eventId: event.key, expectedUpdatedAt: event.expectedUpdatedAt, taxonomy,
      method: taxonomy?.genres.length ? evidence.some((claim) => claim.kind === "genre" && claim.source === "sourceCaption")
        ? "instagram" : "announcement" : "unknown",
      auditJson: JSON.stringify({ credits: event.currentTaxonomy ? [] : row.credits, evidence, discardedClaims: row.discardedClaims }),
    };
    const format = getPerformerGenreResearchFormat(taxonomy ?? getEventDiscoveryTaxonomy(event));
    if (format) {
      const acts = getPerformerGenreResearchActs(event, format, true);
      if (acts.length) lookups.push({ event, result, format, acts });
    }
    return result;
  });

  const toEstimate = lookups.filter(({ acts }) => acts.some(({ titleOnly }) => !titleOnly));
  const estimated = toEstimate.length && Date.now() < deadlineAt
    ? await (options.estimate ?? estimatePerformerGenresBatch)(toEstimate.map(({ event, acts }) => ({
      key: event.key, eventTitle: event.title, acts: acts.filter(({ titleOnly }) => !titleOnly),
    })), providerOptions(options, deadlineAt)).catch(() => undefined) : undefined;
  for (const { event, result } of toEstimate) {
    const genres = estimated?.results.get(event.key);
    if (genres?.length) {
      result.method = "estimate";
      result.estimatedGenres = genres;
      result.auditJson = JSON.stringify({ ...JSON.parse(result.auditJson), estimateModel: estimated?.model });
    } else if (!genres) {
      result.deferred = true;
    }
  }

  const groups = groupWebLookups(lookups.filter(({ event, result }) => result.method === "unknown" && validDate(event.date)));
  let nextGroup = 0;
  let searchCalls = 0;
  await Promise.all(Array.from({ length: Math.min(groups.length, WEB_CONCURRENCY) }, async () => {
    while (nextGroup < groups.length) {
      const group = groups[nextGroup++];
      if (Date.now() >= deadlineAt) {
        for (const { result } of group) result.deferred = true;
        continue;
      }
      const inputs: PerformerGenreResearchInput[] = [];
      const rows = group.map((lookup) => ({ lookup, keys: lookup.acts.map((act) => {
        const key = inputs.length;
        inputs.push({ ...act, key, eventTitle: lookup.event.title, venue: lookup.event.venue,
          date: lookup.event.date, city: "Belgrade", trustedFormat: lookup.format });
        return key;
      }) }));
      try {
        const found = await (options.research ?? researchPerformerGenresBatch)(inputs, {
          ...providerOptions(options, deadlineAt), singleAttempt: true,
        });
        searchCalls += found.searchCalls;
        for (const { lookup, keys } of rows) {
          const acts = keys.map((key) => found.results.get(key));
          const { result } = lookup;
          if (acts.some((act) => !act)) {
            result.deferred = true;
            continue;
          }
          const matches = sourcedMatches(acts as PerformerGenreResearchResult[], lookup.acts);
          if (matches.length) {
            result.method = "web";
            result.webResearch = { model: found.model, matches,
              auditJson: JSON.stringify({ responseId: found.responseId, searchCalls: found.searchCalls, acts }) };
            delete result.deferred;
          }
        }
      } catch {
        for (const { result } of group) if (result.method === "unknown") result.deferred = true;
      }
    }
  }));
  return { model: classified.model, results, usage: classified.usage, estimateUsage: estimated?.usage, searchCalls };
}
