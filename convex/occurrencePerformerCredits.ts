import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { canonicalizeSourceUrl } from "../lib/domain/source-url";
import { readEventEvidenceRecord } from "../lib/events/confirmed-event-schema-facts";
import {
  canonicalizeEventType,
  normalizeTaxonomyText as normalize,
} from "../lib/taxonomy/venue-types";
import type { PerformerHandleCredit } from "../lib/taxonomy/performer-genre-research";

const CAPTION_MAX_LENGTH = 2200;

export async function readScopedInstagramCaption(
  ctx: Pick<QueryCtx, "db">,
  event: Doc<"events">,
  fields: Record<string, unknown>,
) {
  const raw = event.sourceCaption?.trim().slice(0, CAPTION_MAX_LENGTH);
  const source = canonicalizeSourceUrl(
    "instagram",
    event.instagramPostUrl ?? event.canonicalSourceUrl,
  );
  if (!raw || !source.ok || fields.sourceOccurrencePlanUnverified === true)
    return;
  const sharedByEvidence =
    fields.multiEventSplitDetected === true ||
    fields.dateRangeExpanded === true ||
    [
      "multiEventSplitCount",
      "splitEventTotal",
      "dateRangeExpandedCount",
      "expandedDateTotal",
    ].some((key) => {
      const count = fields[key];
      return typeof count === "number" && count > 1;
    });
  const sharedByIndex = async () => {
    const other = (rows: Doc<"events">[]) =>
      rows.some(({ _id }) => _id !== event._id);
    if (
      event.instagramPostId &&
      other(
        await ctx.db
          .query("events")
          .withIndex("by_instagramPostId", (q) =>
            q.eq("instagramPostId", event.instagramPostId),
          )
          .take(2),
      )
    )
      return true;
    const { canonicalUrl } = source.value;
    if (event.canonicalSourceUrl === canonicalUrl) {
      return other(
        await ctx.db
          .query("events")
          .withIndex("by_canonicalSourceUrl", (q) =>
            q.eq("canonicalSourceUrl", canonicalUrl),
          )
          .take(2),
      );
    }
    if (event.normalizedInstagramPostUrl === canonicalUrl) {
      return other(
        await ctx.db
          .query("events")
          .withIndex("by_normalizedInstagramPostUrl", (q) =>
            q.eq("normalizedInstagramPostUrl", canonicalUrl),
          )
          .take(2),
      );
    }
    const originalUrl = event.instagramPostUrl;
    return (
      !!originalUrl &&
      other(
        await ctx.db
          .query("events")
          .withIndex("by_instagramPostUrl", (q) =>
            q.eq("instagramPostUrl", originalUrl),
          )
          .take(2),
      )
    );
  };
  if (!sharedByEvidence && !(await sharedByIndex())) return raw;

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

export function occurrenceTextFromEvidence(evidence: Record<string, unknown>) {
  const row = evidence.rowSourceText ?? evidence.splitSourceLine;
  return typeof row === "string" && row.trim() ? row.slice(0, 800) : undefined;
}

const accountPattern =
  /(?<![\p{L}\p{N}_.@])@([a-z0-9_](?:[a-z0-9._]{0,28}[a-z0-9_]))(?![a-z0-9_]|\.[a-z0-9_])/giu;
const forbidden =
  /\b(?:sponsor\w*|sponzor\w*|rezerv\w*|reservation\w*|booking\w*|tickets?|karte|ulaznice|kontakt|contact|photo\w*|fotograf\w*|foto|video|snim\w*|dizajn\w*|design\w*|organiz\w*|promot\w*|venue|lokacija|lokal|hosted by|domacin\w*|partner\w*|zahval\w*|thanks|instead of|replacement|zamena|ne|nije|nisu|nece|bez|otkaz\w*|odpada|odloz\w*|not|never|without|cancell?ed|postponed|maybe|mozda|formerly)\b/;
const weekdays = [
  "ned(?:elja)?|sun(?:day)?",
  "pon(?:edeljak)?|mon(?:day)?",
  "uto(?:rak)?|tue(?:sday)?",
  "sre(?:da)?|wed(?:nesday)?",
  "cet(?:vrtak)?|thu(?:rsday)?",
  "pet(?:ak)?|fri(?:day)?",
  "sub(?:ota)?|sat(?:urday)?",
];
const months = [
  "jan(?:uary|uar|uara)?",
  "feb(?:ruary|ruar|ruara)?",
  "mar(?:ch|t|ta)?",
  "apr(?:il|ila)?",
  "ma[jy]a?",
  "jun(?:e|a)?",
  "jul(?:y|a)?",
  "(?:aug(?:ust)?|avg(?:ust|usta)?)",
  "sep(?:t(?:ember|embar|embra)?)?",
  "(?:oct(?:ober)?|okt(?:obar|obra)?)",
  "nov(?:ember|embar|embra)?",
  "dec(?:ember|embar|embra)?",
];
const withdrawn =
  /\b(?:otkazan\w*|odlozen\w*|cancell?ed|postponed|ne nastupa|nece nastupiti|will not perform|no longer performing)\b/;
const nonArtistIcon = /[📷📸🎥📞🎟]/u;
function dateEvidence(text: string, date: string) {
  const words = normalize(text.replace(accountPattern, " "));
  const [y, m, d] = date.split("-").map(Number),
    weekday = new Date(date + "T12:00:00Z").getUTCDay();
  const checks: boolean[] = [];
  weekdays.forEach((w, i) => {
    if (new RegExp(`\\b(?:${w})\\b`).test(words)) checks.push(i === weekday);
  });
  for (const hit of text.matchAll(
    /(?<![\d./])(\d{1,2})[./](\d{1,2})(?:[./](20\d\d))?(?![\d/])/g,
  )) {
    if (+hit[1] >= 1 && +hit[1] <= 31 && +hit[2] >= 1 && +hit[2] <= 12)
      checks.push(+hit[1] === d && +hit[2] === m && (!hit[3] || +hit[3] === y));
  }
  for (const hit of text.matchAll(/\b20\d{2}-\d\d-\d\d\b/g))
    checks.push(hit[0] === date);
  months.forEach((prefix, i) => {
    for (const hit of words.matchAll(
      new RegExp(`\\b(\\d{1,2}) (${prefix})(?: (20\\d\\d))?\\b`, "g"),
    ))
      checks.push(+hit[1] === d && i + 1 === m && (!hit[3] || +hit[3] === y));
    for (const hit of words.matchAll(
      new RegExp(
        `(?<!\\d )\\b(?:${prefix}) (\\d{1,2})(?:st|nd|rd|th)?(?: (20\\d\\d))?\\b`,
        "g",
      ),
    )) {
      checks.push(+hit[1] === d && i + 1 === m && (!hit[2] || +hit[2] === y));
    }
  });
  return { dated: checks.length > 0, matches: checks.every(Boolean) };
}
function identityKey(name: string) {
  // Never conflate hyphenated or composite billings (A/B, A+B) with another account.
  return /^[\p{L}\p{M}\d ._]+$/u.test(name)
    ? normalize(name).replaceAll(" ", "")
    : "";
}
function accounts(line: string) {
  return [...line.matchAll(accountPattern)].map((h) => ({
    name: h[1].toLowerCase(),
    at: h.index ?? 0,
    length: h[0].length,
  }));
}

// A tag-only caption needs a second, named bill for this exact occurrence.
function namedPosterBill(
  event: Doc<"events">,
  fields: Record<string, unknown>,
  row: string,
  performer: string,
) {
  const type = canonicalizeEventType(event.eventType);
  if (type !== "live music" && type !== "nightlife") return false;
  const declared = new Set(
    event.artists.filter((name) => !name.startsWith("@")).map(normalize),
  );
  const namesArtist = (text: string) =>
    text.split(/[\r\n]+/u).some((line) => {
      const credits = line.split(/\s+[×x&+]\s+|\s*[,;]\s*/iu).map(normalize);
      return (
        credits.includes(normalize(performer)) &&
        credits.every((credit) => declared.has(credit))
      );
    });
  const anchor = dateEvidence(row, event.date);
  if (!anchor.dated || !anchor.matches) return false;
  if (namesArtist(row)) return true;
  const display = fields.carouselDisplaySlideIndex;
  if (
    typeof display !== "number" ||
    !Number.isSafeInteger(display) ||
    display < 0 ||
    !Array.isArray(fields.carouselSourceSlideIndexes) ||
    !fields.carouselSourceSlideIndexes.includes(display) ||
    !Array.isArray(fields.carouselPosterEvidence) ||
    fields.carouselPosterEvidence.length > 30
  )
    return false;
  const sameSlide = fields.carouselPosterEvidence
    .slice(0, 30)
    .flatMap((item) =>
      item?.slide_index === display && typeof item.text === "string"
        ? [item.text.slice(0, 800)]
        : [],
    );
  const text = sameSlide.join("\n");
  return (
    sameSlide.some((part) => normalize(part) === normalize(row)) &&
    dateEvidence(text, event.date).matches &&
    !forbidden.test(normalize(text)) &&
    !nonArtistIcon.test(text) &&
    namesArtist(text)
  );
}

function captionListsBilledTags(
  line: string,
  event: Doc<"events">,
  fields: Record<string, unknown>,
  handle: string,
) {
  if (
    !Array.isArray(fields.carouselTextEvidence) ||
    !fields.carouselTextEvidence
      .slice(0, 8)
      .some(
        (item) =>
          item?.source === "caption" &&
          typeof item.text === "string" &&
          item.text.trim() === line.trim(),
      )
  )
    return false;
  const rawLines = (event.sourceCaption ?? "")
    .slice(0, CAPTION_MAX_LENGTH)
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const index = rawLines.indexOf(line.trim());
  if (index < 0 || index !== rawLines.lastIndexOf(line.trim())) return false;
  const heading = rawLines[index - 1] ?? "";
  if (
    (forbidden.test(normalize(heading)) && /[:–—-]\s*$/.test(heading)) ||
    nonArtistIcon.test(heading)
  )
    return false;
  const day = dateEvidence(line, event.date);
  const match = /^\s*([\p{L}]+)\s*[/|:–—-]\s*(.+?)\s*$/u.exec(line);
  if (
    !day.dated ||
    !day.matches ||
    !match ||
    !weekdays.some((day) =>
      new RegExp(`^(?:${day})$`).test(normalize(match[1])),
    )
  )
    return false;
  const tags = accounts(match[2]);
  // Require a lineup made only of account tags and already billed co-performers.
  // The listing cannot introduce a role or assign the remaining tags to names.
  const known = new Set(
    event.artists.flatMap((name) =>
      [...name.matchAll(accountPattern)].map((m) => m[1].toLowerCase()),
    ),
  );
  return (
    tags.length >= 2 &&
    !match[2].replace(accountPattern, "").trim() &&
    tags.filter((tag) => tag.name === handle).length === 1 &&
    tags.every((tag) => tag.name === handle || known.has(tag.name))
  );
}

export function scopedPerformerHandles(
  event: Doc<"events">,
  fields: Record<string, unknown>,
  row?: string,
  caption?: string,
): PerformerHandleCredit[] {
  if (
    !row?.trim() ||
    !event.artists.length ||
    fields.sourceOccurrencePlanUnverified === true ||
    !canonicalizeSourceUrl(
      "instagram",
      event.instagramPostUrl ?? event.canonicalSourceUrl,
    ).ok ||
    !/^\d{4}-\d\d-\d\d$/.test(event.date) ||
    (!row.includes("@") && !caption?.includes("@"))
  )
    return [];
  const anchor = dateEvidence(row, event.date);
  if (
    !anchor.matches ||
    forbidden.test(normalize(row)) ||
    nonArtistIcon.test(row) ||
    withdrawn.test(normalize(caption))
  )
    return [];
  const plainRow = " " + normalize(row.replace(accountPattern, " ")) + " ";
  const blocked = new Set(
    [
      event.venue,
      event.venueInstagramHandle,
      event.normalizedVenueInstagramHandle,
      fields.canonicalVenueEvidenceHandle,
      fields.sourceGroundingInstagramHandle,
      fields.sourceAccountName,
    ]
      .filter((v): v is string => typeof v === "string")
      .map((v) => identityKey(v.replace(/^@/, ""))),
  );
  const names = event.artists
    .filter((a) => !a.includes("@"))
    .map((performer) => ({ performer, key: identityKey(performer.trim()) }));
  const result: PerformerHandleCredit[] = [];
  for (const { performer, key } of names) {
    if (
      !key ||
      blocked.has(key) ||
      names.filter((a) => a.key === key).length !== 1
    )
      continue;
    const inRow = plainRow.includes(" " + normalize(performer) + " ");
    const poster = namedPosterBill(event, fields, row, performer);
    if (!inRow && !poster) continue;
    const found = new Set<string>();
    let contradicted = false;
    for (const source of [row, caption ?? ""]) {
      let headingMatches = true,
        excludedHeading = false;
      for (const line of source.split(/[\r\n]+/)) {
        const date = dateEvidence(line, event.date),
          words = normalize(line);
        if (date.dated) {
          headingMatches = date.matches;
          excludedHeading = false;
        }
        const mentions = accounts(line);
        if (!mentions.length) {
          excludedHeading =
            (forbidden.test(words) && /[:\-–—]\s*$/.test(line)) ||
            nonArtistIcon.test(line);
          continue;
        }
        if (!headingMatches) continue;
        for (const mention of mentions.filter(
          (a) => identityKey(a.name) === key,
        )) {
          if (
            forbidden.test(words) ||
            nonArtistIcon.test(line) ||
            excludedHeading
          ) {
            contradicted = true;
            continue;
          }
          const before = normalize(line.slice(0, mention.at)),
            after = normalize(line.slice(mention.at + mention.length));
          const pair =
            before === normalize(performer) ||
            before.endsWith(" " + normalize(performer));
          const credited =
            /\b(?:nastupa|svira|peva|gostuje|za pultom|music by|on decks|dj set by|performing|live by)$/.test(
              before,
            ) ||
            /^(?:nastupa|svira|peva|gostuje|ponovo je sa nama|is performing|performs|vece muzik\w*)\b/.test(
              after,
            );
          if (
            (anchor.dated || date.dated) &&
            ((inRow && (pair || credited)) ||
              (poster &&
                source === caption &&
                captionListsBilledTags(line, event, fields, mention.name))) &&
            !mention.name.includes("..")
          )
            found.add(mention.name);
        }
        excludedHeading = false;
      }
    }
    if (!contradicted && found.size === 1)
      result.push({ performer, handle: [...found][0] });
  }
  return result;
}

export async function loadScopedPerformerHandles(
  ctx: Pick<QueryCtx, "db">,
  event: Doc<"events">,
) {
  if (!event.artists?.some((a) => !a.includes("@"))) return [];
  const fields = readEventEvidenceRecord(event.normalizedFieldsJson),
    row = occurrenceTextFromEvidence(fields);
  if (!row || (!row.includes("@") && !event.sourceCaption?.includes("@")))
    return [];
  const caption = await readScopedInstagramCaption(ctx, event, fields);
  return scopedPerformerHandles(event, fields, row, caption);
}
