const CONVEX_PUBLIC_ID_PATTERN = /^[a-z0-9]{32}$/;

export function isPlausibleConvexPublicId(value: string): boolean {
  return CONVEX_PUBLIC_ID_PATTERN.test(value);
}
