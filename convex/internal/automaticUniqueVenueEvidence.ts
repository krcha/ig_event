import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { resolveVenueClaimsForWrite } from "../venueResolver";

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function text(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").trim() : "";
}

/** Read source claims for this occurrence, never another row in a roundup.
 * A row's explicit physical venue takes precedence over a global parent name.
 * An empty claim creates no new requirement for source-account fallbacks.
 */
export function automaticUniqueSourceVenueClaims(
  fields: Record<string, unknown>, raw: Record<string, unknown>,
): string[] {
  if (raw.extraction_contract_version !== "event_evidence_v2" || raw.is_event !== true) return [];
  const entries = Array.isArray(raw.schedule_entries) ? raw.schedule_entries : [];
  if (entries.length > 64) throw new Error("Automatic venue evidence exceeds the bounded source plan.");
  const rowText = text(fields.rowSourceText) || text(fields.splitSourceLine);
  const selectedRows = entries.map(object).filter((row) => row && rowText && text(row.source_text) === rowText);
  const rowClaims = selectedRows.map((row) => text(row?.venue)).filter(Boolean);
  if (rowClaims.length) return [...new Set(rowClaims)];
  const sharedVenue = object(object(raw.shared_schedule_context)?.venue);
  const claims = [
    text(raw.venue),
    ...(sharedVenue?.applies_to_all === true ? [text(sharedVenue.value)] : []),
  ].filter(Boolean);
  // rawVenue is a derived per-row claim. Use it only when the immutable
  // analysis explicitly names that value, rather than a handle-map fallback.
  const normalizedRaw = text(fields.rawVenue);
  if (normalizedRaw && [text(raw.venue), ...rowClaims, text(sharedVenue?.value)].includes(normalizedRaw)) {
    claims.push(normalizedRaw);
  }
  return [...new Set(claims)];
}

/** A historically denormalized label cannot override a currently resolvable
 * explicit source venue. Unknown claims retain the existing source policy;
 * only a catalog-proven physical identity contradiction adds a new hold.
 */
export async function automaticUniqueVenueEvidenceMatchesCandidate(
  ctx: QueryCtx | MutationCtx, event: Doc<"events">, fields: Record<string, unknown>,
): Promise<boolean> {
  let raw: Record<string, unknown> | null;
  try { raw = object(JSON.parse(event.rawExtractionJson ?? "null")); }
  catch { return false; }
  if (!raw) return false;
  const claims = automaticUniqueSourceVenueClaims(fields, raw);
  if (claims.length === 0) return true;
  const resolutions = await resolveVenueClaimsForWrite(ctx, claims);
  return claims.every((claim) => {
    const resolved = resolutions.get(claim);
    if (resolved?.excludedVenueClaim === true) return false;
    return resolved?.resolution.status !== "resolved" || resolved.venueFields.venueId === event.venueId;
  });
}
