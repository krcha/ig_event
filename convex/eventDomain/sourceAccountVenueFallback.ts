import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { canonicalizeSourceUrlOrEmpty } from "../../lib/domain/source-url";
import { normalizeHandle } from "../../lib/domain/venues/normalization";
import { isVenuePublic } from "../../lib/venues/venue-lifecycle";
import {
  resolveVenueClaimsForWrite,
  resolveVenueForWrite,
} from "../venueResolver";

const MAX_FALLBACK_VENUE_CLAIMS = 16;
const MAX_FALLBACK_SCHEDULE_ROWS = 96;

type SourceAccountVenueFallbackCandidate = {
  venue: string;
  venueId?: Id<"venues">;
  venueInstagramHandle?: string;
  normalizedFieldsJson?: string;
  rawExtractionJson?: string;
  instagramPostId?: string;
  instagramPostUrl?: string;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parsedObject(value: string | undefined): Record<string, unknown> | null {
  try {
    return object(JSON.parse(value ?? "null"));
  } catch {
    return null;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function fallbackVenueClaims(
  fields: Record<string, unknown>,
  raw: Record<string, unknown>,
): string[] {
  const claims = [text(fields.rawVenue), text(raw.venue)];
  for (const context of [fields.sharedScheduleContext, raw.shared_schedule_context]) {
    const venue = object(object(context)?.venue);
    if (venue?.applies_to_all === true) claims.push(text(venue.value));
  }
  const entries = Array.isArray(raw.schedule_entries)
    ? raw.schedule_entries.map(object)
    : [];
  const rowSourceText = text(fields.rowSourceText);
  if (entries.length > MAX_FALLBACK_SCHEDULE_ROWS) {
    throw new Error("Venue account fallback exceeds the safe schedule row bound.");
  }
  if (entries.length > 0 || fields.lineupScheduleCoalesced === true) {
    let selected;
    if (fields.lineupScheduleCoalesced === true) {
      const evidence = Array.isArray(fields.lineupScheduleSourceEvidence)
        ? fields.lineupScheduleSourceEvidence.map(object)
        : [];
      const quotes = evidence.map((item) => text(item?.text));
      if (
        fields.lineupScheduleCoalescingPolicyVersion !== 2 ||
        evidence.length < 2 || evidence.length > MAX_FALLBACK_SCHEDULE_ROWS ||
        fields.lineupScheduleSourceRowCount !== evidence.length ||
        quotes.some((quote) => !quote) ||
        new Set(quotes).size !== quotes.length ||
        evidence.some((item) => item?.source !== "caption" &&
          item?.source !== "poster" && item?.source !== "alt_text")
      ) {
        throw new Error("Venue account fallback lacks exact coalesced schedule evidence.");
      }
      const matches = quotes.map((quote) => entries.filter((entry) => text(entry?.source_text) === quote));
      if (matches.some((rows) => rows.length === 0)) {
        throw new Error("Venue account fallback coalesced row quotes do not match the saved source.");
      }
      selected = matches.flat();
    } else {
      selected = rowSourceText
      ? entries.filter((entry) => text(entry?.source_text) === rowSourceText)
      : entries.length === 1 ? entries : [];
    }
    if (selected.length === 0 || selected.some((entry) => entry === null)) {
      throw new Error("Venue account fallback lacks its exact selected schedule row.");
    }
    claims.push(...selected.map((entry) => text(entry?.venue)));
  }
  const unique = [...new Set(claims.filter(Boolean))];
  if (unique.length > MAX_FALLBACK_VENUE_CLAIMS) {
    throw new Error("Venue account fallback exceeds the safe venue claim bound.");
  }
  return unique;
}

/**
 * Defense at the source approval boundary for the account fallback selected by
 * ingestion. Existing unmarked evidence retains its original policy. This
 * helper validates the new inference; it never rewrites extracted claims.
 */
export async function assertSourceAccountVenueFallbackPolicy(
  ctx: QueryCtx | MutationCtx,
  candidate: SourceAccountVenueFallbackCandidate,
  persistedPost: Doc<"scrapedPosts">,
): Promise<void> {
  const fields = parsedObject(candidate.normalizedFieldsJson);
  if (!fields || !Object.hasOwn(fields, "venueAccountFallbackVersion")) return;
  const raw = parsedObject(candidate.rawExtractionJson);
  const sourceHandle = normalizeHandle(text(fields.sourceGroundingInstagramHandle));
  const postId = candidate.instagramPostId?.trim() ?? "";
  const postUrl = canonicalizeSourceUrlOrEmpty("instagram", candidate.instagramPostUrl);
  if (
    fields.venueAccountFallbackVersion !== 1 ||
    fields.sourceAccountRole !== "venue" ||
    fields.trustedVenueSource !== true ||
    fields.venueSource !== "handle_map" ||
    !raw ||
    !sourceHandle ||
    normalizeHandle(persistedPost.handle) !== sourceHandle ||
    normalizeHandle(persistedPost.username) !== sourceHandle ||
    !postId || persistedPost.postId !== postId ||
    text(fields.sourceGroundingInstagramPostId) !== postId ||
    !postUrl ||
    canonicalizeSourceUrlOrEmpty("instagram", persistedPost.instagramPostUrl) !== postUrl ||
    canonicalizeSourceUrlOrEmpty("instagram", text(fields.sourceGroundingInstagramPostUrl)) !== postUrl ||
    persistedPost.analysisResultJson !== candidate.rawExtractionJson
  ) {
    throw new Error("Venue account fallback lacks exact persisted source evidence.");
  }

  const sourceRows = await ctx.db
    .query("instagramSources")
    .withIndex("by_handle", (q) => q.eq("handle", sourceHandle))
    .take(2);
  const source = sourceRows.length === 1 ? sourceRows[0] : null;
  if (!source?.active || source.role !== "venue" || !source.venueId) {
    throw new Error("Venue account fallback requires one active mapped venue account.");
  }
  const venue = await ctx.db.get(source.venueId);
  if (
    !venue || !isVenuePublic(venue) ||
    normalizeHandle(venue.instagramHandle) !== sourceHandle ||
    candidate.venue !== venue.name ||
    fields.normalizedVenue !== venue.name ||
    normalizeHandle(candidate.venueInstagramHandle ?? "") !== sourceHandle ||
    (candidate.venueId !== undefined && candidate.venueId !== venue._id)
  ) {
    throw new Error("Venue account fallback must bind the exact public catalog venue.");
  }

  const accountResolution = await resolveVenueForWrite(ctx, `@${sourceHandle}`);
  if (
    accountResolution.resolution.status !== "resolved" ||
    accountResolution.venueFields.venueId !== venue._id ||
    accountResolution.canonicalVenueName !== venue.name
  ) {
    throw new Error("Venue account fallback account identity is unresolved or ambiguous.");
  }
  const claims = fallbackVenueClaims(fields, raw);
  const resolutions = await resolveVenueClaimsForWrite(ctx, claims);
  if (claims.some((claim) => {
    const resolved = resolutions.get(claim);
    return resolved?.resolution.status !== "resolved" ||
      resolved.venueFields.venueId !== venue._id;
  })) {
    throw new Error("Venue account fallback cannot replace an explicit different or unresolved venue.");
  }
}
