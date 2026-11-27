import type { Infer } from "convex/values";
import type { accountEvidence } from "./performerRegistryValues";
import {
  canonicalProfile,
  registryInstagramHandle,
  registryUrl,
} from "./performerRegistryEvidence";
import {
  directoryGenreKeys,
  instagramBioGenreKeys,
} from "../lib/taxonomy/performer-account-styles";
import { affiliatedArtistClaim } from "../lib/taxonomy/performer-account-affiliation";
import { genreProof } from "../lib/taxonomy/explicit-event-discovery";
import { normalizeTaxonomyText as normalize } from "../lib/taxonomy/venue-types";

export type AccountEvidence = Infer<typeof accountEvidence>;
const role =
  /\b(?:band|bend|group|musician|vocalist|artist|singer|rapper|dj|producer|producent\w*|sastav|pjevac\w*|pevac\w*|muzicar\w*|ensemble|guitarist|gitarist\w*|duo|trio|quartet)\b/u;
const disowned =
  /\b(?:not|never|without|formerly|previously|no longer|fan of|lover of|loves|inspired by|for fans of|nije|nisu|bez|nekada|tribute to)\b/u;
const unrelated =
  /\b(?:lineup|line up|concert|koncert\w*|festival|hosted by|tonight|tickets|gostuje|veceras|presents|presents? a|next show|book now|booking for|playing with|alongside|featuring|release party|playlist|single|track|album|my brother|my sister|our guest|label owner|club night|label roster|rock climbing|opera house|beach house|house of|collective|artwork|photographer|coffee|fashion|favorite|favourite|photo by|photograph\w*)\b/u;
const quoted = (s: { url: string; quote: string }) =>
  registryUrl(s.url) &&
  s.url.length <= 1000 &&
  s.quote.trim().length >= 2 &&
  s.quote.trim().length <= 500;
const ig = (url: string, handle: string) =>
  /^https:\/\//iu.test(url) && registryInstagramHandle(url) === handle;
