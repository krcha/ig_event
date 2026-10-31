// Shared by Next.js and Convex so both enforce the same single-owner policy.
export function getAnalyticsOwnerId(env: Record<string, string | undefined>): string | null {
  const admins = [...new Set((env.ADMIN_CLERK_USER_IDS ?? "").split(/[\s,]+/).filter(Boolean))];
  const configured = env.ANALYTICS_OWNER_CLERK_USER_ID?.trim();
  const owner = configured || (admins.length === 1 ? admins[0] : null);
  return owner && admins.includes(owner) ? owner : null;
}

export function isAnalyticsOwner(subject: string | null | undefined, env: Record<string, string | undefined>): boolean {
  const owner = getAnalyticsOwnerId(env);
  return Boolean(owner && subject && subject === owner);
}
