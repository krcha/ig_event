import {
  normalizeHandle,
  normalizeVenueComparableText,
  type CanonicalVenueAliasesByHandle,
  type VenueNormalization,
  type VenueSource,
} from "./normalization";
import {
  buildVenueSnapshot,
  resolveVenue,
  type VenueIdentityRecord,
  type VenueResolutionReason,
  type VenueResolverRecord,
  type VenueSnapshot,
} from "./venue-resolver";

export type IngestionVenueResolver = {
  canonicalVenueAliasesByHandle: CanonicalVenueAliasesByHandle;
  canonicalVenueNamesByHandle: Readonly<Record<string, string>>;
  configuredVenueNamesByHandle: Readonly<Record<string, string>>;
  snapshot: VenueSnapshot;
  venueIdByProviderHandle: ReadonlyMap<string, string>;
};

export type IngestionVenueResolverSnapshotInput = {
  identities: readonly VenueIdentityRecord[];
  venues: readonly VenueResolverRecord[];
};

type IngestionVenueResolverInput = {
  canonicalVenueAliasesByHandle?: CanonicalVenueAliasesByHandle;
  canonicalVenueNamesByHandle: Readonly<Record<string, string>>;
  configuredVenueNamesByHandle?: Readonly<Record<string, string>>;
  staticVenueByHandle?: Readonly<Record<string, string>>;
  venueResolverSnapshot?: IngestionVenueResolverSnapshotInput;
};

type MutableIngestionVenue = {
  aliases: Set<string>;
  handles: Set<string>;
  id: string;
  name: string;
};

function syntheticVenueId(name: string): string {
  const identity = normalizeVenueComparableText(name);
  return `ingestion-venue:${identity || name.trim().toLocaleLowerCase("sr-Latn")}`;
}

/**
 * Compatibility adapter for ingestion's existing venue directory. It converts
 * the handle/name maps into the same immutable resolver snapshot used at the
 * Convex boundary. The synthetic IDs live only for this request; persisted
 * canonical venue IDs are assigned by the database adapter.
 */
export function buildIngestionVenueResolver(
  input: IngestionVenueResolverInput,
): IngestionVenueResolver {
  const aliasesByHandle = input.canonicalVenueAliasesByHandle ?? {};
  const configuredByHandle = input.configuredVenueNamesByHandle ?? {};
  const staticByHandle = input.staticVenueByHandle ?? {};
  const handles = new Set([
    ...Object.keys(input.canonicalVenueNamesByHandle),
    ...Object.keys(configuredByHandle),
    ...Object.keys(staticByHandle),
  ]);
  const venuesByIdentity = new Map<string, MutableIngestionVenue>();
  const identityByHandle = new Map<string, string>();

  for (const rawHandle of [...handles].sort()) {
    const handle = normalizeHandle(rawHandle);
    if (!handle) continue;
    const configuredName = configuredByHandle[handle]?.trim() ?? "";
    const canonicalName =
      input.canonicalVenueNamesByHandle[handle]?.trim() ?? "";
    const staticName = staticByHandle[handle]?.trim() ?? "";
    const name = configuredName || canonicalName || staticName;
    if (!name) continue;

    const identity = normalizeVenueComparableText(name);
    if (!identity) continue;
    const venue = venuesByIdentity.get(identity) ?? {
      aliases: new Set<string>(),
      handles: new Set<string>(),
      id: syntheticVenueId(name),
      name,
    };
    venue.handles.add(handle);
    for (const alias of [
      canonicalName,
      configuredName,
      staticName,
      ...(aliasesByHandle[handle] ?? []),
    ]) {
      const normalizedAlias = alias.trim();
      if (
        normalizedAlias &&
        normalizeVenueComparableText(normalizedAlias) !==
          normalizeVenueComparableText(venue.name)
      ) {
        venue.aliases.add(normalizedAlias);
      }
    }
    venuesByIdentity.set(identity, venue);
    identityByHandle.set(handle, identity);
  }

  const legacyRecords: VenueResolverRecord[] = [
    ...venuesByIdentity.values(),
  ].map((venue) => ({
    aliases: [...venue.aliases].sort(),
    id: venue.id,
    instagramHandle: [...venue.handles].sort()[0] ?? null,
    name: venue.name,
  }));
  const firstClassSnapshot = input.venueResolverSnapshot;
  const firstClassVenues = [...(firstClassSnapshot?.venues ?? [])];
  const firstClassIdentities = [...(firstClassSnapshot?.identities ?? [])];
  const nameCandidateIds = new Map<string, Set<string>>();
  const handleCandidateIds = new Map<string, Set<string>>();
  const addCandidateId = (
    lookup: Map<string, Set<string>>,
    key: string,
    venueId: string,
  ) => {
    if (!key) return;
    const ids = lookup.get(key) ?? new Set<string>();
    ids.add(venueId);
    lookup.set(key, ids);
  };
  for (const venue of firstClassVenues) {
    for (const value of [venue.name, ...(venue.aliases ?? [])]) {
      addCandidateId(
        nameCandidateIds,
        normalizeVenueComparableText(value),
        venue.id,
      );
    }
    addCandidateId(
      handleCandidateIds,
      normalizeHandle(venue.instagramHandle ?? ""),
      venue.id,
    );
  }
  for (const identity of firstClassIdentities) {
    if (identity.active === false) continue;
    if (identity.kind === "provider_account") {
      addCandidateId(
        handleCandidateIds,
        normalizeHandle(identity.value),
        identity.venueId,
      );
    } else {
      addCandidateId(
        nameCandidateIds,
        normalizeVenueComparableText(identity.value),
        identity.venueId,
      );
    }
  }

  const records: VenueResolverRecord[] = [...firstClassVenues];
  const identities: VenueIdentityRecord[] = [...firstClassIdentities];
  for (const [handle, identity] of identityByHandle) {
    const legacyVenue = venuesByIdentity.get(identity);
    if (!legacyVenue) continue;
    const candidateIds = new Set<string>(handleCandidateIds.get(handle) ?? []);
    for (const value of [legacyVenue.name, ...legacyVenue.aliases]) {
      for (const venueId of nameCandidateIds.get(
        normalizeVenueComparableText(value),
      ) ?? []) {
        candidateIds.add(venueId);
      }
    }
    if (candidateIds.size > 1) {
      // Conflicting first-class ownership must stay ambiguous; a compatibility
      // map is never allowed to manufacture a third synthetic winner.
      continue;
    }
    const venueId = [...candidateIds][0] ?? legacyVenue.id;
    if (candidateIds.size === 0) {
      records.push(
        legacyRecords.find((record) => record.id === legacyVenue.id) ?? {
          aliases: [...legacyVenue.aliases].sort(),
          id: legacyVenue.id,
          instagramHandle: handle,
          name: legacyVenue.name,
        },
      );
    }
    const existingHandleOwners =
      handleCandidateIds.get(handle) ?? new Set<string>();
    if (existingHandleOwners.size === 0) {
      identities.push({
        active: true,
        kind: "provider_account",
        provider: "instagram",
        value: handle,
        venueId,
      });
      addCandidateId(handleCandidateIds, handle, venueId);
    }
  }

  const uniqueRecords = records.filter(
    (record, index, all) =>
      all.findIndex((candidate) => candidate.id === record.id) === index,
  );
  const snapshot = buildVenueSnapshot({ identities, venues: uniqueRecords });
  const canonicalVenueAliasesByHandle: CanonicalVenueAliasesByHandle = {
    ...snapshot.canonicalVenueAliasesByHandle,
  };
  for (const [handle, aliases] of Object.entries(aliasesByHandle)) {
    canonicalVenueAliasesByHandle[handle] = [
      ...new Set([
        ...(canonicalVenueAliasesByHandle[handle] ?? []),
        ...aliases,
      ]),
    ];
  }
  const venueIdByProviderHandle = new Map<string, string>();
  for (const [key, candidates] of snapshot.providerHandleCandidates) {
    if (candidates.length !== 1 || !key.startsWith("instagram:")) continue;
    venueIdByProviderHandle.set(
      key.slice("instagram:".length),
      candidates[0].id,
    );
  }

  return {
    canonicalVenueAliasesByHandle,
    canonicalVenueNamesByHandle: {
      ...snapshot.canonicalVenueNamesByHandle,
      ...input.canonicalVenueNamesByHandle,
    },
    configuredVenueNamesByHandle: configuredByHandle,
    snapshot,
    venueIdByProviderHandle,
  };
}