function selfName(data: AccountEvidence) {
  const d = data.displayName;
  if (!d || !quoted(d) || !ig(d.url, data.handle)) return;
  const value = d.value.trim().normalize("NFC");
  if (
    value.length < 2 ||
    value.length > 100 ||
    !/[\p{L}\p{N}]/u.test(value) ||
    /[\r\n]/u.test(value) ||
    /(?:log in|sign up|instagram photos and videos|follow us|account is private)/iu.test(
      value,
    )
  )
    return;
  const title = d.quote.trim().normalize("NFC");
  // Accept the exact display field or Instagram's own account-specific OG title.
  const match = title.match(
    /^(.*?)\s+\(@([a-z0-9_.]+)\)(?:\s*(?:[•·|–—-]|on Instagram).*)?$/iu,
  );
  if (
    !(
      title === value ||
      (match &&
        match[1].trim() === value &&
        match[2].toLowerCase() === data.handle)
    )
  )
    return;
  return { value, url: d.url, quote: title };
}
function appleArtistId(url: string) {
  const u = new URL(url);
  if (!["music.apple.com", "itunes.apple.com"].includes(u.hostname)) return;
  if (u.hostname === "itunes.apple.com" && u.pathname === "/lookup") {
    const id = u.searchParams.get("id");
    return id && /^\d+$/u.test(id) && [...u.searchParams.keys()].length === 1
      ? id
      : undefined;
  }
  return u.pathname.match(
    /^\/(?:[a-z]{2}\/)?artist\/(?:[^/]+\/)?(?:id)?(\d+)\/?$/iu,
  )?.[1];
}
function artistPage(url: string) {
  const u = new URL(url);
  return (
    !!appleArtistId(url) ||
    (/^[a-z0-9-]+\.bandcamp\.com$/u.test(u.hostname) && u.pathname === "/")
  );
}
function sameArtistUrl(left: string, right: string) {
  const id = appleArtistId(left);
  return id
    ? id === appleArtistId(right)
    : canonicalProfile(left) === canonicalProfile(right);
}
function musicBrainzLink(
  link: { url: string; quote: string },
  handle: string,
  target: string,
) {
  const u = new URL(link.url);
  if (
    u.hostname !== "musicbrainz.org" ||
    !/^\/(?:ws\/2\/artist\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|artist\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/url)\/?$/iu.test(
      u.pathname,
    ) ||
    !artistPage(target)
  )
    return false;
  let urls: unknown;
  try {
    urls = JSON.parse(link.quote);
  } catch {
    return false;
  }
  return (
    Array.isArray(urls) &&
    urls.length === 2 &&
    urls.every((x) => typeof x === "string" && registryUrl(x)) &&
    urls.some((x) => ig(x, handle)) &&
    urls.some((x) => sameArtistUrl(x, target))
  );
}
function boundPage(
  handle: string,
  url: string,
  link?: AccountEvidence["identityLink"],
) {
  if (!link || !quoted(link)) return false;
  if (ig(link.url, handle)) {
    const matches = link.quote.match(/https?:\/\/[^\s"'<>]+/gu) ?? [];
    return matches.some(
      (value) =>
        registryUrl(value) && canonicalProfile(value) === canonicalProfile(url),
    );
  }
  if (musicBrainzLink(link, handle, url)) return true;
  if (canonicalProfile(link.url) !== canonicalProfile(url)) return false;
  const quote = link.quote.toLowerCase().trim();
  if (/^https:\/\/[^\s]+$/iu.test(quote)) return ig(quote, handle);
  const tag = handle.replace(/\./gu, "\\.");
  return (
    new RegExp(
      "(?:^|[^a-z0-9_.@/])(?:instagram(?:\\s+(?:account|handle|profil))?\\s*[:=|/–-]?\\s*@?" +
        tag +
        "|(?:https?://)?(?:www\\.)?instagram\\.com/" +
        tag +
        "|\\(@" +
        tag +
        "\\))(?![a-z0-9_.])",
      "iu",
    ).test(quote) &&
    !/\b(?:guest|booking|contact|photo|sponsor|featuring|with|lineup)\b/u.test(
      normalize(quote),
    )
  );
}

/** Account biographies describe the billed performer. A venue, dated show or collaborator cannot provide the act's style. */
export function validateAccountEvidence(
  input: AccountEvidence,
  expectedHandle: string,
  knownName?: string,
): AccountEvidence {
  const handle = registryInstagramHandle(expectedHandle);
  if (
    !handle ||
    handle !== expectedHandle ||
    input.handle !== handle ||
    input.genres.length > 10
  )
    throw new Error("Invalid performer account evidence.");
  const displayName = selfName(input);
  const genres: AccountEvidence["genres"] = [];
  for (const raw of input.genres) {
    if (!quoted(raw) || !genreProof[raw.genre]) continue;
    const own = ig(raw.url, handle);
    const link = raw.binding ?? input.identityLink;
    const affiliation =
      !!displayName &&
      !!link &&
      quoted(link) &&
      ig(link.url, handle) &&
      displayName.quote.toLowerCase().includes("(@" + handle + ")") &&
      affiliatedArtistClaim(
        handle,
        displayName.value,
        link.quote,
        raw.quote,
        raw.genre,
      );
    if (!own && !affiliation && !boundPage(handle, raw.url, link)) continue;
    const quote = raw.quote.trim();
    const genreWords = (s: string) =>
      normalize(
        s
          .normalize("NFKC")
          .replace(/@[a-z0-9_.]+/giu, " ")
          .replace(/#livehousemusic\b/giu, "house music")
          .replace(/\bdrum(?:[’']?n[’']?|\s*[&]\s*)bass\b/giu, "drum and bass"),
      );
    const normalized = genreWords(quote);
    const sourceHost = new URL(raw.url).hostname
      .toLowerCase()
      .replace(/^www\./u, "");
    const field =
      /^"?(?:knowsAbout|primaryGenreName|genres?|styles?)"?\s*:\s*([\s\S]{2,460})$/iu.exec(
        quote,
      );
    let labels: string[] = [];
    if (field && /^\s*\[/u.test(field[1])) {
      try {
        const list: unknown = JSON.parse(field[1]);
        if (
          Array.isArray(list) &&
          list.length <= 32 &&
          list.every((item) => typeof item === "string" && item.length <= 100)
        )
          labels = list;
      } catch {
        /* A malformed structured field has no evidentiary value. */
      }
    } else if (field && /^[\s"'\p{L}\d&/–’-]{2,100}$/u.test(field[1])) {
      labels = [field[1].replace(/^["']|["']$/gu, "")];
    }
    const structured =
      !own &&
      ((sourceHost === "djs.rs" &&
        /^\/[\w.-]+\/?$/u.test(new URL(raw.url).pathname)) ||
        artistPage(raw.url)) &&
      directoryGenreKeys(labels).includes(raw.genre);
    const ownStyle = own && instagramBioGenreKeys(quote).includes(raw.genre);
    if (
      disowned.test(normalized.replace(/\bformerly known as\b/gu, "")) ||
      unrelated.test(normalized)
    )
      continue;
    const subject = [displayName?.value, knownName, handle]
      .filter((n): n is string => !!n)
      .some((name) => {
        const n = normalize(name.normalize("NFKC"));
        return n && (" " + normalized + " ").includes(" " + n + " ");
      });
    const clauses = quote
      .split(/[\n;|•]|(?<=[.!?])\s+/u)
      .map(genreWords)
      .filter(Boolean);
    const clause = clauses.find(
      (c) =>
        genreProof[raw.genre].test(c) &&
        (role.test(c) ||
          /\b(?:playing|plays|produces|svira|svira[mj]\w*|pusta|music|muzika|sound|style|stil|zvuk|specializes in|mainly|primarily|pretezno)\b/u.test(
            c,
          )),
    );
    if (
      (!clause || !subject || own) &&
      !structured &&
      !affiliation &&
      !ownStyle
    )
      continue;
    const catalogPrimary =
      structured &&
      !!appleArtistId(raw.url) &&
      /^"primaryGenreName"\s*:/u.test(quote) &&
      labels.length === 1 &&
      directoryGenreKeys(labels).length === 1;
    const dominant =
      catalogPrimary ||
      (!!clause &&
        raw.dominant === true &&
        /\b(?:primarily|predominantly|mainly|specializes in|specialises in|pretezno|prvenstveno|dominantno)\b/u.test(
          clause,
        ) &&
        Object.values(genreProof).filter((re) => re.test(clause)).length === 1);
    if (
      !genres.some(
        (g) =>
          g.genre === raw.genre &&
          canonicalProfile(g.url) === canonicalProfile(raw.url),
      )
    ) {
      genres.push({
        genre: raw.genre,
        url: raw.url,
        quote,
        ...(dominant ? { dominant: true } : {}),
        ...(!own && link ? { binding: link } : {}),
      });
    }
  }
  return { handle, ...(displayName ? { displayName } : {}), genres };
}
