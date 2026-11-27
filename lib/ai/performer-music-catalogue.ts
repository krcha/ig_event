import { setTimeout as wait } from "node:timers/promises";
import { directoryGenreKeys } from "@/lib/taxonomy/performer-account-styles";

type Relation = {
  ended?: boolean;
  artist?: { id?: string };
  url?: { resource?: string };
};
type Resource = { id?: string; resource?: string; relations?: Relation[] };
type Reader = (url: string, signal: AbortSignal) => Promise<string>;
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu;
let nextMusicBrainzRequest = 0;

async function musicBrainz(url: URL, signal: AbortSignal, read: Reader) {
  // One outgoing request per second per worker process. Skip a busy queue.
  const now = Date.now();
  const start = Math.max(now, nextMusicBrainzRequest);
  if (start - now > 1200) return;
  nextMusicBrainzRequest = start + 1100;
  if (start > now) await wait(start - now, undefined, { signal });
  signal.throwIfAborted();
  const body = await read(url.href, signal);
  if (body) return JSON.parse(body);
}

function exactAccount(value: unknown, handle: string): value is string {
  return (
    typeof value === "string" &&
    [
      `https://www.instagram.com/${handle}`,
      `https://instagram.com/${handle}`,
    ].includes(value.toLowerCase().replace(/\/$/u, ""))
  );
}

function appleArtistId(value: unknown) {
  if (typeof value !== "string") return;
  return /^https:\/\/(?:music|itunes)\.apple\.com\/(?:[a-z]{2}\/)?artist\/(?:[^/?#]+\/)?(?:id)?([1-9]\d{0,15})\/?$/iu.exec(
    value,
  )?.[1];
}

export function catalogueArtistId(data: { urls?: Resource[] }, handle: string) {
  if (!Array.isArray(data?.urls)) return;
  const ids = new Set<string>();
  for (const item of data.urls) {
    if (!exactAccount(item?.resource, handle) || !Array.isArray(item.relations))
      continue;
    for (const rel of item.relations) {
      const id = rel?.artist?.id;
      if (rel?.ended === false && typeof id === "string" && uuid.test(id))
        ids.add(id);
    }
  }
  if (ids.size === 1) return [...ids][0];
}

export function catalogueArtistLinks(
  data: Resource,
  id: string,
  handle: string,
) {
  if (data?.id !== id || !Array.isArray(data.relations)) return;
  const links = data.relations
    .filter((rel) => rel?.ended === false)
    .map((rel) => rel.url?.resource);
  const instagram = links.find((url) => exactAccount(url, handle));
  const apples = new Map<string, string>();
  for (const url of links) {
    const id = appleArtistId(url);
    if (id && url) apples.set(id, url);
  }
  if (!instagram || apples.size !== 1) return;
  const [appleId, apple] = [...apples][0];
  return {
    appleId,
    binding: {
      url: `https://musicbrainz.org/artist/${id}/url`,
      quote: JSON.stringify([instagram, apple]),
    },
  };
}

export function cataloguePrimaryGenre(raw: string, appleId: string) {
  if (!raw) return;
  const data = JSON.parse(raw);
  if (
    data?.resultCount !== 1 ||
    !Array.isArray(data.results) ||
    data.results.length !== 1
  )
    return;
  const artist = data.results[0];
  if (
    artist?.wrapperType !== "artist" ||
    !Number.isSafeInteger(artist.artistId) ||
    String(artist.artistId) !== appleId ||
    typeof artist.primaryGenreName !== "string"
  )
    return;
  const fields = [
    ...raw.matchAll(/"primaryGenreName"\s*:\s*("(?:[^"\\]|\\.)*")/gu),
  ];
  if (
    fields.length !== 1 ||
    JSON.parse(fields[0][1]) !== artist.primaryGenreName
  )
    return;
  const genres = directoryGenreKeys([artist.primaryGenreName]);
  if (genres.length === 1) return { genre: genres[0], quote: fields[0][0] };
}

// Use only official fixed API endpoints. An exact IG relationship must be
// present in both directions; an Apple album, namesake or retired link cannot bind a genre.
export async function catalogueAccountGenre(
  handle: string,
  read: Reader,
  caller?: AbortSignal,
) {
  const timeout = AbortSignal.timeout(4600);
  const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
  try {
    const lookup = new URL("https://musicbrainz.org/ws/2/url");
    for (const suffix of ["/", ""])
      lookup.searchParams.append(
        "resource",
        `https://www.instagram.com/${handle}${suffix}`,
      );
    lookup.searchParams.set("inc", "artist-rels");
    lookup.searchParams.set("fmt", "json");
    const id = catalogueArtistId(
      await musicBrainz(lookup, signal, read),
      handle,
    );
    if (!id) return;
    const artist = new URL(
      `https://musicbrainz.org/ws/2/artist/${id}?inc=url-rels&fmt=json`,
    );
    const linked = catalogueArtistLinks(
      await musicBrainz(artist, signal, read),
      id,
      handle,
    );
    if (!linked) return;
    const url = `https://itunes.apple.com/lookup?id=${linked.appleId}`;
    const primary = cataloguePrimaryGenre(
      await read(url, signal),
      linked.appleId,
    );
    if (primary)
      return { ...primary, url, dominant: true, binding: linked.binding };
  } catch (error) {
    if (caller?.aborted) throw error;
    // An unavailable or incompatible public catalogue is an inconclusive observation.
  }
}
