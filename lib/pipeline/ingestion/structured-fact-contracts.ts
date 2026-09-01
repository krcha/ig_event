import type { StructuredFacts } from "@/lib/domain/occurrences/types";
import type {
  EventDateEvidenceSource,
  EventTimeEvidenceKind,
  PrepareEventResult,
} from "@/lib/pipeline/ingestion/contracts";
import type { EventTimeProvenance } from "@/lib/events/event-time";

export type StructuredFactSkipReason = Extract<
  PrepareEventResult,
  { kind: "skip" }
>["reason"];

export type StructuredFactEventEvidence = {
  dateEvidenceIsRelative?: boolean;
  dateEvidenceResolvedDate?: string;
  dateEvidenceSource?: EventDateEvidenceSource;
  dateEvidenceText?: string;
  sourceConflictFields: readonly string[];
  timeConfidence: number;
  timeEvidenceKind?: EventTimeEvidenceKind;
  timeEvidenceText?: string;
  timeSource: EventTimeProvenance["source"];
  timeStatus: EventTimeProvenance["status"];
};

export type StructuredFactPresentation = {
  description?: string;
  imageUrl?: string;
  ticketPrice?: string;
};

export type StructuredFactSourceReference = {
  caption?: string;
  instagramPostId: string;
  instagramPostUrl: string;
  postedAt?: string;
  rawExtractionJson: string;
};

export type StructuredFactEventResult = {
  evidence: StructuredFactEventEvidence;
  facts: StructuredFacts;
  kind: "event";
  normalizedFields: Record<string, unknown>;
  presentation: StructuredFactPresentation;
  source: StructuredFactSourceReference;
};

export type StructuredFactSkipResult = {
  kind: "skip";
  normalizedFields: Record<string, unknown>;
  reason: StructuredFactSkipReason;
};

/**
 * Runtime result of provider extraction and normalization. Persistable events
 * cannot exist here without first crossing the typed `StructuredFacts` boundary.
 */
export type StructuredFactExtractionResult =
  | StructuredFactEventResult
  | StructuredFactSkipResult;
