// Compatibility-only facade. Reviewed historical correction logic is isolated from steady-state event commands.
export type {
  ReviewedStructuredCorrectionVersionArgs,
  ReviewedStructuredReceipt,
} from "../internal/eventRepairs/reviewedStructuredCorrections";
export {
  getReviewedStructuredEvidenceCorrectionContextHandler,
  loadReviewedStructuredCorrectionContext,
  repairReviewedStructuredEventEvidenceHandler,
  repairReviewedStructuredEventVenueHandler,
} from "../internal/eventRepairs/reviewedStructuredCorrections";
