/**
 * Compatibility facade for callers that have not yet adopted the venue domain
 * path. All venue normalization and evidence precedence is authoritative in
 * `lib/domain/venues/normalization.ts`.
 */
export * from "../domain/venues/normalization";
