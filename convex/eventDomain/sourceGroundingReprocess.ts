/**
 * Compatibility export for the historical source-grounding repair command.
 *
 * The implementation is intentionally isolated from the steady-state event
 * domain. Keep this facade only while reviewed operational callers still use
 * the legacy `events` API entrypoint.
 */
export { reprocessPendingSourceGroundingBatchHandler } from "../internal/eventRepairs/sourceGroundingReprocess";
