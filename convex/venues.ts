import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  MAX_VENUE_ALIASES,
  normalizeHandle,
  normalizeVenueAliases,
  normalizeVenueComparableText,
  toSearchableText,
} from "../lib/pipeline/venue-normalization";
import { canonicalizeVenueCategory } from "../lib/taxonomy/venue-types";
import {
  buildVenueLifecycleMigrationPlan,
  buildVenueLifecycleRollbackManifest,
  getEffectiveVenueLifecycle,
  isVenuePublic,
  isVenueScrapeActive,
  type VenueLifecycleFields,
  type VenuePublicStatus,
} from "../lib/venues/venue-lifecycle";
import { requireAdminIdentity, requireAdminOrServiceSecret } from "./authz";
import {
  isEventPubliclyVisible,
  scheduleVenuePublicationRefresh,
} from "./publicationPolicy";
import {
  deactivateVenueIdentities,
  syncVenueRecordIdentities,
} from "./venueIdentities";
import {
  assertOperationPaginationOptions,
  clampQueryPaginationOptions,
} from "./internal/requestBounds";
import { assertCompleteEventVenueBindingCoverage } from "./internal/eventVenueBindingCoverage";

const DEFAULT_PUBLIC_VENUE_EVENT_LIMIT = 12;
const MAX_PUBLIC_VENUE_EVENT_LIMIT = 50;
const DEFAULT_PUBLIC_VENUE_DIRECTORY_LIMIT = 2000;
const MAX_PUBLIC_VENUE_DIRECTORY_LIMIT = 2000;
const MAX_VENUE_LIFECYCLE_MIGRATION_PAGE_SIZE = 100;
const MAX_VENUE_INGESTION_QUERY_PAGE_SIZE = 100;

const venueHoursSource = v.union(
  v.literal("osm"),
  v.literal("google"),
  v.literal("manual"),
  v.literal("none"),
);
const venuePublicStatus = v.union(
  v.literal("pending"),
  v.literal("published"),
  v.literal("hidden"),
);
const venueLifecycleRollbackValues = v.object({
  isActive: v.union(v.boolean(), v.null()),
  publicStatus: v.union(venuePublicStatus, v.null()),
  scrapeActive: v.union(v.boolean(), v.null()),
});
const venueLifecycleRollbackRecord = v.object({
  id: v.id("venues"),
  instagramHandle: v.union(v.string(), v.null()),
  rollback: venueLifecycleRollbackValues,
});
const venueLifecycleCounts = v.object({
  alreadyExplicit: v.number(),
  legacyActiveFalse: v.number(),
  legacyActiveMissing: v.number(),
  legacyActiveTrue: v.number(),
  needsMigration: v.number(),
  scanned: v.number(),
  targetHidden: v.number(),
  targetPending: v.number(),
  targetPublished: v.number(),
  targetScrapeActive: v.number(),
  targetScrapePaused: v.number(),
});

const normalizedInstagramHandleMigrationRow = v.object({
  id: v.id("venues"),
  expectedInstagramHandle: v.string(),
  expectedNormalizedInstagramHandle: v.union(v.string(), v.null()),
});
const MAX_INSTAGRAM_HANDLE_NORMALIZATION_PAGE_SIZE = 200;
const MAX_INSTAGRAM_HANDLE_NORMALIZATION_BATCH_SIZE = 25;
const MAX_VENUES_FOR_ALIAS_VALIDATION = 2_000;

const venueHoursPatch = {
  hoursSource: v.optional(venueHoursSource),
  hoursJson: v.optional(v.string()),
  hoursFetchedAt: v.optional(v.number()),
  hoursExpiresAt: v.optional(v.number()),
  hoursTimezone: v.optional(v.string()),
  osmElementId: v.optional(v.string()),
  osmElementType: v.optional(v.string()),
  googlePlaceId: v.optional(v.string()),
  hoursError: v.optional(v.string()),
};

function normalizeLimit(
  value: number | undefined,
  defaultValue: number,
  maxValue: number,
): number {
  if (!Number.isFinite(value)) {
    return defaultValue;
  }

  return Math.max(1, Math.min(maxValue, Math.trunc(value as number)));
}

async function assertVenueAliasesUnambiguous(
  ctx: MutationCtx,
  options: {
    aliases: string[];
    name: string;
    venueId?: Id<"venues">;
  },
): Promise<void> {
  const proposedAliasKeys = new Set(
    options.aliases.map(normalizeVenueComparableText).filter(Boolean),
  );
  const canonicalNameKey = normalizeVenueComparableText(options.name);

  const venues = await ctx.db.query("venues").take(MAX_VENUES_FOR_ALIAS_VALIDATION + 1);
  if (venues.length > MAX_VENUES_FOR_ALIAS_VALIDATION) {
    throw new Error("Venue alias validation exceeded its bounded venue limit.");
  }

  for (const venue of venues) {
    if (options.venueId !== undefined && venue._id === options.venueId) {
      continue;
    }
    const conflictingValues = [venue.name, ...(venue.aliases ?? [])];
    const conflictingValue = conflictingValues.find((value) =>
      proposedAliasKeys.has(normalizeVenueComparableText(value)),
    );
    if (conflictingValue) {
      throw new Error(
        `Venue alias ${JSON.stringify(conflictingValue)} is already assigned to ${venue.name}.`,
      );
    }
    const conflictingAlias = (venue.aliases ?? []).find(
      (alias) => normalizeVenueComparableText(alias) === canonicalNameKey,
    );
    if (conflictingAlias) {
      throw new Error(
        `Venue name ${JSON.stringify(options.name)} conflicts with an alias assigned to ${venue.name}.`,
      );
    }
  }

  if (canonicalNameKey && proposedAliasKeys.has(canonicalNameKey)) {
    throw new Error("A venue alias cannot duplicate its canonical name.");
  }
  if (options.aliases.length > MAX_VENUE_ALIASES) {
    throw new Error(`A venue can have at most ${MAX_VENUE_ALIASES} aliases.`);
  }
}

