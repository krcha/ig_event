import { v, type Infer } from "convex/values";
import { mutation } from "./_generated/server";
import { requireAdminOrServiceSecret } from "./authz";

const source = v.union(v.literal("osm"), v.literal("google"), v.literal("manual"), v.literal("none"));
const nullableString = v.union(v.string(), v.null());
const nullableNumber = v.union(v.number(), v.null());
const expectedSnapshot = v.object({
  name: v.string(),
  instagramHandle: v.string(),
  category: v.string(),
  location: nullableString,
  latitude: nullableNumber,
  longitude: nullableNumber,
  updatedAt: v.number(),
  hoursSource: v.union(source, v.null()),
  hoursJson: nullableString,
  hoursFetchedAt: nullableNumber,
  hoursExpiresAt: nullableNumber,
  hoursTimezone: nullableString,
  osmElementId: nullableString,
  osmElementType: nullableString,
  googlePlaceId: nullableString,
  hoursError: nullableString,
});
const reviewedPatch = v.object({
  hoursSource: v.union(v.literal("google"), v.literal("manual")),
  hoursJson: v.string(),
  hoursFetchedAt: v.number(),
  hoursExpiresAt: v.number(),
  hoursTimezone: v.literal("Europe/Belgrade"),
});
const evidence = v.object({
  provider: v.union(v.literal("google_maps"), v.literal("facebook")),
  sourceUrls: v.array(v.string()),
  observedAt: v.number(),
});
const identityFields = ["name", "instagramHandle", "category", "location", "latitude", "longitude", "updatedAt"] as const;
const hoursFields = ["hoursSource", "hoursJson", "hoursFetchedAt", "hoursExpiresAt", "hoursTimezone", "osmElementId", "osmElementType", "googlePlaceId", "hoursError"] as const;
const MAX_JSON_LENGTH = 32_768;
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validWindow(value: unknown, day: number): boolean {
  if (!record(value) || value.day !== day || typeof value.start !== "string" || typeof value.end !== "string" ||
      !TIME.test(value.start) || !TIME.test(value.end) ||
      (value.spansNextDay !== undefined && typeof value.spansNextDay !== "boolean")) return false;
  return (value.end <= value.start) === (value.spansNextDay === true);
}

function validWeekly(value: unknown): value is Array<{ day: number; closed: boolean; windows: unknown[] }> {
  if (!Array.isArray(value) || value.length > 7) return false;
  const seen = new Set<number>();
  return value.every((day) => {
    if (!record(day) || !Number.isInteger(day.day) || (day.day as number) < 0 || (day.day as number) > 6 ||
        seen.has(day.day as number) || typeof day.closed !== "boolean" || !Array.isArray(day.windows) ||
        day.windows.length > 8 || (day.closed && day.windows.length > 0) ||
        !day.windows.every((window) => validWindow(window, day.day as number))) return false;
    seen.add(day.day as number);
    return true;
  });
}

function storedHoursStatus(value: string | undefined): "missing" | "existing" | "protected" {
  if (!value?.trim()) return "missing";
  try {
    const parsed: unknown = JSON.parse(value);
    if (!record(parsed) || parsed.version !== 1 ||
        !["osm", "google", "manual", "none"].includes(String(parsed.source)) ||
        !validWeekly(parsed.weekly)) return "protected";
    // Closed days, partial schedules, expired data, and inconsistent none +
    // populated schedules are all existing information that must survive.
    return parsed.weekly.some((day) => day.closed || day.windows.length > 0) ? "existing" : "missing";
  } catch {
    return "protected";
  }
}

function validSourceUrl(value: string, provider: "google_maps" | "facebook"): boolean {
  if (!value || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (provider === "facebook") return host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.com";
    return host === "maps.app.goo.gl" ||
      (/^(?:maps\.)?google\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(host) &&
        (host.startsWith("maps.") || url.pathname.startsWith("/maps")));
  } catch {
    return false;
  }
}

