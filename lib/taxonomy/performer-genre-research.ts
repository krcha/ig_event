import { normalizeTaxonomyText } from "./venue-types";
import type { EventDiscoveryTaxonomy, MusicGenre } from "./event-discovery";

export const PERFORMER_GENRE_RESEARCH_VERSION = 1;
export const EMPTY_RESEARCH_RETRY_MS = 14 * 24 * 60 * 60 * 1000;

export type PerformerGenreSource = { url: string; performer: string };
export type PerformerGenreMatch = PerformerGenreSource & { genre: MusicGenre; identityUrl: string };
export type PerformerGenreFormat = "dj-set" | "concert" | "live-performance" | "party" | "live";
export type PerformerGenreAct = { billedName: string; billedHandle?: string; titleOnly?: boolean };

export function getPerformerGenreResearchFormat(
  taxonomy: EventDiscoveryTaxonomy,
): PerformerGenreFormat | undefined {
  if (taxonomy.genres.length) return;
  if (taxonomy.primaryCategory === "party") {
    return taxonomy.formats.includes("dj-set") ? "dj-set" : "party";
  }
  if (taxonomy.primaryCategory === "live") {
    if (taxonomy.formats.includes("concert")) return "concert";
    return taxonomy.formats.includes("live-performance") ? "live-performance" : "live";
  }
}

export function getPerformerGenreResearchActs(event: {
  title: string;
  artists: readonly string[];
}, format: PerformerGenreFormat): PerformerGenreAct[] {
  const acts = new Map<string, PerformerGenreAct>();
  for (const artist of event.artists) {
    const credit = artist.trim();
    const explicitHandle = /^(.*?)\s*\(\s*@([\w.]{2,30})\s*\)$/u.exec(credit);
    const name = explicitHandle?.[1].trim() || credit;
    const normalized = normalizeTaxonomyText(name);
    if (name.length < 2 || name.length > 100 ||
      !normalized || /^(?:dj|tba|tbc|lineup|specijalni gost|special guest|unknown|nepoznato|various artists)$/u.test(normalized)) continue;
    const handle = explicitHandle?.[2] ?? /^@([\w.]{2,30})$/u.exec(name)?.[1];
    acts.set(normalized, { billedName: name, ...(handle ? { billedHandle: handle } : {}) });
  }
  if (acts.size && acts.size <= 2) return [...acts.values()];
  if (acts.size > 2) {
    // In long lineups prefer title credits, then the order of the source credits.
    const titleWords = ` ${normalizeTaxonomyText(event.title)} `;
    const named = [...acts].filter(([name]) => titleWords.includes(` ${name} `)).map(([, act]) => act);
    return (named.length ? named : [...acts.values()]).slice(0, 2);
  }
  const title = event.title.trim();
  const normalizedTitle = normalizeTaxonomyText(title);
  const titleCanIdentify = title.length >= 3 && title.length <= 70 &&
    !/\b(?:at|vece|zur[kc]|party|program|tribute|festival|docek|night|session|open decks|matinee|svirka|koncert|show)\b/u.test(normalizedTitle);
  if (!titleCanIdentify || (format === "party" && !/^(?:dj\b|@)/iu.test(title))) return [];
  const handle = /^@([\w.]{2,30})$/u.exec(title)?.[1];
  return [{ billedName: title, titleOnly: true, ...(handle ? { billedHandle: handle } : {}) }];
}

export function canPublishPerformerGenreSource(value: string): boolean {
  if (value.length > 500) return false;
  try {
    const url = new URL(value);
    const host = url.hostname;
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/iu.test(host) &&
      !/\.(?:local|test|invalid|example|onion|internal|arpa)$/iu.test(host);
  } catch {
    return false;
  }
}

export function applyPerformerGenreResearch(
  taxonomy: EventDiscoveryTaxonomy,
  matches: readonly PerformerGenreMatch[],
): { eventTaxonomy: EventDiscoveryTaxonomy; performerGenreResearch?: { sources: PerformerGenreSource[] } } {
  if (!getPerformerGenreResearchFormat(taxonomy)) return { eventTaxonomy: taxonomy };
  const valid = matches.filter(({ url, identityUrl }) =>
    canPublishPerformerGenreSource(url) && canPublishPerformerGenreSource(identityUrl));
  if (!valid.length) return { eventTaxonomy: taxonomy };
  const sources = [...new Map(valid.map(({ url, performer }) => [url, { url, performer }])).values()];
  return {
    eventTaxonomy: { ...taxonomy, genres: [...new Set(valid.map(({ genre }) => genre))] },
    performerGenreResearch: { sources },
  };
}