function compareVenueEvents(
  left: Pick<Doc<"events">, "_id" | "date" | "time" | "title">,
  right: Pick<Doc<"events">, "_id" | "date" | "time" | "title">,
): number {
  const dateResult = left.date.localeCompare(right.date);
  if (dateResult !== 0) {
    return dateResult;
  }

  const timeResult = (left.time ?? "99:99").localeCompare(right.time ?? "99:99");
  if (timeResult !== 0) {
    return timeResult;
  }

  const titleResult = left.title.localeCompare(right.title, undefined, {
    sensitivity: "base",
  });
  if (titleResult !== 0) {
    return titleResult;
  }

  return left._id.localeCompare(right._id);
}

function compareVenueEventsDesc(
  left: Pick<Doc<"events">, "_id" | "date" | "time" | "title">,
  right: Pick<Doc<"events">, "_id" | "date" | "time" | "title">,
): number {
  return compareVenueEvents(right, left);
}

function mergeUniqueEvents(events: Doc<"events">[]): Doc<"events">[] {
  const eventsById = new Map<Id<"events">, Doc<"events">>();
  for (const event of events) {
    eventsById.set(event._id, event);
  }
  return [...eventsById.values()];
}

async function loadBoundedVenueEventCards(
  ctx: QueryCtx,
  venue: Doc<"venues">,
  options: { direction: "history" | "upcoming"; limit: number; today: string },
): Promise<Doc<"events">[]> {
  const normalizedHandle = normalizeHandle(venue.instagramHandle);
  const normalizedVenueIdentity = toSearchableText(venue.name);
  const isHistory = options.direction === "history";
  const order = isHistory ? ("desc" as const) : ("asc" as const);
  const byVenueId = ctx.db
    .query("events")
    .withIndex("by_venueId_status_date", (q) => {
      const indexed = q.eq("venueId", venue._id).eq("status", "approved");
      return isHistory ? indexed.lt("date", options.today) : indexed.gte("date", options.today);
    })
    .order(order)
    .take(options.limit);
  const byNormalizedHandle = normalizedHandle
    ? ctx.db
        .query("events")
        .withIndex("by_normalizedVenueHandle_status_date", (q) => {
          const indexed = q
            .eq("normalizedVenueInstagramHandle", normalizedHandle)
            .eq("status", "approved");
          return isHistory
            ? indexed.lt("date", options.today)
            : indexed.gte("date", options.today);
        })
        .order(order)
        .take(options.limit)
    : Promise.resolve([]);
  const byNormalizedVenueIdentity = normalizedVenueIdentity
    ? ctx.db
        .query("events")
        .withIndex("by_normalizedVenueIdentity_status_date", (q) => {
          const indexed = q
            .eq("normalizedVenueIdentity", normalizedVenueIdentity)
            .eq("status", "approved");
          return isHistory
            ? indexed.lt("date", options.today)
            : indexed.gte("date", options.today);
        })
        .order(order)
        .take(options.limit)
    : Promise.resolve([]);
  const [linked, handleMatches, identityMatches] = await Promise.all([
    byVenueId,
    byNormalizedHandle,
    byNormalizedVenueIdentity,
  ]);
  const legacy = [...handleMatches, ...identityMatches].filter((event) => !event.venueId);
  const merged = mergeUniqueEvents([...linked, ...legacy]);
  const grounding = await Promise.all(
    merged.map((event) => isEventPubliclyVisible(ctx, event)),
  );
  const grounded = merged.filter((_, index) => grounding[index]);
  grounded.sort(isHistory ? compareVenueEventsDesc : compareVenueEvents);
  return grounded.slice(0, options.limit);
}

function buildInstagramProfileUrl(handle: string): string {
  const normalized = handle.trim().replace(/^@+/, "");
  return normalized ? `https://www.instagram.com/${normalized}/` : "";
}

function mergeUniqueVenues(venues: Doc<"venues">[]): Doc<"venues">[] {
  const byId = new Map<Id<"venues">, Doc<"venues">>();
  for (const venue of venues) {
    byId.set(venue._id, venue);
  }
  return [...byId.values()];
}

async function collectScrapeActiveVenues(ctx: QueryCtx): Promise<Doc<"venues">[]> {
  const [explicit, legacy] = await Promise.all([
    ctx.db
      .query("venues")
      .withIndex("by_scrapeActive", (q) => q.eq("scrapeActive", true))
      .take(MAX_PUBLIC_VENUE_DIRECTORY_LIMIT + 1),
    ctx.db
      .query("venues")
      .withIndex("by_isActive", (q) => q.eq("isActive", true))
      .take(MAX_PUBLIC_VENUE_DIRECTORY_LIMIT + 1),
  ]);
  if (
    explicit.length > MAX_PUBLIC_VENUE_DIRECTORY_LIMIT ||
    legacy.length > MAX_PUBLIC_VENUE_DIRECTORY_LIMIT
  ) {
    throw new Error(
      "Scrape-active venue compatibility result exceeds its safe bound; use the paginated ingestion query.",
    );
  }
  return mergeUniqueVenues([...explicit, ...legacy]).filter(isVenueScrapeActive);
}

