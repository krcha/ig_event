import { type ExtractedEventData } from "@/lib/ai/extract-event-data";
import { type CanonicalVenueAliasesByHandle, toSearchableText, type VenueNormalization } from "@/lib/pipeline/venue-normalization";
import { type InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";
import { buildContextDerivedEventTitle, buildFallbackTitle, isGenericEventTitle, isMeaninglessEventTitle, isWeakEventTitleSectionHeading } from "@/lib/pipeline/ingestion/parsing-event-text";
import { isHashtagOnlySourceIdentity } from "@/lib/pipeline/ingestion/parsing-source-evidence";
import { normalizeString } from "@/lib/pipeline/ingestion/values";

export function normalizeEventTitle(
  post: InstagramScrapedPost,
  extracted: ExtractedEventData,
  venue: VenueNormalization,
  canonicalVenueNamesByHandle: Record<string, string>,
  canonicalVenueAliasesByHandle: CanonicalVenueAliasesByHandle,
  configuredVenueNamesByHandle: Record<string, string>,
): {
  title: string;
  source: "model" | "context_derived" | "handle_fallback";
  rawTitle: string;
  usedFallback: boolean;
  contextCandidate: string | null;
} {
  const rawTitle = normalizeString(extracted.title);
  const modelScheduleEvidence = extracted.schedule_entries
    .map((entry) => normalizeString(entry.source_text))
    .filter(Boolean);
  const usableRawTitle = isHashtagOnlySourceIdentity(rawTitle, post, modelScheduleEvidence)
    ? ""
    : rawTitle;
  const captionText = normalizeString(post.caption);
  const normalizedRawTitle = toSearchableText(usableRawTitle);
  const normalizedCaption = toSearchableText(captionText);
  const titleAppearsInCaption =
    normalizedRawTitle.length > 0 && normalizedCaption.includes(normalizedRawTitle);
  const weakSectionTitle = isWeakEventTitleSectionHeading(usableRawTitle);

  if (
    usableRawTitle &&
    !isMeaninglessEventTitle(usableRawTitle) &&
    !weakSectionTitle &&
    (!isGenericEventTitle(usableRawTitle) || titleAppearsInCaption)
  ) {
    return {
      title: usableRawTitle,
      source: "model",
      rawTitle,
      usedFallback: false,
      contextCandidate: null,
    };
  }

  const contextDerivedTitle = buildContextDerivedEventTitle(
    usableRawTitle,
    extracted,
    post,
    venue,
    configuredVenueNamesByHandle,
  );
  if (contextDerivedTitle) {
    return {
      title: contextDerivedTitle.title,
      source: "context_derived",
      rawTitle,
      usedFallback: false,
      contextCandidate: contextDerivedTitle.contextCandidate,
    };
  }

  return {
    title: buildFallbackTitle(
      post,
      venue,
      canonicalVenueNamesByHandle,
      canonicalVenueAliasesByHandle,
      configuredVenueNamesByHandle,
    ),
    source: "handle_fallback",
    rawTitle,
    usedFallback: true,
    contextCandidate: null,
  };
}
