export const VENUE_PUBLIC_STATUSES = ["pending", "published", "hidden"] as const;

export type VenuePublicStatus = (typeof VENUE_PUBLIC_STATUSES)[number];

export type VenueLifecycleFields = {
  /** Legacy field retained only while the lifecycle migration is rolling out. */
  isActive?: boolean;
  publicStatus?: VenuePublicStatus;
  scrapeActive?: boolean;
};

export type EffectiveVenueLifecycle = {
  publicStatus: VenuePublicStatus;
  scrapeActive: boolean;
  source: "explicit" | "legacy" | "mixed";
};

export type VenueLifecycleMigrationRecord = VenueLifecycleFields & {
  _id: string;
  instagramHandle?: string;
};

export type VenueLifecycleMigrationChange = {
  id: string;
  instagramHandle: string | null;
  before: VenueLifecycleFields;
  apply: Required<Pick<VenueLifecycleFields, "publicStatus" | "scrapeActive">>;
  rollback: {
    isActive: boolean | null;
    publicStatus: VenuePublicStatus | null;
    scrapeActive: boolean | null;
  };
};

export type VenueLifecycleMigrationPlan = {
  counts: {
    alreadyExplicit: number;
    legacyActiveFalse: number;
    legacyActiveMissing: number;
    legacyActiveTrue: number;
    needsMigration: number;
    scanned: number;
    targetHidden: number;
    targetPending: number;
    targetPublished: number;
    targetScrapeActive: number;
    targetScrapePaused: number;
  };
  changes: VenueLifecycleMigrationChange[];
};

export function getEffectiveVenueLifecycle(
  venue: VenueLifecycleFields,
): EffectiveVenueLifecycle {
  const hasExplicitScrapeState = typeof venue.scrapeActive === "boolean";
  const hasExplicitPublicState = venue.publicStatus !== undefined;
  const legacyActive = venue.isActive === true;

  return {
    scrapeActive: venue.scrapeActive ?? legacyActive,
    publicStatus: venue.publicStatus ?? (legacyActive ? "published" : "hidden"),
    source:
      hasExplicitScrapeState && hasExplicitPublicState
        ? "explicit"
        : !hasExplicitScrapeState && !hasExplicitPublicState
          ? "legacy"
          : "mixed",
  };
}

export function isVenuePublic(venue: VenueLifecycleFields): boolean {
  return getEffectiveVenueLifecycle(venue).publicStatus === "published";
}

export function isVenueScrapeActive(venue: VenueLifecycleFields): boolean {
  return getEffectiveVenueLifecycle(venue).scrapeActive;
}

export function buildVenueLifecycleMigrationPlan(
  venues: VenueLifecycleMigrationRecord[],
): VenueLifecycleMigrationPlan {
  const changes: VenueLifecycleMigrationChange[] = [];
  const counts = {
    alreadyExplicit: 0,
    legacyActiveFalse: 0,
    legacyActiveMissing: 0,
    legacyActiveTrue: 0,
    needsMigration: 0,
    scanned: venues.length,
    targetHidden: 0,
    targetPending: 0,
    targetPublished: 0,
    targetScrapeActive: 0,
    targetScrapePaused: 0,
  };

  for (const venue of venues) {
    if (venue.isActive === true) {
      counts.legacyActiveTrue += 1;
    } else if (venue.isActive === false) {
      counts.legacyActiveFalse += 1;
    } else {
      counts.legacyActiveMissing += 1;
    }

    const effective = getEffectiveVenueLifecycle(venue);
    if (effective.scrapeActive) {
      counts.targetScrapeActive += 1;
    } else {
      counts.targetScrapePaused += 1;
    }
    if (effective.publicStatus === "published") {
      counts.targetPublished += 1;
    } else if (effective.publicStatus === "pending") {
      counts.targetPending += 1;
    } else {
      counts.targetHidden += 1;
    }

    if (effective.source === "explicit") {
      counts.alreadyExplicit += 1;
      continue;
    }

    counts.needsMigration += 1;
    changes.push({
      id: venue._id,
      instagramHandle: venue.instagramHandle?.trim() || null,
      before: {
        ...(venue.isActive !== undefined ? { isActive: venue.isActive } : {}),
        ...(venue.publicStatus !== undefined ? { publicStatus: venue.publicStatus } : {}),
        ...(venue.scrapeActive !== undefined ? { scrapeActive: venue.scrapeActive } : {}),
      },
      apply: {
        publicStatus: effective.publicStatus,
        scrapeActive: effective.scrapeActive,
      },
      // JSON-safe exact pre-migration values. Null means the field was absent
      // and rollback must remove it rather than coerce it to false/hidden.
      rollback: {
        isActive: venue.isActive === undefined ? null : venue.isActive,
        publicStatus: venue.publicStatus === undefined ? null : venue.publicStatus,
        scrapeActive: venue.scrapeActive === undefined ? null : venue.scrapeActive,
      },
    });
  }

  return { counts, changes };
}