async function collectPublicVenues(ctx: QueryCtx): Promise<Doc<"venues">[]> {
  const [explicit, legacy] = await Promise.all([
    ctx.db
      .query("venues")
      .withIndex("by_publicStatus", (q) => q.eq("publicStatus", "published"))
      .take(MAX_PUBLIC_VENUE_DIRECTORY_LIMIT),
    ctx.db
      .query("venues")
      .withIndex("by_isActive", (q) => q.eq("isActive", true))
      .take(MAX_PUBLIC_VENUE_DIRECTORY_LIMIT),
  ]);
  return mergeUniqueVenues([...explicit, ...legacy]).filter(isVenuePublic);
}

type LifecycleAuditSnapshot = {
  effectivePublicStatus: VenuePublicStatus;
  effectiveScrapeActive: boolean;
  isActive: boolean | null;
  publicStatus: VenuePublicStatus | null;
  scrapeActive: boolean | null;
};

function lifecycleAuditSnapshot(venue: VenueLifecycleFields): LifecycleAuditSnapshot {
  const effective = getEffectiveVenueLifecycle(venue);
  return {
    effectivePublicStatus: effective.publicStatus,
    effectiveScrapeActive: effective.scrapeActive,
    isActive: venue.isActive ?? null,
    publicStatus: venue.publicStatus ?? null,
    scrapeActive: venue.scrapeActive ?? null,
  };
}

async function insertVenueLifecycleAudit(
  ctx: MutationCtx,
  options: {
    action: string;
    actor: string;
    after: LifecycleAuditSnapshot;
    before: LifecycleAuditSnapshot | Record<string, never>;
    createdAt: number;
    note?: string;
    venueId: Id<"venues">;
  },
) {
  await ctx.db.insert("venueAuditLog", {
    venueId: options.venueId,
    action: options.action,
    actor: options.actor,
    beforeJson: JSON.stringify(options.before),
    afterJson: JSON.stringify(options.after),
    ...(options.note ? { note: options.note } : {}),
    createdAt: options.createdAt,
  });
}

function toPublicVenue(venue: Doc<"venues">) {
  return {
    _id: venue._id,
    aliases: venue.aliases ?? [],
    category: venue.category,
    googlePlaceId: venue.googlePlaceId,
    hoursError: venue.hoursError,
    hoursExpiresAt: venue.hoursExpiresAt,
    hoursFetchedAt: venue.hoursFetchedAt,
    hoursJson: venue.hoursJson,
    hoursSource: venue.hoursSource,
    hoursTimezone: venue.hoursTimezone,
    instagramFollowerCount: venue.instagramFollowerCount,
    instagramFollowerCountUpdatedAt: venue.instagramFollowerCountUpdatedAt,
    instagramHandle: venue.instagramHandle,
    instagramProfileUrl: buildInstagramProfileUrl(venue.instagramHandle),
    latitude: venue.latitude,
    location: venue.location,
    longitude: venue.longitude,
    name: venue.name,
    neighborhood: venue.neighborhood,
    osmElementId: venue.osmElementId,
    osmElementType: venue.osmElementType,
    updatedAt: venue.updatedAt,
  };
}

function toPublicEvent(event: {
  _id: Id<"events">;
  artists: string[];
  date: string;
  description?: string;
  eventType: string;
  imageUrl?: string;
  imageStorageId?: Id<"_storage">;
  instagramPostId?: string;
  instagramPostUrl?: string;
  ticketPrice?: string;
  time?: string;
  title: string;
  venue: string;
  venueCategory?: string;
  venueId?: Id<"venues">;
}) {
  return {
    _id: event._id,
    artists: event.artists,
    date: event.date,
    description: event.description,
    eventType: event.eventType,
    imageUrl: event.imageUrl,
    imageStorageId: event.imageStorageId,
    instagramPostId: event.instagramPostId,
    instagramPostUrl: event.instagramPostUrl,
    ticketPrice: event.ticketPrice,
    time: event.time,
    title: event.title,
    venue: event.venue,
    venueCategory: event.venueCategory,
    venueId: event.venueId,
  };
}

export const listVenues = query({
  args: {
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const venues = await ctx.db
      .query("venues")
      .order("asc")
      .take(MAX_PUBLIC_VENUE_DIRECTORY_LIMIT + 1);
    if (venues.length > MAX_PUBLIC_VENUE_DIRECTORY_LIMIT) {
      throw new Error(
        "Venue compatibility list exceeds its safe bound; use listVenueIngestionFieldsPaginated.",
      );
    }
    return venues.map((venue) => ({
      ...venue,
      ...getEffectiveVenueLifecycle(venue),
    }));
  },
});

export const listScrapeActiveVenues = query({
  args: {
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    return collectScrapeActiveVenues(ctx);
  },
});

// Backward-compatible function name for callers deployed during the rollout.
// Its behavior now follows scrape activation only, never publication state.
export const listActiveVenues = query({
  args: {
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    return collectScrapeActiveVenues(ctx);
  },
});

export const listVenueIngestionFieldsPaginated = query({
  args: {
    paginationOpts: paginationOptsValidator,
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const result = await ctx.db
      .query("venues")
      .paginate(
        clampQueryPaginationOptions(
          args.paginationOpts,
          MAX_VENUE_INGESTION_QUERY_PAGE_SIZE,
        ),
      );
    return {
      ...result,
      page: result.page.map((venue) => ({
        name: venue.name,
        instagramHandle: venue.instagramHandle,
        aliases: venue.aliases ?? [],
        location: venue.location,
      })),
    };
  },
});

