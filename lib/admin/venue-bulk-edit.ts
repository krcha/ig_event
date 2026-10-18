import { CANONICAL_VENUE_CATEGORIES } from "@/lib/taxonomy/venue-types";

export type VenueBulkPatch = {
  category?: string;
  publicStatus?: "pending" | "published" | "hidden";
  scrapeActive?: boolean;
};

export type VenueBulkTarget = {
  id: string;
  name: string;
  category: string;
  publicStatus: "pending" | "published" | "hidden";
  scrapeActive: boolean;
};

export type VenueBulkResult = {
  total: number;
  updatedIds: string[];
  unchangedIds: string[];
  failures: Array<{ id: string; name: string; error: string; unconfirmed: boolean }>;
  unattempted: Array<{ id: string; name: string; reason: string }>;
};

export type VenueBulkProgress = {
  completed: number;
  total: number;
  updated: number;
  unchanged: number;
  failed: number;
};

class VenueBulkRequestError extends Error {
  status: number | undefined;
  unconfirmed: boolean;

  constructor(message: string, status?: number, unconfirmed = false) {
    super(message);
    this.name = "VenueBulkRequestError";
    this.status = status;
    this.unconfirmed = unconfirmed;
  }
}

export function validateVenueBulkPatch(patch: VenueBulkPatch): VenueBulkPatch {
  const keys = Object.keys(patch);
  if (!keys.length || keys.some((key) => !["category", "publicStatus", "scrapeActive"].includes(key))) {
    throw new Error("Choose at least one supported field to change.");
  }
  if ("category" in patch && !CANONICAL_VENUE_CATEGORIES.some((category) => category === patch.category)) {
    throw new Error("Choose a valid venue type.");
  }
  if ("publicStatus" in patch && !["pending", "published", "hidden"].includes(patch.publicStatus ?? "")) {
    throw new Error("Choose a valid publication status.");
  }
  if ("scrapeActive" in patch && typeof patch.scrapeActive !== "boolean") {
    throw new Error("Choose whether scraping is enabled or paused.");
  }
  return { ...patch };
}

export async function patchVenueForBulkEdit(
  id: string,
  patch: VenueBulkPatch,
  request: typeof fetch = fetch,
): Promise<void> {
  const validatedPatch = validateVenueBulkPatch(patch);
  let response: Response;
  try {
    response = await request("/api/admin/venues", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      redirect: "error",
      body: JSON.stringify({ id, patch: validatedPatch }),
    });
  } catch {
    throw new VenueBulkRequestError("The save could not be confirmed. Refresh venues before retrying.", undefined, true);
  }

  let payload: { ok?: unknown; error?: unknown } | null = null;
  try {
    const value: unknown = await response.json();
    if (value && typeof value === "object" && !Array.isArray(value)) {
      payload = value as { ok?: unknown; error?: unknown };
    }
  } catch {
    // A login page or lost/invalid response is not proof that a write succeeded.
  }
  if (!response.ok) {
    const fallback = response.status === 401 || response.status === 403
      ? "Admin access expired. Sign in again before retrying."
      : response.status === 429
        ? "Too many requests. Wait before retrying."
        : "Venue update failed.";
    const message = typeof payload?.error === "string" ? payload.error : fallback;
    // These existing guards reject the single metadata mutation before any write.
    // Other 5xx responses can also mean that a proxy lost a committed write's reply.
    const knownRejection = [
      "Referenced venue identity/public fields require a bounded venue-rebind migration; no venue was changed.",
      "Venue publication cannot be reduced until event-venue-bindings-v1 proves complete zero-exception coverage.",
    ].some((reason) => message.includes(reason));
    const admissionRejected = [401, 403, 429].includes(response.status);
    const unconfirmed = !admissionRejected && !knownRejection && (response.status >= 500 || typeof payload?.error !== "string");
    throw new VenueBulkRequestError(message, response.status, unconfirmed);
  }
  if (payload?.ok !== true) {
    throw new VenueBulkRequestError("The save could not be confirmed. Refresh venues before retrying.", response.status, true);
  }
}

/** Each venue is one existing atomic metadata mutation; a batch can partially succeed. */
export async function executeVenueBulkEdit(
  targets: readonly VenueBulkTarget[],
  requestedPatch: VenueBulkPatch,
  options: {
    onProgress?: (progress: VenueBulkProgress) => void;
    update?: (id: string, patch: VenueBulkPatch) => Promise<void>;
  } = {},
): Promise<VenueBulkResult> {
  const patch = validateVenueBulkPatch(requestedPatch);
  if (targets.some((target) => typeof target.id !== "string" || !target.id.trim())) {
    throw new Error("A selected venue is missing its ID. Refresh venues before retrying.");
  }
  const seen = new Set<string>();
  const snapshot = targets.filter((target) => {
    if (seen.has(target.id)) return false;
    seen.add(target.id);
    return true;
  }).map((target) => ({ ...target }));
  if (!snapshot.length) throw new Error("Select at least one venue.");
  const result: VenueBulkResult = { total: snapshot.length, updatedIds: [], unchangedIds: [], failures: [], unattempted: [] };
  const update = options.update ?? patchVenueForBulkEdit;
  function progress() {
    options.onProgress?.({
      completed: result.updatedIds.length + result.unchangedIds.length + result.failures.length,
      total: result.total,
      updated: result.updatedIds.length,
      unchanged: result.unchangedIds.length,
      failed: result.failures.length,
    });
  }
  progress();
  let stopReason: string | null = null;
  for (const target of snapshot) {
    if (stopReason) {
      result.unattempted.push({ id: target.id, name: target.name, reason: stopReason });
      continue;
    }
    const changed: VenueBulkPatch = {};
    if (patch.category !== undefined && patch.category !== target.category) changed.category = patch.category;
    if (patch.publicStatus !== undefined && patch.publicStatus !== target.publicStatus) changed.publicStatus = patch.publicStatus;
    if (patch.scrapeActive !== undefined && patch.scrapeActive !== target.scrapeActive) changed.scrapeActive = patch.scrapeActive;
    if (!Object.keys(changed).length) {
      result.unchangedIds.push(target.id);
      progress();
      continue;
    }
    try {
      await update(target.id, changed);
      result.updatedIds.push(target.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Venue update failed.";
      const unconfirmed = error instanceof VenueBulkRequestError ? error.unconfirmed : true;
      result.failures.push({ id: target.id, name: target.name, error: message, unconfirmed });
      if (unconfirmed || (error instanceof VenueBulkRequestError && [401, 403, 429].includes(error.status ?? 0))) {
        stopReason = message;
      }
    }
    progress();
  }
  return result;
}
