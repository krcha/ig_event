export const MODERATION_QUEUE_FETCH_LIMIT = 200;
export const DEFAULT_MODERATION_VISIBLE_LIMIT = 50;

export function selectVisibleModerationEvents<T>(
  events: readonly T[],
  requestedLimit: string | number,
): T[] {
  const parsedLimit =
    typeof requestedLimit === "number" ? requestedLimit : Number(requestedLimit);
  const safeVisibleLimit = Number.isSafeInteger(parsedLimit)
    ? Math.max(1, Math.min(MODERATION_QUEUE_FETCH_LIMIT, parsedLimit))
    : DEFAULT_MODERATION_VISIBLE_LIMIT;

  return events.slice(0, safeVisibleLimit);
}
