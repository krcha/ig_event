import "server-only";

/** Optional private transport for the same public Convex APIs on a self-hosted VPS. */
export function getCalendarConvexUrl(): string | undefined {
  return process.env.CONVEX_PUBLIC_READ_URL?.trim() || process.env.NEXT_PUBLIC_CONVEX_URL;
}
