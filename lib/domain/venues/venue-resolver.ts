import {
  buildCanonicalVenueAliasesByHandle,
  buildCanonicalVenueNamesByHandle,
  normalizeHandle,
  normalizeVenueComparableText,
  normalizeVenueFromEvidence,
  type CanonicalVenueAliasesByHandle,
  type VenueNormalization,
  type VenueSource,
} from "./normalization";

export const VENUE_RESOLVER_POLICY_VERSION = 1 as const;

export type VenueIdentityKind =
  | "canonical_name"
  | "alias"
  | "historical_alias"
  | "provider_account";

export type VenueResolverRecord = {
  aliases?: readonly string[];
  category?: string;
  id: string;
  instagramHandle?: string | null;
  latitude?: number;
  location?: string | null;
  longitude?: number;
  name: string;
};

export type VenueIdentityRecord = {
  active?: boolean;
  kind: VenueIdentityKind;
  provider?: "instagram";
  value: string;
  venueId: string;
};

export type VenueIdentityClaim = {
  kind: "canonical_name" | "alias" | "historical_alias" | "provider_account";
  normalizedValue: string;
  provider?: "instagram";
  rawValue: string;
};

/** Converts ordinary venue configuration into identity-table data. */
export function buildVenueIdentityClaims(
  venue: Pick<VenueResolverRecord, "aliases" | "instagramHandle" | "name">,
): VenueIdentityClaim[] {
  const claims: VenueIdentityClaim[] = [];
  const canonicalName = normalizeVenueComparableText(venue.name);
  if (canonicalName) {
    claims.push({
      kind: "canonical_name",
      normalizedValue: canonicalName,
      rawValue: venue.name.trim(),
    });
  }
  for (const alias of venue.aliases ?? []) {
    const normalizedValue = normalizeVenueComparableText(alias);
    if (normalizedValue) {
      claims.push({
        kind: "alias",
        normalizedValue,
        rawValue: alias.trim(),
      });
    }
  }
  const providerHandle = normalizeHandle(venue.instagramHandle ?? "");
  if (providerHandle) {
    claims.push({
      kind: "provider_account",
      normalizedValue: providerHandle,
      provider: "instagram",
      rawValue: providerHandle,
    });
  }
  return claims.filter(
    (claim, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.kind === claim.kind &&
          candidate.normalizedValue === claim.normalizedValue,
      ) === index,
  );
}

export type VenueSnapshot = {
  canonicalVenueAliasesByHandle: CanonicalVenueAliasesByHandle;
  canonicalVenueNamesByHandle: Record<string, string>;
  fingerprint: string;
  identityCandidates: ReadonlyMap<string, readonly VenueResolverRecord[]>;
  providerHandleCandidates: ReadonlyMap<string, readonly VenueResolverRecord[]>;
  records: readonly VenueResolverRecord[];
  venueById: ReadonlyMap<string, VenueResolverRecord>;
  version: typeof VENUE_RESOLVER_POLICY_VERSION;
};

export type VenueResolutionReason =
  | "explicit_venue_id"
  | "evidence_handle"
  | "evidence_name"
  | "location_name"
  | "model_claim"
  | "source_account"
  | "identity_ambiguous"
  | "unknown";

export type VenueResolutionEvidence = {
  rawValue?: string;
  source:
    | Exclude<VenueSource, null>
    | "venue_id"
    | "source_account"
    | "identity";
};

export type ResolvedVenue = {
  candidates: readonly VenueResolverRecord[];
  confidence: "proven" | "strong";
  evidence: readonly VenueResolutionEvidence[];
  reason: VenueResolutionReason;
  status: "resolved";
  venue: VenueResolverRecord;
};

export type AmbiguousVenue = {
  candidates: readonly VenueResolverRecord[];
  confidence: "ambiguous";
  evidence: readonly VenueResolutionEvidence[];
  reason: "identity_ambiguous";
  status: "ambiguous";
};

export type UnresolvedVenue = {
  candidates: readonly VenueResolverRecord[];
  confidence: "unknown";
  evidence: readonly VenueResolutionEvidence[];
  proposedName?: string;
  reason: "unknown";
  status: "unresolved";
};

