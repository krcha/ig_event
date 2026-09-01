import type { Doc } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import type { OccurrenceCandidateIndexFields } from "../../lib/domain/occurrences/signature";

export const MAX_OCCURRENCE_CANDIDATES = 25;

export type OccurrenceCandidateResult = {
  candidates: Doc<"events">[];
  limit: number;
  truncated: boolean;
};

export type OccurrenceCandidateLookupFields = Pick<
  OccurrenceCandidateIndexFields,
  | "occurrenceDateKey"
  | "occurrenceSignatureHash"
  | "occurrenceSignatureVersion"
  | "occurrenceTitleFamily"
  | "occurrenceVenueIdentity"
>;

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 12;
  return Math.max(1, Math.min(MAX_OCCURRENCE_CANDIDATES, Math.trunc(value as number)));
}

/**
 * The one bounded event-candidate repository. A signature narrows the search;
 * the caller must still run semantic reconciliation before treating rows as
 * duplicates. `truncated` is conservative, because uncertainty must not cause
 * an automatic merge.
 */
export async function loadOccurrenceCandidates(
  db: DatabaseReader,
  signature: OccurrenceCandidateLookupFields,
  requestedLimit?: number,
): Promise<OccurrenceCandidateResult> {
  const limit = normalizeLimit(requestedLimit);
  const byId = new Map<string, Doc<"events">>();
  const [exact, venueCandidates, titleCandidates] = await Promise.all([
    db
      .query("events")
      .withIndex("by_occurrenceSignatureHash", (q) =>
        q
          .eq("occurrenceSignatureVersion", signature.occurrenceSignatureVersion)
          .eq("occurrenceSignatureHash", signature.occurrenceSignatureHash),
      )
      .take(limit + 1),
    signature.occurrenceVenueIdentity !== "unknown-venue"
      ? db
          .query("events")
          .withIndex("by_occurrenceDateVenue", (q) =>
            q
              .eq("occurrenceSignatureVersion", signature.occurrenceSignatureVersion)
              .eq("occurrenceDateKey", signature.occurrenceDateKey)
              .eq("occurrenceVenueIdentity", signature.occurrenceVenueIdentity),
          )
          .take(limit + 1)
      : Promise.resolve([] as Doc<"events">[]),
    signature.occurrenceTitleFamily !== "unknown-title"
      ? db
          .query("events")
          .withIndex("by_occurrenceDateTitle", (q) =>
            q
              .eq("occurrenceSignatureVersion", signature.occurrenceSignatureVersion)
              .eq("occurrenceDateKey", signature.occurrenceDateKey)
              .eq("occurrenceTitleFamily", signature.occurrenceTitleFamily),
          )
          .take(limit + 1)
      : Promise.resolve([] as Doc<"events">[]),
  ]);
  for (const row of [...exact, ...venueCandidates, ...titleCandidates]) {
    byId.set(String(row._id), row);
  }
  const truncated =
    exact.length > limit ||
    venueCandidates.length > limit ||
    titleCandidates.length > limit ||
    byId.size > limit;

  return {
    candidates: [...byId.values()].slice(0, limit),
    limit,
    truncated,
  };
}
