export type InstagramFollowerObservation = {
  handle: string;
  count: number;
  observedAt: number;
};

export function normalizeInstagramProfileHandle(value: unknown): string {
  if (typeof value !== "string") return "";
  const handle = value.trim().replace(/^@/, "").toLowerCase();
  return /^(?!\.)(?!.*\.\.)(?!.*\.$)[a-z0-9._]{1,30}$/u.test(handle) ? handle : "";
}

function readProfileUrlHandle(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["instagram.com", "www.instagram.com"].includes(url.hostname) ||
        url.port || url.username || url.password) return "";
    const path = /^\/([a-z0-9._]{1,30})\/?$/iu.exec(url.pathname);
    return normalizeInstagramProfileHandle(path?.[1]);
  } catch {
    return "";
  }
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function readApifyInstagramFollowerObservation(
  value: unknown,
  observedAt: number,
): InstagramFollowerObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Number.isSafeInteger(observedAt) || observedAt <= 0) return null;
  const row = value as Record<string, unknown>;
  const owner = row.owner && typeof row.owner === "object" ? row.owner as Record<string, unknown> : undefined;
  const ownerFields = [row.ownerUsername, row.owner_username, owner?.username];
  const ownerHandle = ownerFields.map(normalizeInstagramProfileHandle).find(Boolean);
  const profileHandle = normalizeInstagramProfileHandle(row.username);
  if (ownerHandle) {
    if (row.error != null || [...ownerFields, row.username].some((candidate) => candidate != null && candidate !== "" &&
        normalizeInstagramProfileHandle(candidate) !== ownerHandle)) return null;
    const topLevelCount = row.followersCount;
    const ownerCount = owner?.followersCount;
    if (isCount(topLevelCount) && isCount(ownerCount) && topLevelCount !== ownerCount) return null;
    const count = topLevelCount ?? ownerCount;
    return isCount(count) ? { handle: ownerHandle, count, observedAt } : null;
  }

  // A successful post-run dataset can include account metadata alongside a
  // no-post outcome. Only a row anchored to its actual Instagram profile URL
  // can supply a count when an explicit post owner is absent.
  if (!profileHandle || !isCount(row.followersCount) || row.shortCode != null || row.shortcode != null) return null;
  const matchingProfileUrl = readProfileUrlHandle(row.url) === profileHandle;
  const matchingInputUrl = readProfileUrlHandle(row.inputUrl) === profileHandle;
  if ((row.url != null && !matchingProfileUrl) || (row.inputUrl != null && !matchingInputUrl)) return null;
  if (!matchingProfileUrl && !(matchingInputUrl && [row.followsCount, row.postsCount].some(isCount))) return null;
  return { handle: profileHandle, count: row.followersCount, observedAt };
}
