import type { PerformerHandleCredit } from "../lib/taxonomy/performer-genre-research";
import type { Infer } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { performerEvidence } from "./performerRegistryValues";
import {
  EVENT_DISCOVERY_VERSION,
  MUSIC_GENRES,
  type MusicGenre,
} from "../lib/taxonomy/event-discovery";
import { genreProof } from "../lib/taxonomy/explicit-event-discovery";
import { normalizeTaxonomyText as norm } from "../lib/taxonomy/venue-types";
import {
  canPublishPerformerGenreSource,
  getPerformerGenreResearchActs,
  PERFORMER_GENRE_RESEARCH_VERSION,
} from "../lib/taxonomy/performer-genre-research";

export type RegistryEvidence = Infer<typeof performerEvidence>;
type Source = RegistryEvidence["identity"];
export type Credit = { name: string; key: string; handle?: string };
type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
const items = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
function audit(text: string): Json {
  try {
    return object(JSON.parse(text));
  } catch {
    return {};
  }
}
const validGenre = new Set<string>(MUSIC_GENRES.map(({ key }) => key));
const compound = /[,;/|]|\s(?:&|\+|x|b2b|feat\.?|ft\.?|vs\.?)\s/i;
export function registryCredits(
  artists: readonly string[],
  performerHandles?: readonly PerformerHandleCredit[],
): Credit[] {
  const credits = new Map<string, Credit>();
  for (const raw of artists) {
    if (compound.test(raw)) continue;
    const [act] = getPerformerGenreResearchActs(
      { title: "", artists: [raw], performerHandles },
      "live",
    );
    if (!act || act.titleOnly) continue;
    const key = norm(act.billedName);
    const handle = act.billedHandle?.toLowerCase();
    if (key)
      credits.set(JSON.stringify([key, handle ?? null]), {
        key,
        name: act.billedName,
        ...(handle ? { handle } : {}),
      });
  }
  return [...credits.values()];
}
export function registryUrl(value: unknown): value is string {
  if (typeof value !== "string" || !canPublishPerformerGenreSource(value))
    return false;
  const host = new URL(value).hostname.toLowerCase();
  return !/(^|\.)(?:eventzeka\.com|ineedtofeedmyrabbit\.com|wikipedia\.org|reddit\.com|quora\.com|fandom\.com)$/.test(
    host,
  );
}
function source(value: unknown): Source | undefined {
  const { url, quote } = object(value);
  if (
    registryUrl(url) &&
    typeof quote === "string" &&
    quote.trim().length >= 4 &&
    quote.length <= 500
  ) {
    return { url, quote: quote.trim() };
  }
}
export function canonicalProfile(url: string) {
  const u = new URL(url);
  return u.origin.toLowerCase() + u.pathname.replace(/\/$/, "") + u.search;
}
function profilePage(url: string): boolean {
  const { hostname, pathname } = new URL(url);
  return (
    /^\/(?:dj|artists?|performers?|musicians?|bands?|artist-profile)\/[^/]+(?:\/(?:bio|biography))?\/?$/i.test(
      pathname,
    ) ||
    (/^(?:www\.)?(?:instagram\.com|soundcloud\.com|mixcloud\.com)$/.test(
      hostname,
    ) &&
      /^\/(?!p\/|reel\/|tracks\/|explore\/)[a-z0-9._-]+\/?$/i.test(pathname)) ||
    (/^[^.]+\.(?:bandcamp\.com|carrd\.co)$/.test(hostname) && pathname === "/")
  );
}
function sourceHandle(s: Source, handle: string) {
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(
      `(?:^|[^a-z0-9_.])@${escaped}(?![a-z0-9_]|\\.[a-z0-9_])`,
      "i",
    ).test(s.quote) ||
    (/^(?:www\.)?instagram\.com$/.test(new URL(s.url).hostname) &&
      new URL(s.url).pathname.replace(/^\/|\/$/g, "").toLowerCase() === handle)
  );
}
function styleDescribesArtist(text: string, name: string, genre: MusicGenre) {
  const artist = norm(name);
  if (!artist) return false;
  const subject = new RegExp(
    `(?:^| )${artist} (?:primarily |mainly |usually |also |pretezno )?(?:plays?|spins?|mixes|produces|is known for|is an? |are an? |svira|sviraju|pusta|je |su )`,
  );
  return text
    .split(/[;.!?]|\b(?:while|whereas|alongside|followed by|zatim|dok)\b/iu)
    .some(
      (clause) =>
        subject.test(norm(clause)) && genreProof[genre].test(norm(clause)),
    );
}
function unportable(quote: string) {
  return /\b(?:not|never|without|nije|nisu|bez|nekada|formerly|alongside|lineup|line up|supporting|guests?|inspired by|similar to|for fans of)\b/.test(
    norm(quote),
  );
}
function dominant(quote: string, genre: MusicGenre) {
  const q = norm(quote);
  const explicit =
    /\b(?:primarily|predominantly|mainly|specializes in|specialises in|pretezno|prvenstveno|dominantno|specijalizovan\w* za)\b/.test(
      q,
    );
  // "X is a techno DJ" explicitly characterizes the artist. A sole genre
  // mentioned on a page ("also plays techno") does not distinguish a main style.
  const definition =
    /\b(?:is (?:a|an)|are (?:a|an)|je|su) ((?:[a-z0-9]+ ){1,3})(?:dj|band|bend|producer|producent|ensemble|sastav|group)\b/.exec(
      q,
    );
  const styles = MUSIC_GENRES.filter(({ key }) => genreProof[key].test(q));
  return (
    !unportable(quote) &&
    styles.length === 1 &&
    styles[0].key === genre &&
    (explicit || (!!definition && genreProof[genre].test(definition[1].trim())))
  );
}
function currentAudit<
  T extends {
    version: number;
    eventUpdatedAt: number;
    model: string;
    auditJson: string;
  },
