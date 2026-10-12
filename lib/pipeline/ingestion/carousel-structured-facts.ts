import { parseExtractedEventData, type ExtractedEventData } from "@/lib/ai/extract-event-data";
import { CAROUSEL_EXTRACTION_CONTRACT_VERSION } from "@/lib/ai/carousel-media-contract";
import { buildNightlifeLineupCoalescingPlan, titleContainsOnlyBilledArtists } from "@/lib/events/nightlife-lineup-coalescing";
import { toSearchableText } from "@/lib/pipeline/venue-normalization";
import type { InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";
import type { StructuredFactEventResult, StructuredFactExtractionResult } from "./structured-fact-contracts";
import { isNonBillingEvidenceClause } from "./parsing-source-evidence";
import { artistIdentityAppearsInText } from "./structured-fact-verification";

type Row = ExtractedEventData["schedule_entries"][number];
type Snippet = { source: "caption" | "alt_text" | "poster"; text: string };

function comparableQuote(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function exactTextIsBound(text: string, source: string | null | undefined): boolean {
  const quote = comparableQuote(text);
  return Boolean(quote && source && comparableQuote(source).includes(quote));
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function readNumbers(result: StructuredFactEventResult, key: string): number[] {
  const values = result.normalizedFields[key];
  return Array.isArray(values) ? values.filter((value): value is number => Number.isSafeInteger(value)) : [];
}

function uniqueArtists(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = toSearchableText(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scopeConfirmation(snippets: Snippet[]): ExtractedEventData["field_confirmation"] {
  const sources = [...new Set(snippets.map((snippet) => snippet.source))];
  const confirmation = {
    confidence: 0, found_in: sources, evidence: "", evidence_snippets: snippets, notes: "",
  };
  return {
    title: confirmation, location: confirmation, location_name: confirmation,
    price: confirmation, start_time: confirmation, short_description: confirmation, artists: confirmation,
  };
}

function boundSharedContext(
  value: ExtractedEventData["shared_schedule_context"]["venue" | "time"],
  row: Row,
  post: InstagramScrapedPost,
): boolean {
  if (!value.applies_to_all || !value.evidence.trim()) return false;
  if (value.source === "poster") return value.slide_index !== null && value.slide_index !== undefined &&
    row.source_slide_indexes?.includes(value.slide_index) === true;
  if (value.source !== "caption" && value.source !== "alt_text") return false;
  return exactTextIsBound(value.evidence, value.source === "caption" ? post.caption : post.altText);
}

function buildScopedRow(post: InstagramScrapedPost, extracted: ExtractedEventData, row: Row): {
  extracted: ExtractedEventData; post: InstagramScrapedPost; unboundTextEvidence: boolean;
  artistEvidence: Snippet[];
} {
  const textSnippets: Snippet[] = [];
  let unboundTextEvidence = false;
  for (const snippet of row.text_evidence ?? []) {
    const source = snippet.source === "caption" ? post.caption : post.altText;
    if (exactTextIsBound(snippet.text, source)) textSnippets.push(snippet);
    else unboundTextEvidence = true;
  }
  for (const evidence of [row.date_evidence, row.time_evidence]) {
    if ((evidence.source === "caption" || evidence.source === "alt_text") &&
      exactTextIsBound(evidence.exact_text, evidence.source === "caption" ? post.caption : post.altText)) {
      textSnippets.push({ source: evidence.source, text: evidence.exact_text });
    }
  }
  for (const source of ["caption", "alt_text"] as const) {
    if (exactTextIsBound(row.source_text, source === "caption" ? post.caption : post.altText)) {
      textSnippets.push({ source, text: row.source_text });
    }
  }
  const emptyShared = { applies_to_all: false, value: "", evidence: "", source: "unknown" as const, slide_index: null };
  const shared: ExtractedEventData["shared_schedule_context"] = { venue: emptyShared, time: emptyShared };
  for (const field of ["venue", "time"] as const) {
    const value = extracted.shared_schedule_context[field];
    if (boundSharedContext(value, row, post)) {
      shared[field] = value;
      if (value.source === "caption" || value.source === "alt_text") {
        textSnippets.push({ source: value.source, text: value.evidence });
      }
    }
  }
  const posterSnippets: Snippet[] = (row.poster_evidence ?? [])
    .map((snippet) => ({ source: "poster", text: snippet.text }));
  if (row.source_slide_indexes?.length && !textSnippets.some((snippet) =>
    comparableQuote(snippet.text) === comparableQuote(row.source_text))) {
    posterSnippets.push({ source: "poster", text: row.source_text });
  }
  const snippets = [...posterSnippets, ...textSnippets];
  const scopedPost = {
    ...post,
    caption: [...new Set(textSnippets.filter((snippet) => snippet.source === "caption").map((snippet) => snippet.text))].join("\n"),
    altText: [...new Set(textSnippets.filter((snippet) => snippet.source === "alt_text").map((snippet) => snippet.text))].join("\n") || null,
  };
  return {
    unboundTextEvidence,
    artistEvidence: snippets.filter((snippet) => !isNonBillingEvidenceClause(snippet.text)),
    post: scopedPost,
    extracted: {
      ...extracted,
      title: row.title, date: row.date, time: row.time, venue: row.venue,
      artists: row.artists, description: row.description,
      category: row.category ?? "", price: row.price ?? "", currency: row.currency ?? "",
      date_evidence: row.date_evidence, time_evidence: row.time_evidence,
      source_conflicts: row.source_conflicts ?? [],
      shared_schedule_context: shared,
      schedule_entries: [row],
      field_confirmation: scopeConfirmation(snippets),
    },
  };
}

function holdUnverifiedCarouselEvidence(result: StructuredFactEventResult, reason: string): StructuredFactEventResult {
  return {
    ...result,
    facts: { ...result.facts, policy: {
      ...result.facts.policy, approvalDisposition: "pending", autoApproveRule: undefined,
      pendingReasons: [...new Set([...result.facts.policy.pendingReasons, reason])],
      signals: [...new Set([...result.facts.policy.signals, reason])], structuredEvidenceVerified: false,
    } },
    normalizedFields: {
      ...result.normalizedFields, moderationAutoApproved: false, moderationAutoApproveRule: null,
      structuredEvidenceVerified: false,
      carouselPhysicalVenue: undefined,
      moderationPendingReasons: [...new Set([...result.facts.policy.pendingReasons, reason])],
      moderationSignals: [...new Set([...result.facts.policy.signals, reason])],
    },
  };
}

const ROOM_SCOPE = /\b(?:upstairs|downstairs|upper|lower|gornj[iae]|donj[iae]|room|sala|stage|sprat|independent|separate|odvojen[iae])\b/iu;

function independentProgramScope(result: StructuredFactEventResult): string {
  const description = result.presentation.description ?? "";
  return ROOM_SCOPE.test(description) ? toSearchableText(description) : "";
}

function mergeEquivalentResults(results: StructuredFactEventResult[], title?: string, description?: string): StructuredFactEventResult {
  const first = results[0];
  const artists = uniqueArtists(results.flatMap((result) => [...result.facts.artistClaims]));
  const indexes = uniqueNumbers(results.flatMap((result) => readNumbers(result, "carouselSourceSlideIndexes")));
  const rowIndexes = uniqueNumbers(results.flatMap((result) => readNumbers(result, "carouselSourceRowIndexes")));
  const pendingReasons = [...new Set(results.flatMap((result) => [...result.facts.policy.pendingReasons]))];
  const signals = [...new Set(results.flatMap((result) => [...result.facts.policy.signals]))];
  const verified = results.every((result) => result.facts.policy.structuredEvidenceVerified);
  const approved = results.every((result) => result.facts.policy.approvalDisposition === "approved");
  const titleClaim = title ?? first.facts.titleClaim;
  return {
    ...first,
    facts: { ...first.facts, titleClaim, artistClaims: artists,
      evidence: results.flatMap((result) => [...result.facts.evidence]),
      policy: { ...first.facts.policy, approvalDisposition: approved ? "approved" : "pending",
        ...(approved ? {} : { autoApproveRule: undefined }), pendingReasons, signals,
        structuredEvidenceVerified: verified } },
    evidence: { ...first.evidence,
      sourceConflictFields: [...new Set(results.flatMap((result) => [...result.evidence.sourceConflictFields]))] },
    presentation: { ...first.presentation,
      ...(description ? { description } : {}) },
    normalizedFields: {
      ...first.normalizedFields,
      title: titleClaim, artists, carouselSourceSlideIndexes: indexes, carouselSourceRowIndexes: rowIndexes,
      carouselRepeatedRowCount: results.length, structuredEvidenceVerified: verified,
      carouselPhysicalVenue: verified ? first.facts.venueClaim ?? "" : undefined,
      moderationAutoApproved: approved, moderationAutoApproveRule: approved ? first.facts.policy.autoApproveRule ?? null : null,
      moderationPendingReasons: pendingReasons, moderationSignals: signals,
      ...(description ? { description } : {}),
    },
  };
}

function deduplicateRepeatedOccurrences(results: StructuredFactExtractionResult[]): StructuredFactExtractionResult[] {
  const seen = new Map<string, number>();
  const output: StructuredFactExtractionResult[] = [];
  for (const result of results) {
    if (result.kind !== "event") { output.push(result); continue; }
    const key = JSON.stringify([result.facts.localDate, result.facts.startTime ?? "",
      toSearchableText(result.facts.venueClaim ?? ""), toSearchableText(result.facts.titleClaim),
      result.facts.eventTypeClaim ?? "", result.presentation.ticketPrice ?? "", independentProgramScope(result)]);
    const index = seen.get(key);
    if (index === undefined) { seen.set(key, output.length); output.push(result); continue; }
    const previous = output[index];
    if (previous.kind !== "event") throw new Error("Carousel occurrence deduplication lost its typed fact.");
    output[index] = mergeEquivalentResults([previous, result]);
  }
  return output;
}

function coalesceExplicitPartySlots(results: StructuredFactExtractionResult[]): StructuredFactExtractionResult[] {
  const groups = new Map<string, Array<{ index: number; result: StructuredFactEventResult }>>();
  results.forEach((result, index) => {
    if (result.kind !== "event" || result.facts.eventTypeClaim !== "nightlife" ||
      !result.facts.policy.structuredEvidenceVerified || independentProgramScope(result) ||
      !titleContainsOnlyBilledArtists(result.facts.titleClaim, [...result.facts.artistClaims])) return;
    const key = JSON.stringify([result.facts.localDate, toSearchableText(result.facts.venueClaim ?? ""),
      result.presentation.ticketPrice ?? ""]);
    const group = groups.get(key) ?? [];
    group.push({ index, result }); groups.set(key, group);
  });
  const replacements = new Map<number, StructuredFactEventResult>();
  const consumed = new Set<number>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sharedSlides = readNumbers(group[0].result, "carouselSourceSlideIndexes").filter((slide) =>
      group.every(({ result }) => readNumbers(result, "carouselSourceSlideIndexes").includes(slide)));
    if (sharedSlides.length === 0) continue;
    if (group.some(({ result }) => ROOM_SCOPE.test(String(result.normalizedFields.splitSourceLine ?? "")))) continue;
    const plan = buildNightlifeLineupCoalescingPlan({
      eventType: "nightlife", sourceConflictCount: 0, sharedTime: { value: "", verified: false },
      candidates: group.map(({ index, result }) => ({
        id: String(index), title: result.facts.titleClaim, date: result.facts.localDate,
        time: result.facts.startTime, venue: result.facts.venueClaim ?? "", artists: [...result.facts.artistClaims],
        sourceText: String(result.normalizedFields.splitSourceLine ?? ""), source: "poster",
        sourcePostIdentity: result.source.instagramPostId || result.source.instagramPostUrl,
        timeEvidenceText: result.evidence.timeEvidenceText ?? "", timeEvidenceVerified: true,
        timeEvidenceKind: result.evidence.timeEvidenceKind,
      })),
    });
    if (!plan) continue;
    const merged = mergeEquivalentResults(group.map(({ result }) => result), plan.title, plan.description);
    merged.facts = { ...merged.facts, startTime: plan.time, timeRelation: "exact" };
    merged.normalizedFields = { ...merged.normalizedFields, time: plan.time,
      lineupScheduleCoalesced: true, lineupScheduleTimingMode: plan.timingMode };
    replacements.set(group[0].index, merged);
    group.slice(1).forEach(({ index }) => consumed.add(index));
  }
  return results.flatMap((result, index) => consumed.has(index) ? [] : [replacements.get(index) ?? result]);
}

/** Derive row-local facts while retaining the original immutable analysis bytes. */
export function produceCarouselStructuredFacts(options: {
  post: InstagramScrapedPost;
  extracted: ExtractedEventData;
  prepare: (post: InstagramScrapedPost, extracted: ExtractedEventData, imageUrl: string | null) => StructuredFactExtractionResult[];
}): StructuredFactExtractionResult[] {
  const extracted = parseExtractedEventData(options.extracted);
  if (extracted._carouselContractVersion !== CAROUSEL_EXTRACTION_CONTRACT_VERSION || !extracted._carouselMedia) {
    throw new Error("Carousel planning requires exact retained-image evidence.");
  }
  if (!extracted.is_event || extracted.schedule_entries.length === 0) {
    return options.prepare(options.post, { ...extracted, _carouselContractVersion: undefined, _carouselMedia: undefined }, null);
  }
  const results = extracted.schedule_entries.flatMap((row, rowIndex) => {
    const scoped = buildScopedRow(options.post, extracted, row);
    const slideIndexes = [...(row.source_slide_indexes ?? [])].sort((left, right) => left - right);
    const displayIndex = row.date_evidence.source === "poster" ? row.date_evidence.slide_index
      : slideIndexes[0] ?? extracted._carouselMedia!.images[0].slideIndex;
    const image = extracted._carouselMedia!.images.find((binding) => binding.slideIndex === displayIndex);
    if (!image) throw new Error("Carousel display image is outside the retained analysis.");
    return options.prepare(scoped.post, scoped.extracted, slideIndexes.length ? image.sourceUrl : null).map((result) => {
      const normalizedFields = {
        ...result.normalizedFields, extractionCarouselContractVersion: CAROUSEL_EXTRACTION_CONTRACT_VERSION,
        carouselSourceSlideIndexes: slideIndexes, carouselSourceRowIndexes: [rowIndex],
        carouselDisplaySlideIndex: displayIndex,
        carouselSourceText: row.source_text, carouselPosterEvidence: row.poster_evidence,
        carouselTextEvidence: row.text_evidence,
        sourceGroundingSourceCaption: options.post.caption ?? null,
        postAltText: options.post.altText ?? null,
      };
      if (result.kind === "skip") return { ...result, normalizedFields };
      const event = { ...result, normalizedFields, source: {
        ...result.source, caption: options.post.caption ?? undefined, postedAt: options.post.postedAt ?? undefined,
      } };
      event.normalizedFields = { ...event.normalizedFields,
        ...(event.facts.policy.structuredEvidenceVerified ? {
          carouselPhysicalVenue: event.facts.venueClaim ?? "",
        } : {}),
      };
      let verifiedEvent = scoped.unboundTextEvidence
        ? holdUnverifiedCarouselEvidence(event, "carousel_unbound_text_evidence") : event;
      if (!verifiedEvent.facts.artistClaims.every((artist) => scoped.artistEvidence.some((snippet) =>
        artistIdentityAppearsInText(snippet.text, artist)))) {
        verifiedEvent = holdUnverifiedCarouselEvidence(verifiedEvent, "carousel_unbilled_artist_evidence");
      }
      return verifiedEvent;
    });
  });
  const occurrences = coalesceExplicitPartySlots(deduplicateRepeatedOccurrences(results));
  return occurrences.map((result, index) => ({
    ...result,
    ...(result.kind === "event" && occurrences.length > 1 ? {
      facts: { ...result.facts, scheduleRole: "row" as const },
    } : {}),
    normalizedFields: { ...result.normalizedFields,
      multiEventSplitDetected: occurrences.length > 1, multiEventSplitCount: occurrences.length,
      splitEventIndex: index + 1, splitEventTotal: occurrences.length,
    },
  }));
}
