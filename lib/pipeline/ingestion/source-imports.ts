import { loadOperationalVenueRecords } from "@/lib/pipeline/operational-venues";
import { buildCanonicalVenueAliasesByHandle, buildCanonicalVenueNamesByHandle, normalizeHandle } from "@/lib/pipeline/venue-normalization";
import { type InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";
import type { EventImportRecord, ExistingEventImportSummary, RecentApifyImportSummary } from "@/lib/pipeline/ingestion/contracts";
import { listByStatusQuery } from "@/lib/pipeline/ingestion/convex-bindings";
import { getConfiguredEventTimezone, getIsoDateInTimeZone } from "@/lib/pipeline/ingestion/parsing-date";
import { getConfiguredServiceSecret, getConvexClient } from "@/lib/pipeline/ingestion/runtime";
import { buildVenueHandleByCanonicalVenueName, getSourceIdentityKey, mapImportedEventToSavedScrapedPost, persistScrapedPostsForHandle, resolveImportedEventHandle, scoreSavedScrapedPostCandidate } from "@/lib/pipeline/ingestion/source-documents";
import { normalizeString } from "@/lib/pipeline/ingestion/values";
import { loadAllActiveInstagramSourceHandles } from "@/lib/pipeline/ingestion/venue-context";
import { instagramSourceProviderAdapter } from "@/lib/pipeline/ingestion/source-provider";

const EXISTING_EVENT_IMPORT_LIMIT_PER_STATUS = 1000;


export async function getActiveVenueHandles(options?: {
  serviceSecret?: string;
}): Promise<string[]> {
  const client = getConvexClient();
  const serviceSecret = getConfiguredServiceSecret(options?.serviceSecret);
  return loadAllActiveInstagramSourceHandles(client, serviceSecret);
}

export async function importRecentApifyRunPostsToSavedPosts(options: {
  handles: string[];
  runsLimit?: number;
  serviceSecret?: string;
}): Promise<RecentApifyImportSummary> {
  const normalizedHandles = [...new Set(options.handles.map((handle) => normalizeHandle(handle)).filter(Boolean))];
  if (normalizedHandles.length === 0) {
    return {
      handles: [],
      runsScanned: 0,
      importedPosts: 0,
      handlesWithImportedPosts: 0,
    };
  }

  const client = getConvexClient();
  const serviceSecret = getConfiguredServiceSecret(options.serviceSecret);
  const importResult = await instagramSourceProviderAdapter.loadRecentDocuments({
    handles: normalizedHandles,
    runsLimit: options.runsLimit,
  });

  let handlesWithImportedPosts = 0;
  for (const handle of normalizedHandles) {
    const posts = (importResult.documentsByHandle[handle] ?? []).map((sourceDocument) =>
      instagramSourceProviderAdapter.projectForCompatibilityParser(sourceDocument),
    );
    if (posts.length === 0) {
      continue;
    }

    handlesWithImportedPosts += 1;
    await persistScrapedPostsForHandle(client, handle, posts, serviceSecret);
  }

  return {
    handles: normalizedHandles,
    runsScanned: importResult.runsScanned,
    importedPosts: importResult.importedPosts,
    handlesWithImportedPosts,
  };
}

export async function importUpcomingEventsToSavedPosts(options?: {
  serviceSecret?: string;
}): Promise<ExistingEventImportSummary> {
  const client = getConvexClient();
  const serviceSecret = getConfiguredServiceSecret(options?.serviceSecret);
  const venues = await loadOperationalVenueRecords({
    client,
    serviceSecret,
    activeOnly: false,
  });
  const canonicalVenueNamesByHandle = buildCanonicalVenueNamesByHandle(venues);
  const canonicalVenueAliasesByHandle = buildCanonicalVenueAliasesByHandle(venues);
  const handlesByVenueName = buildVenueHandleByCanonicalVenueName(
    canonicalVenueNamesByHandle,
  );
  const todayIsoDate = getIsoDateInTimeZone(getConfiguredEventTimezone());

  const [approvedEvents, pendingEvents] = await Promise.all([
    client.query(listByStatusQuery, {
      status: "approved",
      limit: EXISTING_EVENT_IMPORT_LIMIT_PER_STATUS,
      serviceSecret,
    }) as Promise<EventImportRecord[]>,
    client.query(listByStatusQuery, {
      status: "pending",
      limit: EXISTING_EVENT_IMPORT_LIMIT_PER_STATUS,
      serviceSecret,
    }) as Promise<EventImportRecord[]>,
  ]);

  const postsByHandle = new Map<string, Map<string, InstagramScrapedPost>>();
  let skippedPastEvents = 0;
  let skippedMissingVenue = 0;
  let skippedMissingSource = 0;

  for (const event of [...approvedEvents, ...pendingEvents]) {
    if (normalizeString(event.date) < todayIsoDate) {
      skippedPastEvents += 1;
      continue;
    }

    const venue = normalizeString(event.venue);
    if (!venue) {
      skippedMissingVenue += 1;
      continue;
    }

    const matchedHandle = resolveImportedEventHandle(
      venue,
      event._id,
      canonicalVenueNamesByHandle,
      canonicalVenueAliasesByHandle,
      handlesByVenueName,
    );
    const post = mapImportedEventToSavedScrapedPost(event, matchedHandle);
    if (!post) {
      skippedMissingSource += 1;
      continue;
    }

    const sourceIdentityKey = getSourceIdentityKey(post);
    if (!sourceIdentityKey) {
      skippedMissingSource += 1;
      continue;
    }

    const postsForHandle = postsByHandle.get(matchedHandle) ?? new Map<string, InstagramScrapedPost>();
    const existingPost = postsForHandle.get(sourceIdentityKey);
    if (
      !existingPost ||
      scoreSavedScrapedPostCandidate(post) > scoreSavedScrapedPostCandidate(existingPost)
    ) {
      postsForHandle.set(sourceIdentityKey, post);
    }
    postsByHandle.set(matchedHandle, postsForHandle);
  }

  let importedPosts = 0;
  const importedHandles: string[] = [];

  for (const [handle, postsForHandle] of postsByHandle.entries()) {
    const posts = [...postsForHandle.values()];
    if (posts.length === 0) {
      continue;
    }

    await persistScrapedPostsForHandle(client, handle, posts, serviceSecret);
    importedHandles.push(handle);
    importedPosts += posts.length;
  }

  return {
    handles: importedHandles,
    importedPosts,
    handlesWithImportedPosts: importedHandles.length,
    scannedEvents: approvedEvents.length + pendingEvents.length,
    skippedPastEvents,
    skippedMissingVenue,
    skippedMissingSource,
  };
}