>(row: T | null, version: number, updatedAt: number) {
  if (
    !row ||
    row.eventUpdatedAt !== updatedAt ||
    row.version !== version ||
    row.model === "performer-registry-v1"
  )
    return {};
  const parsed = audit(row.auditJson);
  return parsed.source === "performer-registry" || parsed.exactListing === true
    ? {}
    : parsed;
}
function webEvidence(
  credit: Credit,
  act: Json,
  matches: Doc<"eventPerformerGenreResearch">["matches"] | undefined,
): RegistryEvidence | undefined {
  if (
    act.status !== "resolved" ||
    act.billedName !== credit.name ||
    act.nonMusicListing === true
  )
    return;
  const identity = source(act.identityEvidence);
  if (!identity) return;
  const corroboration = source(act.identityCorroboration);
  const sources = [identity, ...(corroboration ? [corroboration] : [])];
  const profileUrl = sources.find((s) => profilePage(s.url))?.url;
  const instagram = sources
    .map((s) => new URL(s.url))
    .find(
      (u) =>
        /^(?:www\.)?instagram\.com$/.test(u.hostname) && profilePage(u.href),
    );
  const verifiedHandle =
    credit.handle && sources.some((s) => sourceHandle(s, credit.handle!))
      ? credit.handle
      : !credit.handle && instagram
        ? instagram.pathname.replace(/^\/|\/$/g, "").toLowerCase()
        : undefined;
  const role = object(act.programmeRole),
    roleProof = source(role.evidence);
  const roleCategory = role.category;
  const result: RegistryEvidence = {
    kind: "web",
    identity,
    ...(corroboration ? { corroboration } : {}),
    ...(profileUrl ? { profileUrl } : {}),
    ...(verifiedHandle ? { verifiedHandle } : {}),
    ...(roleProof &&
    (roleCategory === "party" || roleCategory === "live") &&
    sources.some((s) => s.url === roleProof.url)
      ? { role: { category: roleCategory, source: roleProof } }
      : {}),
    genres: [],
  };
  for (const raw of items(act.genreEvidence).slice(0, 8)) {
    const claim = object(raw),
      s = source(raw),
      genre = claim.genre;
    if (
      !s ||
      typeof genre !== "string" ||
      !validGenre.has(genre) ||
      unportable(s.quote) ||
      !genreProof[genre as MusicGenre].test(norm(s.quote))
    )
      continue;
    if (
      matches &&
      !matches.some(
        (m) =>
          m.performer === credit.name &&
          m.identityUrl === identity.url &&
          m.genre === genre &&
          m.url === s.url,
      )
    )
      continue;
    // A dated lineup proves the artist was billed. Only artist profiles or a direct
    // description of the named artist can make that genre portable to another date.
    if (
      !(profilePage(s.url) && sources.some((v) => v.url === s.url)) &&
      !styleDescribesArtist(s.quote, credit.name, genre as MusicGenre)
    )
      continue;
    if (!result.genres.some((v) => v.genre === genre))
      result.genres.push({
        genre: genre as MusicGenre,
        ...s,
        dominant: dominant(s.quote, genre as MusicGenre),
      });
  }
  return result;
}
function editorial(
  credit: Credit,
  event: Doc<"events">,
  row: Doc<"eventPerformerGenreResearch"> | null,
  label: Doc<"eventDiscoveryLabels"> | null,
  proof: Json,
): RegistryEvidence | undefined {
  if (
    proof.genreScope !== "named-artist" ||
    typeof proof.review !== "string" ||
    !proof.review.length ||
    proof.listingUrl !== event.instagramPostUrl ||
    !proof.listingRow ||
    !registryUrl(proof.identityUrl) ||
    typeof proof.identityProof !== "string" ||
    !proof.identityProof.trim() ||
    typeof proof.basis !== "string"
  )
    return;
  const primary = source({
    url: proof.identityUrl,
    quote: proof.identityProof,
  });
  if (!primary) return;
  const matches =
    row?.model === proof.review &&
    row.version === PERFORMER_GENRE_RESEARCH_VERSION &&
    row.eventUpdatedAt === event.updatedAt
      ? row.matches.filter(
          (m) =>
            m.performer === credit.name &&
            m.identityUrl === primary.url &&
            registryUrl(m.url),
        )
      : [];
  if (
    !matches.length &&
    !(event.artists.length === 1 && label?.model === proof.review)
  )
    return;
  const urls = [...new Set(matches.map((m) => m.url))];
  const quotes = items(proof.genreEvidence);
  const genres: RegistryEvidence["genres"] = [];
  // The reviewed format lists citations per distinct source, in match order.
  if (urls.length === quotes.length)
    for (const m of matches) {
      const q = quotes[urls.indexOf(m.url)];
      if (
        typeof q === "string" &&
        q.length <= 500 &&
        genreProof[m.genre].test(norm(q))
      )
        genres.push({
          genre: m.genre,
          url: m.url,
          quote: q,
          dominant: dominant(q, m.genre),
        });
    }
  const roleSource = [primary.quote, proof.basis].find((s) =>
    /\b(?:dj|deejay|disc jockey|band|bend\w*)\b/i.test(norm(s)),
  );
  const role =
    roleSource &&
    (/\b(?:dj|deejay|disc jockey)\b/.test(norm(roleSource)) ? "party" : "live");
  return {
    kind: "editorial",
    identity: primary,
    profileUrl: primary.url,
    genres,
    ...(role && roleSource
      ? {
          role: {
            category: role,
            source: { url: primary.url, quote: roleSource },
          },
        }
      : {}),
  };
}
export function evidenceForCredits(
  event: Doc<"events">,
  row: Doc<"eventPerformerGenreResearch"> | null,
  label: Doc<"eventDiscoveryLabels"> | null,
  performerHandles?: readonly PerformerHandleCredit[],
) {
  const research = currentAudit(
    row,
    PERFORMER_GENRE_RESEARCH_VERSION,
    event.updatedAt,
  );
  const discovery = currentAudit(
    label,
    EVENT_DISCOVERY_VERSION,
    event.updatedAt,
  );
  const reviewed = research.genreScope
    ? research
    : object(discovery.reviewedProgramme);
  return registryCredits(event.artists, performerHandles).map((credit) => {
    const edit = editorial(credit, event, row, label, reviewed);
    if (edit) return { credit, proof: edit };
    const named = items(research.acts)
      .map(object)
      .find((a) => a.billedName === credit.name);
    const partial = items(object(discovery.partialProgramme).acts)
      .map(object)
      .find((a) => a.billedName === credit.name);
    let proof = named && webEvidence(credit, named, row?.matches);
    if (!proof && partial) proof = webEvidence(credit, partial, undefined);
    if (!proof) {
      const role = items(discovery.billedProgramme)
        .map(object)
        .find((r) => r.performer === credit.name);
      if (role)
        proof = webEvidence(
          credit,
          {
            status: "resolved",
            billedName: credit.name,
            identityEvidence: role.identity,
            identityCorroboration: role.corroboration,
            programmeRole: { category: role.category, evidence: role.evidence },
          },
          [],
        );
    }
    return { credit, proof };
  });
}
export function profileKey(
  eventId: string,
  credit: Credit,
  proof: RegistryEvidence,
) {
  if (proof.verifiedHandle) return "handle:" + proof.verifiedHandle;
  if (proof.profileUrl)
    return (
      "profile:" +
      JSON.stringify([credit.key, canonicalProfile(proof.profileUrl)])
    );
  return "bill:" + JSON.stringify([eventId, credit.key]);
}