const LEGACY_SOURCE_BY_REASON: Partial<
  Record<VenueResolutionReason, VenueSource>
> = {
  evidence_handle: "evidence_handle",
  evidence_name: "evidence_name",
  explicit_venue_id: "handle_map",
  location_name: "location_name",
  model_claim: "model",
  source_account: "handle_map",
};

/**
 * Runs all ingestion venue evidence through the universal typed resolver while
 * returning the legacy shape consumed by the existing preparation pipeline.
 */
export function resolveIngestionVenue(
  resolver: IngestionVenueResolver,
  input: {
    allowSourceAccountFallback?: boolean;
    evidenceTexts?: readonly (string | null | undefined)[];
    locationName?: string | null;
    postingProviderHandle?: string | null;
    rawVenueClaim?: string | null;
    sourceRole?: "venue" | "promoter" | "unknown";
    staticVenueByHandle?: Readonly<Record<string, string>>;
  },
): VenueNormalization {
  const postingProviderHandle = normalizeHandle(
    input.postingProviderHandle ?? "",
  );
  const sourceRole = input.sourceRole;
  const rawModelVenue = input.rawVenueClaim?.trim() ?? "";
  const rawLocationName = input.locationName?.trim() ?? "";
  const resolution = resolveVenue(resolver.snapshot, {
    allowSourceAccountFallback: input.allowSourceAccountFallback,
    evidenceTexts: input.evidenceTexts,
    locationName: input.locationName,
    postingProviderHandle,
    rawVenueClaim: input.rawVenueClaim,
    sourceRole,
    sourceVenueId:
      sourceRole === "promoter"
        ? null
        : (resolver.venueIdByProviderHandle.get(postingProviderHandle) ?? null),
    staticVenueByHandle: input.staticVenueByHandle,
  });

  if (resolution.status === "ambiguous") {
    return {
      rawLocationName,
      rawModelVenue,
      source: null,
      venue: null,
      wasFallback: true,
    };
  }
  if (resolution.status === "unresolved") {
    const evidenceSource = resolution.evidence[0]?.source;
    const source: VenueSource =
      evidenceSource === "location_name" || evidenceSource === "model"
        ? evidenceSource
        : null;
    return {
      rawLocationName,
      rawModelVenue,
      source,
      venue: resolution.proposedName ?? null,
      wasFallback: true,
    };
  }

  const source = LEGACY_SOURCE_BY_REASON[resolution.reason] ?? null;
  return {
    ...((
      resolution.reason === "evidence_handle"
        ? resolution.evidence[0]?.rawValue
        : null
    )
      ? {
          evidenceHandle: normalizeHandle(
            resolution.evidence[0]?.rawValue ?? "",
          ),
        }
      : {}),
    rawLocationName,
    rawModelVenue,
    source,
    venue: resolution.venue.name,
    wasFallback:
      resolution.reason === "location_name" ||
      resolution.reason === "source_account" ||
      resolution.reason === "explicit_venue_id",
  };
}
