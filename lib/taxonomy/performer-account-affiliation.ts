import type { MusicGenre } from "./event-discovery";
import { genreProof } from "./explicit-event-discovery";
import { normalizeTaxonomyText as normalize } from "./venue-types";

function bandKey(value: string) {
  const key = normalize(value).replaceAll(" ", "").replace(/bend$/u, "band");
  // A generic occupational or bookings tag does not identify a named group.
  return /^[a-z0-9]{3,40}band$/u.test(key) &&
    !/^(?:wedding|party|cover|tribute|music|live|rock|punk|folk|pop|jazz|metal|house|city|tour|backing|my|our|local|the|official|best|brass|big|school)band$/u.test(
      key,
    )
    ? key
    : undefined;
}

/** An exact account biography and an independent first-person affiliation identify the same named musician. */
export function affiliatedArtistClaim(
  handle: string,
  name: string,
  bio: string,
  quote: string,
  genre: MusicGenre,
): boolean {
  if (
    !/^[a-z0-9_][a-z0-9_.]{0,29}$/u.test(handle) ||
    !bio ||
    bio.length > 500 ||
    quote.length > 500
  )
    return false;
  const person = normalize(name);
  if (!/^[a-z]{2,}(?: [a-z]{2,}){1,3}$/u.test(person)) return false;
  // Only accept the account owner's own short role/affiliation tags. A tag in a caption,
  // lineup, fan bio, thank-you or description of a friend cannot bind a band.
  const before = bio.trim();
  if (!/^(?:#[\p{L}\p{N}_]+[\s,•|/]*)+$/u.test(before)) return false;
  const tags = [...before.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) =>
    normalize(m[1]).replaceAll(" ", ""),
  );
  if (
    !tags.some((t) =>
      [
        "musician",
        "singer",
        "vocalist",
        "guitarist",
        "bassist",
        "drummer",
        "pevac",
        "pjevac",
        "muzicar",
      ].includes(t),
    ) ||
    tags.some((t) =>
      /fan|lover|guest|host|tribute|friend|former|exmember|booking|manager|sponsor|photograph/u.test(
        t,
      ),
    )
  )
    return false;
  const bands = tags.map(bandKey).filter((b): b is string => !!b);
  if (bands.length !== 1) return false;
  const relation =
    /\b(?:sa? svojim (?:bendom|sastavom)|with (?:his|her|their) (?:own )?band)\s+["„“”«]([^"„“”»«\r\n]{3,70})["”“»]/iu.exec(
      quote,
    );
  if (!relation || bandKey(relation[1]) !== bands[0]) return false;
  const head = quote.slice(0, relation.index);
  if (
    /[.!?;\r\n]/u.test(head) ||
    /\b(?:friend|brother|sister|guest|formerly|originally|not|never|nije|nisu|nekada|prijatelj\w*|gost\w*|brat|sestra|fan|tribut\w*)\b/u.test(
      normalize(quote),
    )
  )
    return false;
  const clauses = head.split(/[,–—]/u).map(normalize).filter(Boolean);
  if (clauses[0] !== person || !clauses[1]) return false;
  // The style must describe this named person as a musician in the immediate apposition.
  const description = clauses[1].replace(
    /^(?:mladi |mlada |poznati |poznata |young |a |an )+/u,
    "",
  );
  const performer =
    /\b(?:pjevac\w*|pevac\w*|singer|vocalist|musician|artist|gitarist\w*|guitarist|bassist|drummer|muzicar\w*)\b/u.exec(
      description,
    );
  return (
    !!performer &&
    performer.index < 55 &&
    genreProof[genre].test(description.slice(0, performer.index)) &&
    !/\b(?:band|bend|group|sastav|guest|manager|fan)\b/u.test(description)
  );
}
