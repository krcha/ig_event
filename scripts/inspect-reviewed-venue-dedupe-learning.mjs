import { ConvexHttpClient } from "convex/browser";

const EVENT_IDS = [
  "j57c4hdz1an3hrzdg7n3jgr8c98azcdt",
  "j573aw97jpkxdcdnh181qm7s418d2896",
  "j57cqz2wjse5twxa52vckep5j18cygr6",
  "j57fe9ayv1kzh6pbcn78jsc8ed8d3cgx",
  "j5750ewadw545vyf167cxwr5398d8242",
  "j571q34jhe5tsrb7sv2mv5zcts8d2z6q",
  "j578yv7xjgnsdtqdjb5y9757zh8d393f",
  "j576gp53tt022xrcjah31wptzd8cx1fc",
];

const convexUrl = (
  process.env.NEXT_PUBLIC_CONVEX_URL ??
  process.env.CONVEX_SELF_HOSTED_URL ??
  ""
).trim();
const serviceSecret = (
  process.env.CRON_SECRET ??
  process.env.INGESTION_SERVICE_SECRET ??
  process.env.CONVEX_INGESTION_SERVICE_SECRET ??
  ""
).trim();
if (!convexUrl || !serviceSecret) {
  throw new Error("Production Convex configuration is unavailable.");
}

function parseObjectJson(value) {
  try {
    const parsed = JSON.parse(value ?? "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function normalizeHandle(value) {
  return String(value ?? "").trim().replace(/^@+/u, "").toLowerCase();
}

function eventProjection(event) {
  const fields = parseObjectJson(event.normalizedFieldsJson);
  return {
    id: event._id,
    status: event.status,
    updatedAt: event.updatedAt,
    title: event.title,
    date: event.date,
    time: event.time ?? null,
    venue: event.venue,
    venueId: event.venueId ?? null,
    venueInstagramHandle: event.venueInstagramHandle ?? null,
    artists: event.artists,
    description: event.description ?? null,
    sourceCaption: event.sourceCaption ?? null,
    instagramPostId: event.instagramPostId,
    instagramPostUrl: event.instagramPostUrl,
    sourceOccurrenceKey: event.sourceOccurrenceKey,
    sourceHandle: normalizeHandle(fields.sourceGroundingInstagramHandle),
    normalizedFields: {
      rawTitle: fields.rawTitle ?? null,
      rawVenue: fields.rawVenue ?? null,
      normalizedVenue: fields.normalizedVenue ?? null,
      venueSource: fields.venueSource ?? null,
      locationName: fields.locationName ?? null,
      titleUsedFallback: fields.titleUsedFallback ?? null,
      titleDerivedFromContext: fields.titleDerivedFromContext ?? null,
      multiEventSplitDetected: fields.multiEventSplitDetected ?? null,
      multiEventSplitCount: fields.multiEventSplitCount ?? null,
      splitEventIndex: fields.splitEventIndex ?? null,
      splitEventTotal: fields.splitEventTotal ?? null,
      splitSourceLine: fields.splitSourceLine ?? null,
      rowSourceText: fields.rowSourceText ?? null,
      rawExtractedTime: fields.rawExtractedTime ?? null,
      timeEvidenceText: fields.timeEvidenceText ?? null,
      timeEvidenceVerified: fields.timeEvidenceVerified ?? null,
      dateEvidenceVerified: fields.dateEvidenceVerified ?? null,
      identityEvidenceVerified: fields.identityEvidenceVerified ?? null,
      venueEvidenceVerified: fields.venueEvidenceVerified ?? null,
      sourceAccountName: fields.sourceAccountName ?? null,
      sourceAccountRole: fields.sourceAccountRole ?? null,
    },
  };
}

function contextProjection(context) {
  return {
    event: eventProjection(context.event),
    sourceLink: {
      id: context.sourceLink._id,
      updatedAt: context.sourceLink.updatedAt,
      eventId: context.sourceLink.eventId,
      sourceIdentity: context.sourceLink.sourceIdentity,
      sourceFingerprint: context.sourceLink.sourceFingerprint,
      sourceOccurrenceKey: context.sourceLink.sourceOccurrenceKey,
      instagramPostId: context.sourceLink.instagramPostId,
      instagramPostUrl: context.sourceLink.instagramPostUrl,
    },
    receipt: {
      id: context.receipt._id,
      updatedAt: context.receipt.updatedAt,
      sourceIdentity: context.receipt.sourceIdentity,
      sourceFingerprint: context.receipt.sourceFingerprint,
      expectedKeys: context.receipt.expectedKeys,
      expectedOccurrences: context.receipt.expectedOccurrences,
      satisfiedKeys: context.receipt.satisfiedKeys,
      satisfiedOccurrences: context.receipt.satisfiedOccurrences,
      deferredChildCount: context.receipt.deferredChildCount,
      deferredChildKeys: context.receipt.deferredChildKeys,
    },
  };
}

const client = new ConvexHttpClient(convexUrl);
const events = await client.query("events:getManyByIds", {
  ids: EVENT_IDS,
  serviceSecret,
});
const projectedEvents = events.map(eventProjection);

const contexts = {};
for (const event of events) {
  try {
    contexts[event._id] = contextProjection(
      await client.query("events:getReviewedStructuredEvidenceCorrectionContext", {
        id: event._id,
        serviceSecret,
      }),
    );
  } catch (error) {
    contexts[event._id] = {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const handles = [
  ...new Set(projectedEvents.map((event) => event.sourceHandle).filter(Boolean)),
];
const sources = {};
for (const handle of handles) {
  sources[handle] = await client.query("instagramSources:getByHandle", {
    handle,
    serviceSecret,
  });
}

const wantedHandles = new Set([
  "muzej_jugoslavije",
  "freestylerbelgrade_official",
  "chillton_bashta",
  "chillton_chillton",
  "dubgastropub",
  "klubstudenatatehnike",
  "kolarac_art_bioskop",
  "kolarac_kolarceva_zaduzbina",
]);
const venues = (await client.query("venues:listVenues", { serviceSecret }))
  .filter((venue) => wantedHandles.has(normalizeHandle(venue.instagramHandle)))
  .map((venue) => ({
    id: venue._id,
    updatedAt: venue.updatedAt,
    name: venue.name,
    handle: normalizeHandle(venue.instagramHandle),
    aliases: venue.aliases ?? [],
    location: venue.location ?? null,
    publicStatus: venue.publicStatus ?? null,
    scrapeActive: venue.scrapeActive ?? null,
  }));

process.stdout.write(
  `${JSON.stringify({ events: projectedEvents, contexts, sources, venues }, null, 2)}\n`,
);
