import type { PaginationOptions } from "convex/server";

type PaginationRequest = PaginationOptions & {
  endCursor?: string | null;
  id?: number;
  maximumBytesRead?: number;
  maximumRowsRead?: number;
};

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

/**
 * Query callers can safely ask for a smaller or larger page without changing
 * the response contract: pagination continues from the returned cursor. Keep
 * Convex's optional split/caching fields intact while capping the document
 * request admitted to one query execution.
 */
export function clampQueryPaginationOptions<T extends PaginationRequest>(
  options: T,
  maxItems: number,
): T {
  assertPositiveSafeInteger(maxItems, "Maximum query page size");
  const requested = Number.isFinite(options.numItems)
    ? Math.trunc(options.numItems)
    : 1;
  const requestedRowsRead = Number.isFinite(options.maximumRowsRead)
    ? Math.trunc(options.maximumRowsRead as number)
    : maxItems;
  return {
    ...options,
    maximumRowsRead: Math.max(1, Math.min(maxItems, requestedRowsRead)),
    numItems: Math.max(1, Math.min(maxItems, requested)),
  };
}

/**
 * Migration and mutation page sizes are part of an operator-reviewed write
 * plan. Silently clamping them can make a caller believe a larger batch was
 * applied, so reject invalid or oversized requests before any document read or
 * write occurs.
 */
export function assertOperationPaginationOptions<T extends PaginationRequest>(
  options: T,
  maxItems: number,
  label: string,
): T {
  assertPositiveSafeInteger(maxItems, "Maximum operation page size");
  if (
    !Number.isSafeInteger(options.numItems) ||
    options.numItems < 1 ||
    options.numItems > maxItems
  ) {
    throw new Error(`${label} must contain 1 to ${maxItems} rows.`);
  }
  if (
    options.maximumRowsRead !== undefined &&
    (!Number.isSafeInteger(options.maximumRowsRead) ||
      options.maximumRowsRead < 1 ||
      options.maximumRowsRead > maxItems)
  ) {
    throw new Error(`${label} row-read budget must be between 1 and ${maxItems}.`);
  }
  return {
    ...options,
    maximumRowsRead: options.maximumRowsRead ?? maxItems,
  };
}

export function resolveOperationLimit(
  value: number | undefined,
  options: {
    defaultValue: number;
    label: string;
    maxValue: number;
  },
): number {
  assertPositiveSafeInteger(options.defaultValue, `${options.label} default`);
  assertPositiveSafeInteger(options.maxValue, `${options.label} maximum`);
  if (options.defaultValue > options.maxValue) {
    throw new Error(`${options.label} default cannot exceed its maximum.`);
  }
  if (value === undefined) return options.defaultValue;
  if (!Number.isSafeInteger(value) || value < 1 || value > options.maxValue) {
    throw new Error(`${options.label} must be between 1 and ${options.maxValue}.`);
  }
  return value;
}

export function assertOperationBatchLength(
  length: number,
  options: {
    allowEmpty?: boolean;
    label: string;
    maxItems: number;
  },
): void {
  assertPositiveSafeInteger(options.maxItems, `${options.label} maximum`);
  const minimum = options.allowEmpty ? 0 : 1;
  if (!Number.isSafeInteger(length) || length < minimum || length > options.maxItems) {
    throw new Error(
      `${options.label} must contain ${minimum} to ${options.maxItems} rows.`,
    );
  }
}
