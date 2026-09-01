// Compatibility-only facade. Historical replay implementation lives under internal/eventRepairs.
export {
  assertEventEvidencePolicyDateEvidenceTransitionForTesting,
  assertEventEvidencePolicyTitleTransitionForTesting,
  reprocessPendingEventEvidencePolicyBatchHandler,
  rollbackEventEvidencePolicyBatchHandler,
} from "../internal/eventRepairs/evidencePolicy";
