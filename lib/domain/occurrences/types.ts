import type { SourceProvider } from "../source-url";

export type EvidenceSource =
  | "caption"
  | "poster"
  | "alt_text"
  | "location_tag"
  | "source_account"
  | "model"
  | "unknown";

export type EvidenceReference = {
  exactText?: string;
  field: string;
  source: EvidenceSource;
};

export type StructuredFacts = {
  artistClaims: readonly string[];
  dateRange?: { from: string; through: string };
  eventTypeClaim?: string;
  evidence: readonly EvidenceReference[];
  localDate: string;
  recurrenceRule?: string;
  relativeDayOffset?: number;
  scheduleGroupId?: string;
  scheduleRole?: "primary" | "continuation" | "row" | "shared_context";
  sharedTime?: boolean;
  sharedVenue?: boolean;
  sourceRowIdentity?: string;
  startTime?: string;
  timeRelation?: "exact" | "range" | "unknown";
  titleClaim: string;
  venueClaim?: string;
  venueHandleClaim?: string;
  policy: {
    approvalDisposition: "approved" | "pending";
    autoApproveRule?: string;
    pendingReasons: readonly string[];
    signals: readonly string[];
    structuredEvidenceVerified: boolean;
  };
};

export type VenueResolutionReference = {
  confidence: "proven" | "strong" | "ambiguous" | "unknown";
  evidence: readonly EvidenceReference[];
  normalizedIdentity?: string;
  venueId?: string;
  venueName?: string;
};

export type SourceOccurrence = {
  canonicalSourceUrl: string;
  facts: StructuredFacts;
  occurrenceOrdinal: number;
  provider: SourceProvider;
  sourceDocumentId: string;
  sourceFingerprint: string;
  sourceIdentity: string;
  sourceOccurrenceKey: string;
  sourceRevision: number;
};

export type NormalizedOccurrence = SourceOccurrence & {
  eventType: string;
  normalizedArtists: readonly string[];
  normalizedTitle: string;
  normalizedVenueIdentity?: string;
  normalizedVenueInstagramHandle?: string;
  venueResolution: VenueResolutionReference;
};