function validatedPatch(patch: Infer<typeof reviewedPatch>, proof: Infer<typeof evidence>, now: number) {
  if (patch.hoursJson.length > MAX_JSON_LENGTH || !Number.isSafeInteger(patch.hoursFetchedAt) ||
      !Number.isSafeInteger(patch.hoursExpiresAt) || !Number.isSafeInteger(proof.observedAt) ||
      proof.observedAt < 0 || proof.observedAt > patch.hoursFetchedAt ||
      patch.hoursFetchedAt > now + 5 * 60 * 1_000 || patch.hoursFetchedAt < now - WEEK_MS ||
      patch.hoursExpiresAt <= patch.hoursFetchedAt || patch.hoursExpiresAt > patch.hoursFetchedAt + WEEK_MS ||
      patch.hoursExpiresAt <= now || !proof.sourceUrls.length || proof.sourceUrls.length > 5 ||
      !proof.sourceUrls.every((url) => validSourceUrl(url, proof.provider)) ||
      (patch.hoursSource === "google" && proof.provider !== "google_maps")) {
    throw new Error("Reviewed venue hours have invalid timestamps, source, evidence URLs, or size.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(patch.hoursJson); } catch { throw new Error("Reviewed venue hours must be valid JSON."); }
  if (!record(parsed) || parsed.version !== 1 || parsed.source !== patch.hoursSource ||
      parsed.timezone !== patch.hoursTimezone || parsed.generatedAt !== new Date(patch.hoursFetchedAt).toISOString() ||
      !validWeekly(parsed.weekly) || !parsed.weekly.some((day) => day.windows.length > 0) ||
      (parsed.raw !== undefined && !record(parsed.raw))) {
    throw new Error("Reviewed venue hours have an invalid weekly schedule or mismatched metadata.");
  }
  const hoursJson = JSON.stringify({
    ...parsed,
    raw: {
      ...(record(parsed.raw) ? parsed.raw : {}),
      provider: proof.provider,
      observedAt: new Date(proof.observedAt).toISOString(),
      sourceUrls: [...new Set(proof.sourceUrls)],
    },
  });
  if (hoursJson.length > MAX_JSON_LENGTH) throw new Error("Reviewed venue hours and provenance exceed the size bound.");
  return { ...patch, hoursJson, hoursError: "" };
}

/** Add reviewed hours only if this exact venue still has no stored schedule. */
export const applyReviewedMissingHours = mutation({
  args: {
    id: v.id("venues"),
    expected: expectedSnapshot,
    patch: reviewedPatch,
    evidence,
    serviceSecret: v.optional(v.string()),
  },
  returns: v.object({
    id: v.id("venues"),
    status: v.union(v.literal("applied"), v.literal("skipped")),
    reason: v.union(v.literal("applied"), v.literal("not_found"), v.literal("identity_changed"),
      v.literal("hours_changed"), v.literal("existing_hours"), v.literal("protected_hours"), v.literal("not_physical")),
  }),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const patch = validatedPatch(args.patch, args.evidence, Date.now());
    if (args.expected.hoursJson !== null && args.expected.hoursJson.length > 131_072) {
      throw new Error("Expected venue hours exceed the snapshot size bound.");
    }
    const current = await ctx.db.get(args.id);
    const skip = (reason: "not_found" | "identity_changed" | "hours_changed" | "existing_hours" | "protected_hours" | "not_physical") =>
      ({ id: args.id, status: "skipped" as const, reason });
    if (!current) return skip("not_found");
    if (identityFields.some((field) => (current[field] ?? null) !== args.expected[field])) return skip("identity_changed");
    if (hoursFields.some((field) => (current[field] ?? null) !== args.expected[field])) return skip("hours_changed");
    if (current.category === "promoter") return skip("not_physical");
    const status = storedHoursStatus(current.hoursJson);
    if (status === "existing") return skip("existing_hours");
    if (status === "protected") return skip("protected_hours");
    // The read, full expected comparison, missing-only check, and patch share
    // one transaction. OCC retries recheck data changed by another hours writer.
    // Provider IDs, general venue fields, and updatedAt are deliberately omitted.
    await ctx.db.patch(args.id, patch);
    return { id: args.id, status: "applied" as const, reason: "applied" as const };
  },
});