export const listActiveVenueIngestionFieldsPaginated = query({
  args: {
    paginationOpts: paginationOptsValidator,
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const result = await ctx.db
      .query("venues")
      .paginate(
        clampQueryPaginationOptions(
          args.paginationOpts,
          MAX_VENUE_INGESTION_QUERY_PAGE_SIZE,
        ),
      );
    return {
      ...result,
      page: result.page.filter(isVenueScrapeActive).map((venue) => ({
        name: venue.name,
        instagramHandle: venue.instagramHandle,
        aliases: venue.aliases ?? [],
        location: venue.location,
      })),
    };
  },
});

export const getVenue = query({
  args: { id: v.id("venues") },
  handler: async (ctx, args) => {
    await requireAdminIdentity(ctx);
    return ctx.db.get(args.id);
  },
});

export const listPublicVenueFieldsByIds = query({
  args: {
    ids: v.array(v.id("venues")),
  },
  handler: async (ctx, args) => {
    const uniqueIds = [...new Set(args.ids)];
    if (uniqueIds.length > 100) {
      throw new Error("Public venue field reads are limited to 100 unique IDs.");
    }
    const venues = await Promise.all(uniqueIds.map((id) => ctx.db.get(id)));
    return venues.flatMap((venue) =>
      venue && isVenuePublic(venue)
        ? [
            {
              _id: venue._id,
              aliases: venue.aliases ?? [],
              category: venue.category,
              hoursJson: venue.hoursJson,
              hoursSource: venue.hoursSource,
              hoursTimezone: venue.hoursTimezone,
              instagramFollowerCount: venue.instagramFollowerCount,
              instagramFollowerCountUpdatedAt: venue.instagramFollowerCountUpdatedAt,
              instagramHandle: venue.instagramHandle,
              instagramProfileUrl: buildInstagramProfileUrl(venue.instagramHandle),
              latitude: venue.latitude,
              location: venue.location,
              longitude: venue.longitude,
              name: venue.name,
              neighborhood: venue.neighborhood,
            },
          ]
        : [],
    );
  },
});

export const listPublicVenueFields = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = normalizeLimit(
      args.limit,
      DEFAULT_PUBLIC_VENUE_DIRECTORY_LIMIT,
      MAX_PUBLIC_VENUE_DIRECTORY_LIMIT,
    );
    const venues = (await collectPublicVenues(ctx)).slice(0, limit);

    return venues.map(toPublicVenue).sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );
  },
});

// Backward-compatible name retained while older web builds are drained.
export const listPublicActiveVenueFields = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = normalizeLimit(
      args.limit,
      DEFAULT_PUBLIC_VENUE_DIRECTORY_LIMIT,
      MAX_PUBLIC_VENUE_DIRECTORY_LIMIT,
    );
    return (await collectPublicVenues(ctx))
      .slice(0, limit)
      .map(toPublicVenue)
      .sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
      );
  },
});

export const getPublicVenuePage = query({
  args: {
    id: v.string(),
    historyLimit: v.optional(v.number()),
    today: v.string(),
    upcomingLimit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const venueId = ctx.db.normalizeId("venues", args.id) as Id<"venues"> | null;
    if (!venueId) {
      return null;
    }

    const venue = await ctx.db.get(venueId);
    if (!venue || !isVenuePublic(venue)) {
      return null;
    }

    const upcomingLimit = normalizeLimit(
      args.upcomingLimit,
      DEFAULT_PUBLIC_VENUE_EVENT_LIMIT,
      MAX_PUBLIC_VENUE_EVENT_LIMIT,
    );
    const historyLimit = normalizeLimit(
      args.historyLimit,
      DEFAULT_PUBLIC_VENUE_EVENT_LIMIT,
      MAX_PUBLIC_VENUE_EVENT_LIMIT,
    );

    const [upcomingEvents, historyEvents] = await Promise.all([
      loadBoundedVenueEventCards(ctx, venue, {
        direction: "upcoming",
        limit: upcomingLimit,
        today: args.today,
      }),
      loadBoundedVenueEventCards(ctx, venue, {
        direction: "history",
        limit: historyLimit,
        today: args.today,
      }),
    ]);

    return {
      venue: toPublicVenue(venue),
      upcomingEvents: upcomingEvents.map(toPublicEvent),
      historyEvents: historyEvents.map(toPublicEvent),
      stats: null,
    };
  },
});

export const listPublicVenueDirectory = query({
  args: {
    limit: v.optional(v.number()),
    today: v.string(),
  },
  handler: async (ctx, args) => {
    const limit = normalizeLimit(
      args.limit,
      DEFAULT_PUBLIC_VENUE_DIRECTORY_LIMIT,
      MAX_PUBLIC_VENUE_DIRECTORY_LIMIT,
    );
    const venues = (await collectPublicVenues(ctx)).slice(0, limit);
    return venues
      .map((venue) => ({
        ...toPublicVenue(venue),
        // Compatibility shape only. New clients do not expose this incomplete total.
        upcomingEventCount: 0,
      }))
      .sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
      );
  },
});

