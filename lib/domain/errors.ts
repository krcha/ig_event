export type DomainErrorCode =
  | "EVENT_DUPLICATE"
  | "EVENT_AMBIGUOUS"
  | "VENUE_UNKNOWN"
  | "VENUE_AMBIGUOUS"
  | "SOURCE_URL_INVALID"
  | "SOURCE_NOT_GROUNDED"
  | "SOURCE_REVISION_CHANGED"
  | "STALE_EVENT_VERSION"
  | "OCCURRENCE_INCOMPLETE"
  | "MODERATION_BATCH_INVALID"
  | "MODERATION_INCOMPLETE"
  | "MODERATION_INELIGIBLE"
  | "MODERATION_INVALID_REQUEST"
  | "MODERATION_INVALID_TRANSITION"
  | "RECONCILIATION_CONFLICT"
  | "RECONCILIATION_PLAN_INVALID"
  | "PROCESSING_FENCE_INVALID";

export type DomainErrorDetails = Readonly<Record<string, unknown>>;

/**
 * Stable machine-readable domain failure. UI/API layers may translate the
 * message, but branching must use `code` rather than parsing human text.
 */
export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: DomainErrorDetails;

  constructor(
    code: DomainErrorCode,
    message: string,
    options?: {
      cause?: unknown;
      details?: DomainErrorDetails;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DomainError";
    this.code = code;
    this.details = options?.details;
  }
}

export type DomainResult<T, E extends DomainError = DomainError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function domainSuccess<T>(value: T): DomainResult<T, never> {
  return { ok: true, value };
}

export function domainFailure<E extends DomainError>(error: E): DomainResult<never, E> {
  return { ok: false, error };
}

export function isDomainError(
  value: unknown,
  code?: DomainErrorCode,
): value is DomainError {
  return (
    value instanceof DomainError &&
    (code === undefined || value.code === code)
  );
}
