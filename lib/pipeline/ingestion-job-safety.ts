import type {
  IngestionBatchState,
  IngestionSummary,
} from "@/lib/pipeline/run-instagram-ingestion";

// Keep persisted job payloads small enough for self-hosted Convex mutation runtime limits.
// A 500-handle empty summary is already ~312 KiB and has timed out during createJob;
// 200 handles keeps the same payload near 125 KiB while the host runner spans the full cap.
export const MAX_INGESTION_JOB_HANDLES = 200;
export const MAX_INGESTION_JOB_PERSISTED_JSON_BYTES = 600_000;
export const MAX_PERSISTED_INGESTION_ERROR_LENGTH = 256;
export const MAX_PERSISTED_ERRORS_PER_HANDLE = 1;
const MAX_INGESTION_HANDLE_UTF8_BYTES = 128;
const MAX_PERSISTED_CLEANUP_FAILURES = 20;
const MAX_PERSISTED_DUPLICATE_IDS_PER_FAILURE = 20;
const MAX_PERSISTED_SOURCE_KEYS_PER_HANDLE = 4;
const MAX_PERSISTED_SOURCE_KEY_LENGTH = 128;

function truncate(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maximumLength - 1))}…`;
}

export function truncateIngestionError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? "Unknown ingestion error.");
  return truncate(message, MAX_PERSISTED_INGESTION_ERROR_LENGTH);
}

export function compactIngestionSummaryForPersistence(
  summary: IngestionSummary,
): IngestionSummary {
  return {
    ...summary,
    handles: summary.handles.map((handle) => ({
      ...handle,
      errors: handle.errors
        .slice(0, MAX_PERSISTED_ERRORS_PER_HANDLE)
        .map(truncateIngestionError),
    })),
    ...(summary.approvedDuplicateCleanup
      ? {
          approvedDuplicateCleanup: {
            ...summary.approvedDuplicateCleanup,
            failures: summary.approvedDuplicateCleanup.failures
              .slice(0, MAX_PERSISTED_CLEANUP_FAILURES)
              .map((failure) => ({
                ...failure,
                duplicateEventIds: failure.duplicateEventIds.slice(
                  0,
                  MAX_PERSISTED_DUPLICATE_IDS_PER_FAILURE,
                ),
                error: truncateIngestionError(failure.error),
              })),
            ...(summary.approvedDuplicateCleanup.error
              ? { error: truncateIngestionError(summary.approvedDuplicateCleanup.error) }
              : {}),
          },
        }
      : {}),
  };
}

export function compactIngestionStateForPersistence(
  state: IngestionBatchState,
): IngestionBatchState {
  return {
    ...state,
    currentHandlePosts: [],
    currentScrapedPostIds: (state.currentScrapedPostIds ?? []).map((id) =>
      truncate(id, MAX_PERSISTED_SOURCE_KEY_LENGTH),
    ),
    seenSourceKeysByHandle: Object.fromEntries(
      Object.entries(state.seenSourceKeysByHandle).map(([handle, sourceKeys]) => [
        handle,
        sourceKeys
          .slice(-MAX_PERSISTED_SOURCE_KEYS_PER_HANDLE)
          .map((sourceKey) => truncate(sourceKey, MAX_PERSISTED_SOURCE_KEY_LENGTH)),
      ]),
    ),
  };
}

export function getUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertIngestionJobPayloadWithinBounds(options: {
  handles: string[];
  summaryJson: string;
  stateJson: string;
}): void {
  if (options.handles.length > MAX_INGESTION_JOB_HANDLES) {
    throw new Error(
      `Ingestion jobs are limited to ${MAX_INGESTION_JOB_HANDLES} handles; received ${options.handles.length}.`,
    );
  }
  if (
    options.handles.some(
      (handle) =>
        !handle || getUtf8ByteLength(handle) > MAX_INGESTION_HANDLE_UTF8_BYTES,
    )
  ) {
    throw new Error(
      `Ingestion job handles must be non-empty and at most ${MAX_INGESTION_HANDLE_UTF8_BYTES} UTF-8 bytes.`,
    );
  }
  const persistedJsonBytes =
    getUtf8ByteLength(options.summaryJson) + getUtf8ByteLength(options.stateJson);
  if (persistedJsonBytes > MAX_INGESTION_JOB_PERSISTED_JSON_BYTES) {
    throw new Error(
      `Ingestion job persisted JSON exceeds ${MAX_INGESTION_JOB_PERSISTED_JSON_BYTES} bytes.`,
    );
  }
}

export function serializeSafeIngestionJobPayload(options: {
  handles: string[];
  summary: IngestionSummary;
  state: IngestionBatchState;
}): {
  summary: IngestionSummary;
  state: IngestionBatchState;
  summaryJson: string;
  stateJson: string;
} {
  let summary = compactIngestionSummaryForPersistence(options.summary);
  let state = compactIngestionStateForPersistence(options.state);
  let summaryJson = JSON.stringify(summary);
  let stateJson = JSON.stringify(state);

  if (
    getUtf8ByteLength(summaryJson) + getUtf8ByteLength(stateJson) >
    MAX_INGESTION_JOB_PERSISTED_JSON_BYTES
  ) {
    summary = {
      ...summary,
      handles: summary.handles.map((handle) => ({ ...handle, errors: [] })),
      ...(summary.approvedDuplicateCleanup
        ? {
            approvedDuplicateCleanup: {
              ...summary.approvedDuplicateCleanup,
              failures: [],
              error: summary.approvedDuplicateCleanup.error
                ? truncateIngestionError(summary.approvedDuplicateCleanup.error)
                : undefined,
            },
          }
        : {}),
    };
    state = { ...state, seenSourceKeysByHandle: {} };
    summaryJson = JSON.stringify(summary);
    stateJson = JSON.stringify(state);
  }

  assertIngestionJobPayloadWithinBounds({
    handles: options.handles,
    summaryJson,
    stateJson,
  });
  return { summary, state, summaryJson, stateJson };
}