export const createVenue = mutation({
  args: {
    name: v.string(),
    instagramHandle: v.string(),
    aliases: v.optional(v.array(v.string())),
    instagramFollowerCount: v.optional(v.number()),
    instagramFollowerCountUpdatedAt: v.optional(v.number()),
    category: v.string(),
    location: v.optional(v.string()),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    neighborhood: v.optional(v.string()),
    lastFullScrapeAttemptAt: v.optional(v.number()),
    // Accepted during rollout so older callers map their one state to both
    // independent lifecycle fields. New callers must use the explicit fields.
    isActive: v.optional(v.boolean()),
    scrapeActive: v.optional(v.boolean()),
    publicStatus: v.optional(venuePublicStatus),
    auditNote: v.optional(v.string()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authorization = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const {
      auditNote,
      isActive: legacyActive,
      serviceSecret: _serviceSecret,
      publicStatus = legacyActive === undefined
        ? ("pending" as VenuePublicStatus)
        : legacyActive
          ? ("published" as VenuePublicStatus)
          : ("hidden" as VenuePublicStatus),
      scrapeActive = legacyActive ?? true,
      ...venueArgs
    } = args;
    void _serviceSecret;
    const instagramHandle = normalizeHandle(venueArgs.instagramHandle);
    if (!instagramHandle) {
      throw new Error("Venue Instagram handle is required.");
    }
    const [exactRows, normalizedRows] = await Promise.all([
      ctx.db
        .query("venues")
        .withIndex("by_instagramHandle", (q) =>
          q.eq("instagramHandle", instagramHandle),
        )
        .take(2),
      ctx.db
        .query("venues")
        .withIndex("by_normalizedInstagramHandle", (q) =>
          q.eq("normalizedInstagramHandle", instagramHandle),
        )
        .take(2),
    ]);
    const existingVenues = new Map(
      [...exactRows, ...normalizedRows].map((venue) => [venue._id, venue]),
    );
    if (existingVenues.size > 1) {
      throw new Error("Multiple venues share that normalized Instagram handle.");
    }
    const existingVenue = [...existingVenues.values()][0];
    if (existingVenue) {
      return existingVenue._id;
    }
    const aliases = normalizeVenueAliases(venueArgs.aliases ?? []);
    await assertVenueAliasesUnambiguous(ctx, {
      aliases,
      name: venueArgs.name,
    });
    const now = Date.now();
    const venueId = await ctx.db.insert("venues", {
      ...venueArgs,
      aliases,
      instagramHandle,
      normalizedInstagramHandle: instagramHandle,
      category: canonicalizeVenueCategory(venueArgs.category),
      publicStatus,
      scrapeActive,
      createdAt: now,
      updatedAt: now,
    });
    await insertVenueLifecycleAudit(ctx, {
      action: "venue.lifecycle.created",
      actor: authorization.actor,
      before: {},
      after: lifecycleAuditSnapshot({ publicStatus, scrapeActive }),
      createdAt: now,
      note: auditNote,
      venueId,
    });
    const createdVenue = await ctx.db.get(venueId);
    if (!createdVenue) throw new Error("Created venue could not be reloaded.");
    await syncVenueRecordIdentities(ctx, createdVenue);
    return venueId;
  },
});

export const updateVenue = mutation({
  args: {
    id: v.id("venues"),
    expectedUpdatedAt: v.optional(v.number()),
    patch: v.object({
      name: v.optional(v.string()),
      instagramHandle: v.optional(v.string()),
      aliases: v.optional(v.array(v.string())),
      instagramFollowerCount: v.optional(v.number()),
      instagramFollowerCountUpdatedAt: v.optional(v.number()),
      category: v.optional(v.string()),
      location: v.optional(v.string()),
      latitude: v.optional(v.number()),
      longitude: v.optional(v.number()),
      neighborhood: v.optional(v.string()),
      lastFullScrapeAttemptAt: v.optional(v.number()),
      // Backward-compatible legacy input; it maps to both explicit states.
      isActive: v.optional(v.boolean()),
      scrapeActive: v.optional(v.boolean()),
      publicStatus: v.optional(venuePublicStatus),
    }),
    auditNote: v.optional(v.string()),
    serviceSecret: v.optional(v.string()),
  },
  returns: v.object({ updated: v.boolean(), updatedAt: v.number() }),
  handler: async (ctx, args) => {
    const authorization = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const existing = await ctx.db.get(args.id);
    if (!existing) {
      throw new Error("Venue not found.");
    }
    if (
      args.expectedUpdatedAt !== undefined &&
      existing.updatedAt !== args.expectedUpdatedAt
    ) {
      throw new Error("Venue changed after it was reviewed.");
    }

    const now = Math.max(Date.now(), existing.updatedAt + 1);
    const { isActive: legacyActive, ...rawExplicitPatch } = args.patch;
    const aliases =
      rawExplicitPatch.aliases === undefined
        ? undefined
        : normalizeVenueAliases(rawExplicitPatch.aliases);
    let instagramHandle: string | undefined;
    if (rawExplicitPatch.instagramHandle !== undefined) {
      const normalizedInstagramHandle = normalizeHandle(rawExplicitPatch.instagramHandle);
      if (!normalizedInstagramHandle) {
        throw new Error("Venue Instagram handle is required.");
      }
      instagramHandle = normalizedInstagramHandle;
      const [exactRows, normalizedRows] = await Promise.all([
        ctx.db
          .query("venues")
          .withIndex("by_instagramHandle", (q) =>
            q.eq("instagramHandle", normalizedInstagramHandle),
          )
          .take(2),
        ctx.db
          .query("venues")
          .withIndex("by_normalizedInstagramHandle", (q) =>
            q.eq("normalizedInstagramHandle", normalizedInstagramHandle),
          )
          .take(2),
      ]);
      const equivalentVenues = new Map(
        [...exactRows, ...normalizedRows].map((venue) => [venue._id, venue]),
      );
      if (
        [...equivalentVenues.values()].some((venue) => venue._id !== args.id)
      ) {
        throw new Error("A venue with that normalized Instagram handle already exists.");
      }
    }
    const explicitPatch = {
      ...rawExplicitPatch,
      ...(aliases !== undefined ? { aliases } : {}),
      ...(instagramHandle !== undefined
        ? { instagramHandle, normalizedInstagramHandle: instagramHandle }
        : {}),
    };
    if (explicitPatch.name !== undefined || explicitPatch.aliases !== undefined) {
      await assertVenueAliasesUnambiguous(ctx, {
        aliases: explicitPatch.aliases ?? existing.aliases ?? [],
        name: explicitPatch.name ?? existing.name,
        venueId: args.id,
      });
    }
    const patch = {
      ...explicitPatch,
      ...(legacyActive !== undefined && explicitPatch.scrapeActive === undefined
        ? { scrapeActive: legacyActive }
        : {}),
      ...(legacyActive !== undefined && explicitPatch.publicStatus === undefined
        ? { publicStatus: legacyActive ? ("published" as const) : ("hidden" as const) }
        : {}),
      ...(explicitPatch.category !== undefined
        ? { category: canonicalizeVenueCategory(explicitPatch.category) }
        : {}),
    };
    const denormalizedFields = [
      "name",
      "instagramHandle",
      "category",
      "location",
      "latitude",
      "longitude",
    ] as const;
    const changesDenormalizedIdentity = denormalizedFields.some(
      (field) =>
        Object.prototype.hasOwnProperty.call(patch, field) &&
        patch[field] !== existing[field],
    );
    if (changesDenormalizedIdentity) {
      const existingHandle = normalizeHandle(existing.instagramHandle);
      const [linkedEvents, linkedOccurrences, legacyHandleEvents, legacyIdentityEvents] =
        await Promise.all([
          ctx.db
            .query("events")
            .withIndex("by_venueId", (q) => q.eq("venueId", existing._id))
            .take(1),
          ctx.db
            .query("sourceOccurrences")
            .withIndex("by_venue", (q) => q.eq("venueId", existing._id))
            .take(1),
          existingHandle
            ? ctx.db
                .query("events")
                .withIndex("by_normalizedVenueHandle_status_date", (q) =>
                  q.eq("normalizedVenueInstagramHandle", existingHandle),
                )
                .take(1)
            : Promise.resolve([]),
          existingHandle
            ? ctx.db
                .query("events")
                .withIndex("by_normalizedVenueIdentity_status_date", (q) =>
                  q.eq("normalizedVenueIdentity", `instagram:${existingHandle}`),
                )
                .take(1)
            : Promise.resolve([]),
        ]);
      if (
        linkedEvents.length > 0 ||
        linkedOccurrences.length > 0 ||
        legacyHandleEvents.length > 0 ||
        legacyIdentityEvents.length > 0
      ) {
        throw new Error(
          "Referenced venue identity/public fields require a bounded venue-rebind migration; no venue was changed.",
        );
      }
    }
    const before = lifecycleAuditSnapshot(existing);
    const after = lifecycleAuditSnapshot({ ...existing, ...patch });
    if (
      before.effectivePublicStatus === "published" &&
      after.effectivePublicStatus !== "published"
    ) {
      await assertCompleteEventVenueBindingCoverage(ctx);
    }
    await ctx.db.patch(args.id, { ...patch, updatedAt: now });
    await syncVenueRecordIdentities(ctx, {
      ...existing,
      ...patch,
      updatedAt: now,
    });

    if (
      (explicitPatch.scrapeActive !== undefined || legacyActive !== undefined) &&
      before.effectiveScrapeActive !== after.effectiveScrapeActive
    ) {
      await insertVenueLifecycleAudit(ctx, {
        action: "venue.scrape_activation.changed",
        actor: authorization.actor,
        before,
        after,
        createdAt: now,
        note: args.auditNote,
        venueId: args.id,
      });
    }
    if (
      (explicitPatch.publicStatus !== undefined || legacyActive !== undefined) &&
      before.effectivePublicStatus !== after.effectivePublicStatus
    ) {
      await insertVenueLifecycleAudit(ctx, {
        action: "venue.public_status.changed",
        actor: authorization.actor,
        before,
        after,
        createdAt: now,
        note: args.auditNote,
        venueId: args.id,
      });
      await scheduleVenuePublicationRefresh(ctx, args.id);
    }
    return { updated: true, updatedAt: now };
  },
});

export const listInstagramHandleNormalizationPage = query({
  args: {
    paginationOpts: paginationOptsValidator,
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const paginationOpts = assertOperationPaginationOptions(
      args.paginationOpts,
      MAX_INSTAGRAM_HANDLE_NORMALIZATION_PAGE_SIZE,
      "Venue handle normalization pages",
    );
    const result = await ctx.db.query("venues").paginate(paginationOpts);
    return {
      ...result,
      page: result.page.map((venue) => ({
        id: venue._id,
        instagramHandle: venue.instagramHandle,
        normalizedInstagramHandle: venue.normalizedInstagramHandle ?? null,
        expectedNormalizedInstagramHandle: normalizeHandle(venue.instagramHandle),
      })),
    };
  },
});

export const applyInstagramHandleNormalizationBatch = mutation({
  args: {
    rows: v.array(normalizedInstagramHandleMigrationRow),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    if (
      args.rows.length < 1 ||
      args.rows.length > MAX_INSTAGRAM_HANDLE_NORMALIZATION_BATCH_SIZE
    ) {
      throw new Error(
        `Venue handle normalization batches must contain 1 to ${MAX_INSTAGRAM_HANDLE_NORMALIZATION_BATCH_SIZE} rows.`,
      );
    }

    const normalizedWithinBatch = new Map<string, Id<"venues">>();
    const planned: Array<{
      id: Id<"venues">;
      normalizedHandle: string;
      needsUpdate: boolean;
    }> = [];
    for (const row of args.rows) {
      const venue = await ctx.db.get(row.id);
      if (!venue) {
        throw new Error(`Venue ${row.id} no longer exists.`);
      }
      if (
        venue.instagramHandle !== row.expectedInstagramHandle ||
        (venue.normalizedInstagramHandle ?? null) !== row.expectedNormalizedInstagramHandle
      ) {
        throw new Error(`Venue ${row.id} changed after normalization preflight.`);
      }
      const normalizedHandle = normalizeHandle(venue.instagramHandle);
      if (!normalizedHandle) {
        throw new Error(`Venue ${row.id} has an invalid Instagram handle.`);
      }
      const batchOwner = normalizedWithinBatch.get(normalizedHandle);
      if (batchOwner && batchOwner !== row.id) {
        throw new Error(
          `Venue handle normalization collision for ${normalizedHandle}: ${batchOwner} and ${row.id}.`,
        );
      }
      normalizedWithinBatch.set(normalizedHandle, row.id);

      const normalizedMatches = await ctx.db
        .query("venues")
        .withIndex("by_normalizedInstagramHandle", (q) =>
          q.eq("normalizedInstagramHandle", normalizedHandle),
        )
        .take(2);
      const normalizedConflict = normalizedMatches.find((candidate) => candidate._id !== row.id);
      if (normalizedConflict) {
        throw new Error(
          `Venue handle normalization collision for ${normalizedHandle}: ${normalizedConflict._id} and ${row.id}.`,
        );
      }
      const exactConflict = await ctx.db
        .query("venues")
        .withIndex("by_instagramHandle", (q) => q.eq("instagramHandle", normalizedHandle))
        .first();
      if (exactConflict && exactConflict._id !== row.id) {
        throw new Error(
          `Venue handle normalization collision for ${normalizedHandle}: ${exactConflict._id} and ${row.id}.`,
        );
      }
      planned.push({
        id: row.id,
        normalizedHandle,
        needsUpdate: venue.normalizedInstagramHandle !== normalizedHandle,
      });
    }

    let updated = 0;
    for (const plan of planned) {
      if (!plan.needsUpdate) continue;
      await ctx.db.patch(plan.id, { normalizedInstagramHandle: plan.normalizedHandle });
      updated += 1;
    }
    return { scanned: planned.length, updated };
  },
});

export const clearInstagramHandleNormalizationBatch = mutation({
  args: {
    rows: v.array(normalizedInstagramHandleMigrationRow),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    if (
      args.rows.length < 1 ||
      args.rows.length > MAX_INSTAGRAM_HANDLE_NORMALIZATION_BATCH_SIZE
    ) {
      throw new Error(
        `Venue handle normalization rollback batches must contain 1 to ${MAX_INSTAGRAM_HANDLE_NORMALIZATION_BATCH_SIZE} rows.`,
      );
    }

    const planned: Id<"venues">[] = [];
    for (const row of args.rows) {
      const venue = await ctx.db.get(row.id);
      if (!venue) throw new Error(`Venue ${row.id} no longer exists.`);
      if (
        venue.instagramHandle !== row.expectedInstagramHandle ||
        (venue.normalizedInstagramHandle ?? null) !== row.expectedNormalizedInstagramHandle
      ) {
        throw new Error(`Venue ${row.id} changed after normalization rollback preflight.`);
      }
      if (venue.normalizedInstagramHandle !== undefined) planned.push(row.id);
    }
    for (const id of planned) {
      await ctx.db.patch(id, { normalizedInstagramHandle: undefined });
    }
    return { scanned: args.rows.length, updated: planned.length };
  },
});

export const listVenueAuditLog = query({
  args: {
    venueId: v.id("venues"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdminIdentity(ctx);
    const limit = normalizeLimit(args.limit, 25, 100);
    return ctx.db
      .query("venueAuditLog")
      .withIndex("by_venue", (q) => q.eq("venueId", args.venueId))
      .order("desc")
      .take(limit);
  },
});

export const previewVenueLifecycleMigration = query({
  args: {
    paginationOpts: paginationOptsValidator,
    serviceSecret: v.optional(v.string()),
  },
  returns: v.object({
    counts: venueLifecycleCounts,
    continueCursor: v.string(),
    isDone: v.boolean(),
    rollbackManifest: v.array(venueLifecycleRollbackRecord),
    rollbackMapping: v.object({
      afterIndependentEdits: v.string(),
      beforeIndependentEdits: v.string(),
    }),
    sampleChangesJson: v.string(),
  }),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const paginationOpts = assertOperationPaginationOptions(
      args.paginationOpts,
      MAX_VENUE_LIFECYCLE_MIGRATION_PAGE_SIZE,
      "Venue lifecycle preview page",
    );
    const page = await ctx.db
      .query("venues")
      .order("asc")
      .paginate(paginationOpts);
    const plan = buildVenueLifecycleMigrationPlan(page.page);
    return {
      counts: plan.counts,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      rollbackManifest: buildVenueLifecycleRollbackManifest(plan.changes).map(
        (record) => ({ ...record, id: record.id as Id<"venues"> }),
      ),
      rollbackMapping: {
        beforeIndependentEdits:
          "restore each isActive, scrapeActive, and publicStatus field from its rollback value; null means remove only that field, otherwise set the exact value",
        afterIndependentEdits:
          "restore the referenced Convex backup; one legacy boolean cannot preserve independent states",
      },
      sampleChangesJson: JSON.stringify(plan.changes.slice(0, 20)),
    };
  },
});

export const applyVenueLifecycleMigrationBatch = mutation({
  args: {
    backupReference: v.string(),
    rollbackManifest: v.array(venueLifecycleRollbackRecord),
    serviceSecret: v.optional(v.string()),
  },
  returns: v.object({
    applied: v.number(),
    appliedIds: v.array(v.id("venues")),
    backupReference: v.string(),
    beforeCounts: venueLifecycleCounts,
  }),
  handler: async (ctx, args) => {
    const authorization = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const backupReference = args.backupReference.trim();
    if (!backupReference) {
      throw new Error("A non-empty backupReference is required.");
    }

    if (
      args.rollbackManifest.length < 1 ||
      args.rollbackManifest.length > MAX_VENUE_LIFECYCLE_MIGRATION_PAGE_SIZE
    ) {
      throw new Error(
        `Venue lifecycle apply requires 1-${MAX_VENUE_LIFECYCLE_MIGRATION_PAGE_SIZE} reviewed rollback records.`,
      );
    }
    const uniqueIds = new Set(args.rollbackManifest.map((record) => record.id));
    if (uniqueIds.size !== args.rollbackManifest.length) {
      throw new Error("Venue lifecycle rollback records must have unique venue IDs.");
    }
    const loaded = await Promise.all(
      args.rollbackManifest.map((record) => ctx.db.get(record.id)),
    );
    if (loaded.some((venue) => !venue)) {
      throw new Error("A reviewed venue no longer exists.");
    }
    const venues = loaded.filter((venue): venue is Doc<"venues"> => Boolean(venue));
    const plan = buildVenueLifecycleMigrationPlan(venues);
    if (
      plan.changes.length !== args.rollbackManifest.length ||
      JSON.stringify(buildVenueLifecycleRollbackManifest(plan.changes)) !==
        JSON.stringify(args.rollbackManifest)
    ) {
      throw new Error(
        "Venue lifecycle state changed after rollback-manifest review; export and review a fresh paginated manifest before applying.",
      );
    }
    const venueById = new Map(venues.map((venue) => [venue._id, venue] as const));
    if (
      plan.changes.some((change) => {
        const venue = venueById.get(change.id as Id<"venues">);
        return Boolean(
          venue &&
            isVenuePublic(venue) &&
            !isVenuePublic({ ...venue, ...change.apply }),
        );
      })
    ) {
      await assertCompleteEventVenueBindingCoverage(ctx);
    }
    let applied = 0;
    const appliedIds: Id<"venues">[] = [];

    for (const change of plan.changes) {
      const venue = venueById.get(change.id as Id<"venues">);
      if (!venue || getEffectiveVenueLifecycle(venue).source === "explicit") {
        throw new Error("Reviewed venue lifecycle row is no longer eligible.");
      }
      const now = Math.max(Date.now(), venue.updatedAt + 1);
      const before = lifecycleAuditSnapshot(venue);
      const after = lifecycleAuditSnapshot({ ...venue, ...change.apply });
      await ctx.db.patch(venue._id, {
        publicStatus: change.apply.publicStatus,
        scrapeActive: change.apply.scrapeActive,
        updatedAt: now,
      });
      await insertVenueLifecycleAudit(ctx, {
        action: "venue.lifecycle.migrated",
        actor: authorization.actor,
        before,
        after,
        createdAt: now,
        note: `backup=${backupReference}; rollback=${JSON.stringify(change.rollback)}`,
        venueId: venue._id,
      });
      if (before.effectivePublicStatus !== after.effectivePublicStatus) {
        await scheduleVenuePublicationRefresh(ctx, venue._id);
      }
      applied += 1;
      appliedIds.push(venue._id);
    }

    return {
      applied,
      appliedIds,
      backupReference,
      beforeCounts: plan.counts,
    };
  },
});

export const patchVenueHours = mutation({
  args: {
    id: v.id("venues"),
    patch: v.object(venueHoursPatch),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    await ctx.db.patch(args.id, args.patch);
  },
});

export const removeVenue = mutation({
  args: { id: v.id("venues") },
  handler: async (ctx, args) => {
    const identity = await requireAdminIdentity(ctx);
    const venue = await ctx.db.get(args.id);
    if (!venue) return;
    if (isVenuePublic(venue)) {
      await assertCompleteEventVenueBindingCoverage(ctx);
    }
    const now = Math.max(Date.now(), venue.updatedAt + 1);
    const before = lifecycleAuditSnapshot(venue);
    const lifecyclePatch = {
      isActive: false,
      publicStatus: "hidden" as const,
      scrapeActive: false,
      updatedAt: now,
    };
    await ctx.db.patch(args.id, lifecyclePatch);
    await deactivateVenueIdentities(ctx, args.id);
    await scheduleVenuePublicationRefresh(ctx, args.id);
    await insertVenueLifecycleAudit(ctx, {
      action: "venue.lifecycle.soft_removed",
      actor: identity.subject,
      before,
      after: lifecycleAuditSnapshot({ ...venue, ...lifecyclePatch }),
      createdAt: now,
      note: "Venue retained to preserve event, source, and favorite references.",
      venueId: venue._id,
    });
  },
});