export type VenueResolution = ResolvedVenue | AmbiguousVenue | UnresolvedVenue;

export type ResolveVenueInput = {
  allowSourceAccountFallback?: boolean;
  evidenceTexts?: readonly (string | null | undefined)[];
  explicitVenueId?: string | null;
  locationName?: string | null;
  postingProviderHandle?: string | null;
  rawVenueClaim?: string | null;
  sourceRole?: "venue" | "promoter" | "unknown";
  sourceVenueId?: string | null;
  staticVenueByHandle?: Readonly<Record<string, string>>;
};

function identityKey(value: string): string {
  return `name:${normalizeVenueComparableText(value)}`;
}

function providerHandleKey(provider: "instagram", value: string): string {
  return `${provider}:${normalizeHandle(value)}`;
}

function addCandidate(
  map: Map<string, VenueResolverRecord[]>,
  key: string,
  venue: VenueResolverRecord,
): void {
  if (!key || key.endsWith(":")) return;
  const current = map.get(key) ?? [];
  if (!current.some((candidate) => candidate.id === venue.id)) {
    map.set(key, [...current, venue]);
  }
}

function stableSnapshotFingerprint(values: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const value of values.join("\n")) {
    hash = Math.imul(hash ^ value.charCodeAt(0), 0x01000193) >>> 0;
  }
  return `venue-snapshot-v${VENUE_RESOLVER_POLICY_VERSION}:${hash
    .toString(16)
    .padStart(8, "0")}`;
}

export function buildVenueSnapshot(options: {
  identities?: readonly VenueIdentityRecord[];
  venues: readonly VenueResolverRecord[];
}): VenueSnapshot {
  const records = options.venues
    .map((venue) => ({
      ...venue,
      aliases: [
        ...new Set(
          (venue.aliases ?? []).map((alias) => alias.trim()).filter(Boolean),
        ),
      ],
      instagramHandle: normalizeHandle(venue.instagramHandle ?? "") || null,
      name: venue.name.trim(),
    }))
    .filter((venue) => venue.id && venue.name)
    .sort((left, right) => left.id.localeCompare(right.id));
  const venueById = new Map(records.map((venue) => [venue.id, venue]));
  const identityCandidates = new Map<string, VenueResolverRecord[]>();
  const providerHandleCandidates = new Map<string, VenueResolverRecord[]>();

  for (const venue of records) {
    addCandidate(identityCandidates, identityKey(venue.name), venue);
    for (const alias of venue.aliases ?? []) {
      addCandidate(identityCandidates, identityKey(alias), venue);
    }
    if (venue.instagramHandle) {
      addCandidate(
        providerHandleCandidates,
        providerHandleKey("instagram", venue.instagramHandle),
        venue,
      );
    }
  }

  for (const identity of options.identities ?? []) {
    if (identity.active === false) continue;
    const venue = venueById.get(identity.venueId);
    if (!venue) continue;
    if (identity.kind === "provider_account") {
      addCandidate(
        providerHandleCandidates,
        providerHandleKey(identity.provider ?? "instagram", identity.value),
        venue,
      );
    } else {
      addCandidate(identityCandidates, identityKey(identity.value), venue);
    }
  }

  const canonicalRecords = records.flatMap((venue) =>
    venue.instagramHandle
      ? [
          {
            aliases: [...(venue.aliases ?? [])],
            instagramHandle: venue.instagramHandle,
            location: venue.location,
            name: venue.name,
          },
        ]
      : [],
  );
  const canonicalVenueNamesByHandle =
    buildCanonicalVenueNamesByHandle(canonicalRecords);
  const canonicalVenueAliasesByHandle =
    buildCanonicalVenueAliasesByHandle(canonicalRecords);
  for (const [key, candidates] of providerHandleCandidates) {
    if (candidates.length === 1) {
      const handle = key.slice("instagram:".length);
      canonicalVenueNamesByHandle[handle] = candidates[0].name;
      canonicalVenueAliasesByHandle[handle] = [
        ...(candidates[0].aliases ?? []),
      ];
    }
  }

  const fingerprintValues = [
    ...records.flatMap((venue) => [
      `venue:${venue.id}:${venue.name}:${venue.instagramHandle ?? ""}`,
      ...(venue.aliases ?? []).map((alias) => `alias:${venue.id}:${alias}`),
    ]),
    ...(options.identities ?? [])
      .filter((identity) => identity.active !== false)
      .map(
        (identity) =>
          `identity:${identity.venueId}:${identity.kind}:${identity.provider ?? ""}:${identity.value}`,
      )
      .sort(),
  ];

  return {
    canonicalVenueAliasesByHandle,
    canonicalVenueNamesByHandle,
    fingerprint: stableSnapshotFingerprint(fingerprintValues),
    identityCandidates,
    providerHandleCandidates,
    records,
    venueById,
    version: VENUE_RESOLVER_POLICY_VERSION,
  };
}

