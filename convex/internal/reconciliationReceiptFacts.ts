import type { Doc } from "../_generated/dataModel";
import { DomainError } from "../../lib/domain/errors";
import {
  parseStructuredFactsJson,
  projectStructuredFactsToOccurrenceBinding,
} from "../../lib/domain/occurrences/facts";
import {
  MAX_SOURCE_OCCURRENCE_ARTISTS,
  MAX_SOURCE_OCCURRENCE_STRING_LENGTH,
} from "./sourceOccurrenceReceipts";

function parseObject(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readStringAllowEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length > MAX_SOURCE_OCCURRENCE_STRING_LENGTH) {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Normalized occurrence string exceeds the hard bound.",
    );
  }
  return value.trim();
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length > MAX_SOURCE_OCCURRENCE_STRING_LENGTH) {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Normalized occurrence string exceeds the hard bound.",
    );
  }
  return value.trim() || null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_SOURCE_OCCURRENCE_ARTISTS) {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Normalized occurrence artist set exceeds the hard bound.",
    );
  }
  const values = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  if (
    values.length !== value.length ||
    values.some((item) => item.length > MAX_SOURCE_OCCURRENCE_STRING_LENGTH)
  ) {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Normalized occurrence artists contain invalid strings.",
    );
  }
  return values;
}

function normalizeOccurrenceText(value: string | undefined): string {
  return (
    value
      ?.normalize("NFKC")
      .replace(/\s+/gu, " ")
      .trim()
      .toLocaleLowerCase("sr-Latn") ?? ""
  );
}

/**
 * One semantic receipt/facts predicate shared by both admission verification
 * and the actual receipt writer. A verifier must never certify a row that the
 * executor will deterministically reject later.
 */
export function receiptExpectedMatchesOccurrenceFacts(
  expected: {
    artists: string[];
    date: string;
    key: string;
    time?: string;
    title: string;
    venue: string;
  },
  occurrence: Doc<"sourceOccurrences">,
): boolean {
  const normalized = parseObject(occurrence.normalizedOccurrenceJson);
  const structuredFacts = parseStructuredFactsJson(occurrence.factsJson);
  const facts = parseObject(occurrence.factsJson);
  if (!facts) return false;
  if (occurrence.normalizedOccurrenceJson && !normalized) return false;
  const normalizedDate = readString(normalized?.date);
  const normalizedTitle = readString(normalized?.title);
  const normalizedVenue = readStringAllowEmpty(normalized?.venue);
  if (
    normalized &&
    (!normalizedDate ||
      !normalizedTitle ||
      normalizedVenue === null ||
      !Array.isArray(normalized.artists))
  ) {
    return false;
  }
  const bindingSource = normalized
    ? "normalized"
    : structuredFacts
      ? "structured_facts"
      : "legacy_facts";
  const factBinding = normalized
    ? {
        artists: readStringArray(normalized.artists),
        date: normalizedDate!,
        key: null,
        time: readString(normalized.time) ?? undefined,
        title: normalizedTitle!,
        venue: normalizedVenue!,
      }
    : structuredFacts
      ? {
          ...projectStructuredFactsToOccurrenceBinding(structuredFacts),
          key: null,
        }
      : {
          artists: readStringArray(facts.artists),
          date: readString(facts.date) ?? "",
          key: readString(facts.key),
          time: readString(facts.time) ?? undefined,
          title: readString(facts.title) ?? "",
          venue: readStringAllowEmpty(facts.venue) ?? "",
        };
  const factArtists = factBinding.artists
    .map(normalizeOccurrenceText)
    .filter(Boolean)
    .sort();
  const expectedArtists = expected.artists
    .map(normalizeOccurrenceText)
    .filter(Boolean)
    .sort();
  return (
    (bindingSource !== "legacy_facts" ||
      factBinding.key === occurrence.sourceOccurrenceKey) &&
    expected.key === occurrence.sourceOccurrenceKey &&
    normalizeOccurrenceText(factBinding.date) ===
      normalizeOccurrenceText(expected.date) &&
    normalizeOccurrenceText(factBinding.time) ===
      normalizeOccurrenceText(expected.time) &&
    normalizeOccurrenceText(factBinding.title) ===
      normalizeOccurrenceText(expected.title) &&
    normalizeOccurrenceText(factBinding.venue) ===
      normalizeOccurrenceText(expected.venue) &&
    JSON.stringify(factArtists) === JSON.stringify(expectedArtists)
  );
}
