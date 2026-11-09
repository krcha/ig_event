import { scopedConflictSources } from "./event-evidence-conflict-policy.ts";
import {
  buildPendingSourceConflictContext,
  readBoundExtractionSourceConflicts,
} from "./pending-source-conflict-reclassification.ts";
import { toSearchableText } from "../domain/venues/normalization.ts";

type EventArtistDisplayEvidence = {
  artists: string[];
  title?: string;
  date?: string;
  venue?: string;
  time?: string;
  sourceCaption?: string;
  sourcePostedAt?: string;
  normalizedFieldsJson?: string;
  rawExtractionJson?: string;
};

const handlePattern = /^@[a-z0-9._]{1,30}$/iu;
const billingPrefixes = ["dj", "live", "lineup", "nastupa", "nastupaju", "svira", "sviraju", "gostuje", "gostuju", "uz", "with", "feat", "featuring", "b2b", "music by", "performance by", "set by", "za muziku"];
const billingSuffixes = ["b2b", "dj", "live", "set", "klavir", "piano", "bas", "bass", "bubnjevi", "drums", "gitara", "guitar", "vokal", "vocals"];
const unrelatedCredit = /\b(?:venue|lokacija|location|adresa|address|organizer|organizator|sponsor|sponsored|sponzor|credit|credits|foto|photo|photography|design|visuals|production|produkcija|thanks|hvala|zahvaljujemo|reservations?|rezervacije)\b/u;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function displayKey(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function creditLabel(value: unknown): string {
  if (typeof value !== "string" || value.length > 200 || /[\r\n#]/u.test(value)) return "";
  return value.replace(/\s+[-–—]\s+(?:dj|klavir|piano|bass?|bubnjevi|drums|gitara|guitar|vokal|vocals?)\s*$/iu, "").trim();
}

function billingText(source: string): string {
  return ` ${toSearchableText(source.replace(/#[\p{L}\p{N}._-]+/gu, " "))} `;
}

function sourceContainsCredit(source: string, credit: string): boolean {
  if (!handlePattern.test(credit)) {
    const label = toSearchableText(credit);
    return Boolean(label) && billingText(source).includes(` ${label} `);
  }
  return [...source.matchAll(/(?<![\p{L}\p{N}._#@/-])@[a-z0-9._]+(?![\p{L}\p{N}._-])/giu)].some(([handle]) =>
    displayKey(handle.replace(/\.+$/u, "")) === displayKey(credit));
}

function isBilledInSource(source: string, credit: string): boolean {
  const label = toSearchableText(credit);
  return Boolean(label) && source.split(/[\r\n;|]+/u).some((line) => {
    const normalized = billingText(line);
    return !line.includes("📍") && !unrelatedCredit.test(normalized) && sourceContainsCredit(line, credit) &&
      (billingPrefixes.some((role) => normalized.includes(` ${role} ${label} `)) ||
        billingSuffixes.some((role) => normalized.includes(` ${label} ${role} `)));
  });
}

function introducesWorkshopInstructor(caption: string, handle: string): boolean {
  const [intro, ...paragraphs] = caption.trim().split(/\r?\n\s*\r?\n/u);
  if (!handlePattern.test(handle) || displayKey(intro) !== displayKey(handle)) return false;
  const description = paragraphs.slice(0, 3).join(" ").slice(0, 600);
  return /\bI (?:am|bring|will)\b/u.test(description) &&
    /\bin this workshop,? (?:I|we) will\b/iu.test(description);
}

function hasExactPosterArtistQuote(raw: Record<string, unknown>, credit: string): boolean {
  const confirmation = record(record(raw.field_confirmation)?.artists);
  return Array.isArray(confirmation?.evidence_snippets) && confirmation.evidence_snippets.some((value) => {
    const snippet = record(value);
    return snippet?.source === "poster" && typeof snippet.text === "string" &&
      displayKey(snippet.text) === displayKey(credit);
  });
}

/** Display separately billed credits without treating them as a verified identity pair. */
export function getEventArtistDisplayCredits(event: EventArtistDisplayEvidence): string[] {
  if (!event.artists.length || !event.rawExtractionJson || !event.normalizedFieldsJson || !event.sourceCaption) return event.artists;

  let fields: Record<string, unknown> | null;
  let raw: Record<string, unknown> | null;
  try {
    fields = record(JSON.parse(event.normalizedFieldsJson));
    if (!fields || !Array.isArray(fields.extractionSourceConflicts) ||
        !fields.extractionSourceConflicts.some((value) => record(value)?.field === "artists")) return event.artists;
    raw = record(JSON.parse(event.rawExtractionJson));
  } catch {
    return event.artists;
  }
  if (!raw || fields.extractionContractVersion !== "event_evidence_v2" || raw.is_event !== true || raw.source_caption !== event.sourceCaption ||
      fields.title !== event.title || fields.normalizedDate !== event.date || fields.normalizedVenue !== event.venue ||
      fields.sourceGroundingSourceCaption !== event.sourceCaption) return event.artists;

  const conflicts = readBoundExtractionSourceConflicts(event, fields, raw);
  if (!Array.isArray(conflicts) || !Array.isArray(fields.extractionSourceConflicts) ||
      JSON.stringify(conflicts) !== JSON.stringify(fields.extractionSourceConflicts)) return event.artists;
  const context = buildPendingSourceConflictContext(event, fields, raw);
  const sources = scopedConflictSources(context);
  if (!context.dateEvidenceVerified || !sources) return event.artists;
  const [poster, caption] = sources;
  const listed = new Set(event.artists.flatMap((artist) => {
    const pair = /^(.*?)\s+\((@[a-z0-9._]{1,30})\)$/iu.exec(artist);
    return pair ? [displayKey(pair[1]), displayKey(pair[2])] : [displayKey(artist)];
  }));
  const extraCredits: string[] = [];

  for (const value of conflicts) {
    const conflict = record(value);
    if (conflict?.field !== "artists") continue;
    const posterCredit = creditLabel(conflict.poster_value);
    const captionCredit = creditLabel(conflict.caption_value);
    if (!posterCredit || !captionCredit || handlePattern.test(posterCredit) === handlePattern.test(captionCredit) ||
        [posterCredit, captionCredit].some((credit) => credit.includes("@") && !handlePattern.test(credit)) ||
        !sourceContainsCredit(poster, posterCredit) || !sourceContainsCredit(caption, captionCredit)) continue;

    const hasPosterCredit = listed.has(displayKey(posterCredit));
    const hasCaptionCredit = listed.has(displayKey(captionCredit));
    if (hasPosterCredit === hasCaptionCredit) continue;

    const missingCredit = hasPosterCredit ? captionCredit : posterCredit;
    const source = hasPosterCredit ? caption : poster;
    const hasRoleEvidence = hasPosterCredit
      ? introducesWorkshopInstructor(caption, missingCredit)
      : context.singleOccurrenceSource && hasExactPosterArtistQuote(raw, missingCredit);
    if (!hasRoleEvidence && !isBilledInSource(source, missingCredit)) continue;
    extraCredits.push(missingCredit);
    listed.add(displayKey(missingCredit));
  }

  return extraCredits.length ? [...event.artists, ...extraCredits] : event.artists;
}