function uniqueCandidates(
  values: readonly VenueResolverRecord[],
): VenueResolverRecord[] {
  const byId = new Map(values.map((venue) => [venue.id, venue]));
  return [...byId.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

function candidatesForName(
  snapshot: VenueSnapshot,
  value: string,
): VenueResolverRecord[] {
  const normalized = normalizeVenueComparableText(value);
  if (!normalized) return [];
  return uniqueCandidates(
    snapshot.identityCandidates.get(`name:${normalized}`) ?? [],
  );
}

function candidatesForHandle(
  snapshot: VenueSnapshot,
  value: string,
): VenueResolverRecord[] {
  const normalized = normalizeHandle(value);
  if (!normalized) return [];
  return uniqueCandidates(
    snapshot.providerHandleCandidates.get(`instagram:${normalized}`) ?? [],
  );
}

function ambiguous(
  candidates: readonly VenueResolverRecord[],
  rawValue: string,
): AmbiguousVenue {
  return {
    candidates,
    confidence: "ambiguous",
    evidence: [{ rawValue, source: "identity" }],
    reason: "identity_ambiguous",
    status: "ambiguous",
  };
}

function resolved(
  venue: VenueResolverRecord,
  reason: VenueResolutionReason,
  source: VenueResolutionEvidence["source"],
  rawValue?: string,
): ResolvedVenue {
  return {
    candidates: [venue],
    confidence:
      reason === "model_claim" || reason === "location_name"
        ? "strong"
        : "proven",
    evidence: [{ ...(rawValue ? { rawValue } : {}), source }],
    reason,
    status: "resolved",
    venue,
  };
}

function collectMentionedHandleCandidates(
  snapshot: VenueSnapshot,
  evidenceTexts: readonly (string | null | undefined)[],
): VenueResolverRecord[] {
  const candidates: VenueResolverRecord[] = [];
  for (const text of evidenceTexts) {
    for (const match of (text ?? "").matchAll(
      /(?:^|[^\p{L}\p{N}._])[@#]([a-z0-9_]+(?:\.[a-z0-9_]+)*)/giu,
    )) {
      candidates.push(...candidatesForHandle(snapshot, match[1] ?? ""));
    }
  }
  return uniqueCandidates(candidates);
}

function materializeEvidenceResolution(
  snapshot: VenueSnapshot,
  evidenceResolution: VenueNormalization,
): VenueResolution | null {
  if (!evidenceResolution.venue) return null;

  const byName = candidatesForName(snapshot, evidenceResolution.venue);
  const byHandle = evidenceResolution.evidenceHandle
    ? candidatesForHandle(snapshot, evidenceResolution.evidenceHandle)
    : [];
  const candidates = uniqueCandidates([...byName, ...byHandle]);
  if (candidates.length > 1) {
    return ambiguous(candidates, evidenceResolution.venue);
  }
  if (candidates.length === 1) {
    const reasonBySource: Record<
      Exclude<VenueSource, null>,
      VenueResolutionReason
    > = {
      evidence_handle: "evidence_handle",
      evidence_name: "evidence_name",
      handle_map: "source_account",
      location_name: "location_name",
      model: "model_claim",
    };
    return resolved(
      candidates[0],
      evidenceResolution.source
        ? reasonBySource[evidenceResolution.source]
        : "unknown",
      evidenceResolution.source ?? "identity",
      evidenceResolution.evidenceHandle ?? evidenceResolution.venue,
    );
  }

  return {
    candidates: [],
    confidence: "unknown",
    evidence: [
      {
        rawValue: evidenceResolution.venue,
        source: evidenceResolution.source ?? "identity",
      },
    ],
    proposedName: evidenceResolution.venue,
    reason: "unknown",
    status: "unresolved",
  };
}

/**
 * Universal, side-effect-free venue resolution entrypoint. Database and
 * ingestion adapters build one request-scoped snapshot and pass all claims
 * through this function. Ambiguity is returned as data and never guessed.
 */
export function resolveVenue(
  snapshot: VenueSnapshot,
  input: ResolveVenueInput,
): VenueResolution {
  const explicitVenueId = input.explicitVenueId?.trim();
  if (explicitVenueId) {
    const explicitVenue = snapshot.venueById.get(explicitVenueId);
    if (explicitVenue) {
      return resolved(
        explicitVenue,
        "explicit_venue_id",
        "venue_id",
        explicitVenueId,
      );
    }
  }

  const postingProviderHandle = normalizeHandle(
    input.postingProviderHandle ?? "",
  );
  const sourceVenue = input.sourceVenueId
    ? snapshot.venueById.get(input.sourceVenueId)
    : undefined;
  const sourceFallbackAllowed =
    input.allowSourceAccountFallback !== false &&
    input.sourceRole !== "promoter";
  const sourceAccountMap =
    sourceVenue && postingProviderHandle && sourceFallbackAllowed
      ? { [postingProviderHandle]: sourceVenue.name }
      : {};
  const evidenceResolution = normalizeVenueFromEvidence({
    allowCanonicalHandleFallback: sourceFallbackAllowed,
    canonicalVenueAliasesByHandle: snapshot.canonicalVenueAliasesByHandle,
    canonicalVenueNamesByHandle: snapshot.canonicalVenueNamesByHandle,
    handle: postingProviderHandle,
    handleVenueNamesByHandle: sourceAccountMap,
    immutableEvidenceTexts: [...(input.evidenceTexts ?? [])],
    locationName: input.locationName,
    rawModelVenue: input.rawVenueClaim ?? "",
    staticVenueByHandle: { ...(input.staticVenueByHandle ?? {}) },
  });
  const selectedEvidenceVenue = materializeEvidenceResolution(
    snapshot,
    evidenceResolution,
  );
  if (sourceVenue && sourceFallbackAllowed && selectedEvidenceVenue) {
    return selectedEvidenceVenue;
  }

  const positiveClaimCandidates: VenueResolverRecord[] = [];
  for (const claim of [input.rawVenueClaim, input.locationName]) {
    const value = claim?.trim() ?? "";
    if (!value) continue;
    const byName = candidatesForName(snapshot, value);
    const byHandle = candidatesForHandle(snapshot, value);
    const candidates = uniqueCandidates([...byName, ...byHandle]);
    if (candidates.length > 1) return ambiguous(candidates, value);
    positiveClaimCandidates.push(...candidates);
  }

  const mentionedHandleCandidates = collectMentionedHandleCandidates(
    snapshot,
    input.evidenceTexts ?? [],
  );
  if (mentionedHandleCandidates.length > 1) {
    return ambiguous(
      mentionedHandleCandidates,
      "multiple provider-account mentions",
    );
  }
  positiveClaimCandidates.push(...mentionedHandleCandidates);

  const independentlyResolvedCandidates = uniqueCandidates(
    positiveClaimCandidates,
  );
  if (independentlyResolvedCandidates.length > 1) {
    return ambiguous(
      independentlyResolvedCandidates,
      "independent venue evidence resolves to conflicting venues",
    );
  }
  if (selectedEvidenceVenue) return selectedEvidenceVenue;
  if (sourceVenue && sourceFallbackAllowed) {
    return resolved(
      sourceVenue,
      "source_account",
      "source_account",
      postingProviderHandle,
    );
  }

  return {
    candidates: mentionedHandleCandidates,
    confidence: "unknown",
    evidence: [],
    reason: "unknown",
    status: "unresolved",
  };
}
