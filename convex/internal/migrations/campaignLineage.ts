import { v } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { internalMutation } from "../../_generated/server";
import { canonicalizeSourceUrl } from "../../../lib/domain/source-url";
import {
  buildOccurrenceSignature,
  digestOccurrenceSignature,
  toOccurrenceCandidateIndexFields,
} from "../../../lib/domain/occurrences/signature";
import {
  buildCampaignLineageEvidenceDigest,
  CAMPAIGN_LINEAGE_REATTESTATION_KEY,
} from "../../../lib/events/campaign-lineage-reattestation";
import {
  CROSS_POST_CAMPAIGN_AGGREGATE_ATTESTATION_FIELD,
  crossPostCampaignAggregateBindingMatchesEvent,
  hasCrossPostCampaignAggregateAttestationField,
  readCrossPostCampaignAggregateAttestation,
  type CrossPostCampaignAggregateAttestation,
} from "../../../lib/events/cross-post-campaign-aggregate-attestation";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../../lib/events/source-occurrence-representation";
import { isVenuePublic } from "../../../lib/venues/venue-lifecycle";
import { refreshEventPublicationStates } from "../../publicationPolicy";
import { buildEventOccurrenceIndexPatch } from "../../sourceOccurrences";
import {
  resolveVenueForWrite,
  type VenueDenormalizedFields,
} from "../../venueResolver";
import { markSourceOccurrenceTopologyMutation } from "../sourceOccurrenceTopologyEpoch";

export { CAMPAIGN_LINEAGE_REATTESTATION_KEY };
const DEFAULT_BATCH_SIZE = 8;
const MAX_BATCH_SIZE = 16;

type ExpectedOccurrence = NonNullable<
  Doc<"instagramSourceOccurrenceReceipts">["expectedOccurrences"]
>[number];

type PreparedSource = {
  canonicalSourceUrl: string;
  expected: ExpectedOccurrence;
  occurrenceOrdinal: number;
  existingOccurrence: Doc<"sourceOccurrences"> | null;
  link: Doc<"instagramEventSources">;
  receipt: Doc<"instagramSourceOccurrenceReceipts">;
  sourceDocument: Doc<"scrapedPosts">;
  sourceEvent: Doc<"events">;
  venueFields: VenueDenormalizedFields;
};

type PreparedCampaign = {
  attestation: CrossPostCampaignAggregateAttestation;
  evidenceDigest: string;
  fields: Record<string, unknown>;
  primary: Doc<"events">;
  sources: PreparedSource[];
};

type CampaignOccurrenceEvidence = Pick<
  Doc<"sourceOccurrences">,
  | "canonicalEventId"
  | "canonicalSourceUrl"
  | "factsJson"
  | "normalizedOccurrenceJson"
  | "occurrenceArtistFingerprint"
  | "occurrenceDateKey"
  | "occurrenceEventType"
  | "occurrenceSignatureHash"
  | "occurrenceSignatureVersion"
  | "occurrenceTimeIdentity"
  | "occurrenceTitleFamily"
  | "occurrenceVenueIdentity"
  | "sourceDocumentId"
  | "sourceFingerprint"
  | "sourceRevision"
  | "state"
  | "venueId"
  | "venueResolutionStatus"
>;

type PrepareResult =
  | { kind: "not_campaign" }
  | { kind: "quarantined"; operationId: string; reason: string; sourceCount: number }
  | { kind: "ready"; prepared: PreparedCampaign };

function normalizeBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_BATCH_SIZE;
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.trunc(value as number)));
}

function parseFields(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function buildCampaignOccurrenceEvidence(
  prepared: PreparedCampaign,
  source: PreparedSource,
): CampaignOccurrenceEvidence {
  const signature = toOccurrenceCandidateIndexFields(
    buildOccurrenceSignature({
      artists: source.expected.artists,
      eventType: prepared.primary.eventType,
      localDate: source.expected.date,
      normalizedVenueIdentity: prepared.primary.normalizedVenueIdentity,
      time: source.expected.time,
      title: source.expected.title,
      venueId: prepared.primary.venueId,
      venueInstagramHandle: prepared.primary.normalizedVenueInstagramHandle,
    }),
  );
  return {
    canonicalEventId: prepared.primary._id,
    canonicalSourceUrl: source.canonicalSourceUrl,
    factsJson: JSON.stringify(source.expected),
    normalizedOccurrenceJson: JSON.stringify({
      artists: source.expected.artists,
      date: source.expected.date,
      eventType: prepared.primary.eventType,
      time: source.expected.time ?? null,
      title: source.expected.title,
      venue: source.expected.venue,
      venueId: prepared.primary.venueId ?? null,
    }),
    ...signature,
    sourceDocumentId: source.sourceDocument._id,
    sourceFingerprint: source.link.sourceFingerprint,
    sourceRevision: source.sourceDocument.sourceRevision ?? 1,
    state: "satisfied",
    venueId: prepared.primary.venueId,
    venueResolutionStatus: "resolved",
  };
}

function occurrenceEvidenceMatches(
  occurrence: Doc<"sourceOccurrences"> | null,
  evidence: CampaignOccurrenceEvidence,
): boolean {
  return Boolean(
    occurrence &&
      Object.entries(evidence).every(
        ([field, value]) =>
          occurrence[field as keyof Doc<"sourceOccurrences">] === value,
      ),
  );
}

function patchMatches<T extends object>(
  current: T,
  patch: Record<string, unknown>,
): boolean {
  return Object.entries(patch).every(
    ([field, value]) => current[field as keyof T] === value,
  );
}

function campaignSourceEventBindingPatch(source: PreparedSource) {
  const effectiveEvent: Doc<"events"> = {
    ...source.sourceEvent,
    ...source.venueFields,
  };
  return {
    ...source.venueFields,
    ...buildEventOccurrenceIndexPatch(effectiveEvent),
  };
}

function quarantine(
  event: Doc<"events">,
  reason: string,
  attestation?: CrossPostCampaignAggregateAttestation | null,
): PrepareResult {
  return {
    kind: "quarantined",
    operationId: attestation?.operationId ?? `invalid:${String(event._id)}`,
    reason,
    sourceCount: attestation?.sources.length ?? 0,
  };
}

async function prepareCampaign(
  ctx: MutationCtx,
  event: Doc<"events">,
): Promise<PrepareResult> {
  if (!hasCrossPostCampaignAggregateAttestationField(event.normalizedFieldsJson)) {
    return { kind: "not_campaign" };
  }
  const fields = parseFields(event.normalizedFieldsJson);
  const attestation = readCrossPostCampaignAggregateAttestation(
    event.normalizedFieldsJson,
  );
  if (!fields || !attestation) {
    return quarantine(event, "campaign_attestation_invalid", attestation);
  }
  if (!crossPostCampaignAggregateBindingMatchesEvent(attestation, event)) {
    return quarantine(event, "campaign_public_binding_drifted", attestation);
  }
  const targetVenue = await ctx.db.get(
    attestation.targetVenueId as Id<"venues">,
  );
  if (!targetVenue || !isVenuePublic(targetVenue) || event.venueId !== targetVenue._id) {
    return quarantine(event, "campaign_target_venue_unavailable", attestation);
  }
  const preparedSources: PreparedSource[] = [];
  for (const source of attestation.sources) {
    const [sourceEvent, link, receipt] = await Promise.all([
      ctx.db.get(source.eventId as Id<"events">),
      ctx.db.get(source.sourceLinkId as Id<"instagramEventSources">),
      ctx.db.get(source.receiptId as Id<"instagramSourceOccurrenceReceipts">),
    ]);
    if (
      !sourceEvent ||
      sourceEvent.updatedAt !== source.eventUpdatedAt ||
      sourceEvent.instagramPostId !== source.instagramPostId ||
      !link ||
      link.updatedAt !== source.sourceLinkUpdatedAt ||
      link.eventId !== sourceEvent._id ||
      link.sourceIdentity !== source.sourceIdentity ||
      link.sourceFingerprint !== source.sourceFingerprint ||
      link.sourceOccurrenceKey !== source.sourceOccurrenceKey ||
      link.instagramPostId !== source.instagramPostId ||
      !receipt ||
      receipt.updatedAt !== source.receiptUpdatedAt ||
      receipt.sourceIdentity !== source.sourceIdentity ||
      receipt.sourceFingerprint !== source.sourceFingerprint
    ) {
      return quarantine(event, "campaign_source_snapshot_drifted", attestation);
    }
    const expected = receipt.expectedOccurrences?.filter(
      (item) => item.key === source.sourceOccurrenceKey,
    );
    const occurrenceOrdinal =
      receipt.expectedOccurrences?.findIndex(
        (item) => item.key === source.sourceOccurrenceKey,
      ) ?? -1;
    const satisfaction = receipt.satisfiedOccurrences.filter(
      (item) => item.key === source.sourceOccurrenceKey,
    );
    if (
      expected?.length !== 1 ||
      occurrenceOrdinal < 0 ||
      satisfaction.length !== 1 ||
      satisfaction[0]!.eventId !== event._id ||
      receipt.expectedKeys.filter((key) => key === source.sourceOccurrenceKey)
        .length !== 1 ||
      receipt.satisfiedKeys.filter((key) => key === source.sourceOccurrenceKey)
        .length !== 1 ||
      !sourceOccurrenceRepresentativeMatchesExpected(event, expected[0])
    ) {
      return quarantine(event, "campaign_receipt_not_reattestable", attestation);
    }
    const venueResolution = await resolveVenueForWrite(ctx, expected[0].venue);
    if (
      venueResolution.resolution.status !== "resolved" ||
      venueResolution.venueFields.venueId !== targetVenue._id
    ) {
      return quarantine(event, "campaign_venue_resolution_not_exact", attestation);
    }
    const sourceDocuments = await ctx.db
      .query("scrapedPosts")
      .withIndex("by_handle_postId", (q) =>
        q.eq("handle", source.sourceHandle).eq("postId", source.instagramPostId),
      )
      .take(2);
    if (sourceDocuments.length !== 1) {
      return quarantine(event, "campaign_source_document_not_unique", attestation);
    }
    const sourceDocument = sourceDocuments[0]!;
    const canonicalSource = canonicalizeSourceUrl(
      "instagram",
      sourceDocument.instagramPostUrl,
    );
    const attestedCanonicalSource = canonicalizeSourceUrl(
      "instagram",
      source.instagramPostUrl,
    );
    if (
      !canonicalSource.ok ||
      !attestedCanonicalSource.ok ||
      canonicalSource.value.canonicalUrl !==
        attestedCanonicalSource.value.canonicalUrl ||
      !Number.isSafeInteger(sourceDocument.sourceRevision ?? 1) ||
      (sourceDocument.sourceRevision ?? 1) < 1
    ) {
      return quarantine(event, "campaign_source_document_evidence_drifted", attestation);
    }
    const occurrences = await ctx.db
      .query("sourceOccurrences")
      .withIndex("by_source_occurrence", (q) =>
        q
          .eq("sourceIdentity", source.sourceIdentity)
          .eq("sourceOccurrenceKey", source.sourceOccurrenceKey),
      )
      .take(2);
    if (occurrences.length > 1) {
      return quarantine(event, "campaign_source_occurrence_not_unique", attestation);
    }
    const existingOccurrence = occurrences[0] ?? null;
    if (
      existingOccurrence &&
      (existingOccurrence.sourceDocumentId !== sourceDocument._id ||
        existingOccurrence.sourceFingerprint !== source.sourceFingerprint ||
        existingOccurrence.sourceRevision !== (sourceDocument.sourceRevision ?? 1) ||
        existingOccurrence.canonicalSourceUrl !== canonicalSource.value.canonicalUrl ||
        (existingOccurrence.state === "satisfied" &&
          existingOccurrence.canonicalEventId !== event._id) ||
        (existingOccurrence.state === "superseded" &&
          existingOccurrence.canonicalEventId !== undefined) ||
        !["satisfied", "superseded"].includes(existingOccurrence.state))
    ) {
      return quarantine(event, "campaign_source_occurrence_conflicted", attestation);
    }
    if (
      link.sourceOccurrenceId !== undefined &&
      link.sourceOccurrenceId !== existingOccurrence?._id
    ) {
      return quarantine(event, "campaign_source_link_occurrence_conflicted", attestation);
    }
    preparedSources.push({
      canonicalSourceUrl: canonicalSource.value.canonicalUrl,
      expected: expected[0],
      occurrenceOrdinal,
      existingOccurrence,
      link,
      receipt,
      sourceDocument,
      sourceEvent,
      venueFields: venueResolution.venueFields,
    });
  }
  const evidenceDigest = buildCampaignLineageEvidenceDigest({
    operationId: attestation.operationId,
    primaryEventId: attestation.primaryEventId,
    sources: attestation.sources.map((source, index) => ({
      canonicalSourceUrl: preparedSources[index]!.canonicalSourceUrl,
      expected: preparedSources[index]!.expected,
      occurrenceOrdinal: preparedSources[index]!.occurrenceOrdinal,
      receiptId: source.receiptId,
      sourceDocumentId: preparedSources[index]!.sourceDocument._id,
      sourceFingerprint: source.sourceFingerprint,
      sourceIdentity: source.sourceIdentity,
      sourceLinkId: source.sourceLinkId,
      sourceOccurrenceKey: source.sourceOccurrenceKey,
      sourceRevision:
        preparedSources[index]!.sourceDocument.sourceRevision ?? 1,
    })),
    targetVenueId: attestation.targetVenueId,
  });
  return {
    kind: "ready",
    prepared: {
      attestation,
      evidenceDigest,
      fields,
      primary: event,
      sources: preparedSources,
    },
  };
}

async function upsertAudit(
  ctx: MutationCtx,
  options: {
    attestationOperationId: string;
    eventId: Id<"events">;
    evidenceDigest: string;
    outcome: "quarantined" | "reattested";
    reason?: string;
    sourceCount: number;
  },
): Promise<void> {
  const rows = await ctx.db
    .query("campaignLineageReattestations")
    .withIndex("by_migration_event", (q) =>
      q
        .eq("migrationKey", CAMPAIGN_LINEAGE_REATTESTATION_KEY)
        .eq("eventId", options.eventId),
    )
    .take(2);
  if (rows.length > 1) {
    throw new Error("Campaign lineage re-attestation audit is not unique.");
  }
  const now = Date.now();
  const row = {
    attestationOperationId: options.attestationOperationId,
    evidenceDigest: options.evidenceDigest,
    outcome: options.outcome,
    ...(options.reason ? { reason: options.reason } : { reason: undefined }),
    sourceCount: options.sourceCount,
    updatedAt: now,
  } as const;
  if (rows[0]) {
    await ctx.db.patch(rows[0]._id, row);
  } else {
    await ctx.db.insert("campaignLineageReattestations", {
      ...row,
      migrationKey: CAMPAIGN_LINEAGE_REATTESTATION_KEY,
      eventId: options.eventId,
      createdAt: now,
    });
  }
}

async function applyCampaign(
  ctx: MutationCtx,
  prepared: PreparedCampaign,
): Promise<boolean> {
  const now = Date.now();
  const nextPrimaryUpdatedAt = Math.max(now, prepared.primary.updatedAt + 1);
  const nextSources = [...prepared.attestation.sources];
  let topologyChanged = false;
  let eventBindingChanged = false;
  for (let index = 0; index < prepared.sources.length; index += 1) {
    const source = prepared.sources[index]!;
    const sourceEventPatch = campaignSourceEventBindingPatch(source);
    if (!patchMatches(source.sourceEvent, sourceEventPatch)) {
      // These are additive denormalized/index fields. Preserve the attested
      // optimistic version; changing semantic event evidence remains forbidden.
      await ctx.db.patch(source.sourceEvent._id, sourceEventPatch);
      eventBindingChanged = true;
    }
    const occurrenceEvidence = buildCampaignOccurrenceEvidence(
      prepared,
      source,
    );
    const occurrenceChanged = !occurrenceEvidenceMatches(
      source.existingOccurrence,
      occurrenceEvidence,
    );
    const occurrencePatch = { ...occurrenceEvidence, updatedAt: now };
    const occurrenceId = source.existingOccurrence?._id ??
      (await ctx.db.insert("sourceOccurrences", {
        ...occurrencePatch,
        provider: "instagram",
        sourceIdentity: source.link.sourceIdentity,
        sourceOccurrenceKey: source.link.sourceOccurrenceKey,
        occurrenceOrdinal: source.occurrenceOrdinal,
        createdAt: now,
      }));
    if (source.existingOccurrence && occurrenceChanged) {
      await ctx.db.patch(source.existingOccurrence._id, occurrencePatch);
    }
    const nextLinkUpdatedAt =
      source.link.sourceOccurrenceId === occurrenceId &&
      source.link.canonicalSourceUrl === source.canonicalSourceUrl
        ? source.link.updatedAt
        : Math.max(now, source.link.updatedAt + 1);
    if (nextLinkUpdatedAt !== source.link.updatedAt) {
      await ctx.db.patch(source.link._id, {
        canonicalSourceUrl: source.canonicalSourceUrl,
        sourceOccurrenceId: occurrenceId,
        updatedAt: nextLinkUpdatedAt,
      });
    }
    topologyChanged ||=
      !source.existingOccurrence ||
      occurrenceChanged ||
      nextLinkUpdatedAt !== source.link.updatedAt;
    nextSources[index] = {
      ...nextSources[index]!,
      eventUpdatedAt:
        index === 0 ? nextPrimaryUpdatedAt : nextSources[index]!.eventUpdatedAt,
      sourceLinkUpdatedAt: nextLinkUpdatedAt,
    };
  }
  const nextAttestation: CrossPostCampaignAggregateAttestation = {
    ...prepared.attestation,
    sources: nextSources,
  };
  const normalizedFieldsJson = JSON.stringify({
    ...prepared.fields,
    [CROSS_POST_CAMPAIGN_AGGREGATE_ATTESTATION_FIELD]: nextAttestation,
  });
  if (normalizedFieldsJson !== prepared.primary.normalizedFieldsJson) {
    await ctx.db.patch(prepared.primary._id, {
      normalizedFieldsJson,
      updatedAt: nextPrimaryUpdatedAt,
    });
  }
  if (topologyChanged) {
    await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
  }
  // The proof row and the materialized topology are one transaction. Publish
  // only after the proof is visible to canonical grounding.
  await upsertAudit(ctx, {
    attestationOperationId: prepared.attestation.operationId,
    eventId: prepared.primary._id,
    evidenceDigest: prepared.evidenceDigest,
    outcome: "reattested",
    sourceCount: prepared.sources.length,
  });
  await refreshEventPublicationStates(ctx, [prepared.primary._id]);
  return (
    topologyChanged ||
    eventBindingChanged ||
    normalizedFieldsJson !== prepared.primary.normalizedFieldsJson
  );
}

async function loadMigrationState(
  ctx: MutationCtx,
): Promise<Doc<"eventDomainMigrationState"> | null> {
  const rows = await ctx.db
    .query("eventDomainMigrationState")
    .withIndex("by_key", (q) => q.eq("key", CAMPAIGN_LINEAGE_REATTESTATION_KEY))
    .take(2);
  if (rows.length > 1) {
    throw new Error("Campaign lineage migration state is not unique.");
  }
  return rows[0] ?? null;
}

export const reattestCampaignLineageBatch = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    dryRun: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    restartCompleted: v.optional(v.boolean()),
  },
  returns: v.object({
    alreadyReattestedCount: v.number(),
    continueCursor: v.string(),
    dryRun: v.boolean(),
    isDone: v.boolean(),
    quarantinedCount: v.number(),
    reattestedCount: v.number(),
    scannedCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const state = dryRun ? null : await loadMigrationState(ctx);
    const restartCompleted = args.restartCompleted ?? false;
    if (!dryRun && !state && args.cursor) {
      throw new Error("Tracked campaign lineage migration must start at the first page.");
    }
    if (
      !dryRun &&
      state &&
      !restartCompleted &&
      args.cursor !== undefined &&
      (args.cursor ?? null) !== (state.cursor ?? null)
    ) {
      throw new Error(
        "Campaign lineage migration cursor does not match durable state.",
      );
    }
    if (restartCompleted && state && !state.isDone) {
      throw new Error("Only a completed campaign lineage migration can be restarted.");
    }
    if (!dryRun && state?.isDone && !restartCompleted) {
      throw new Error("Campaign lineage migration is complete; restart explicitly to audit again.");
    }
    if (!dryRun && state && !state.isDone && !state.cursor) {
      throw new Error("In-progress campaign lineage migration has no cursor.");
    }
    const cursor = dryRun
      ? args.cursor ?? null
      : restartCompleted
        ? null
        : state?.cursor ?? null;
    const page = await ctx.db.query("events").order("asc").paginate({
      cursor,
      numItems: normalizeBatchSize(args.limit),
    });
    let alreadyReattestedCount = 0;
    let quarantinedCount = 0;
    let reattestedCount = 0;
    for (const event of page.page) {
      const result = await prepareCampaign(ctx, event);
      if (result.kind === "not_campaign") continue;
      if (result.kind === "quarantined") {
        quarantinedCount += 1;
        if (!dryRun) {
          await upsertAudit(ctx, {
            attestationOperationId: result.operationId,
            eventId: event._id,
            evidenceDigest: digestOccurrenceSignature(
              `${String(event._id)}|${result.operationId}|${result.reason}`,
            ),
            outcome: "quarantined",
            reason: result.reason,
            sourceCount: result.sourceCount,
          });
        }
        continue;
      }
      const fullyMaterialized = result.prepared.sources.every(
        (source) =>
          patchMatches(
            source.sourceEvent,
            campaignSourceEventBindingPatch(source),
          ) &&
          occurrenceEvidenceMatches(
            source.existingOccurrence,
            buildCampaignOccurrenceEvidence(result.prepared, source),
          ) &&
          source.link.sourceOccurrenceId === source.existingOccurrence?._id &&
          source.link.canonicalSourceUrl === source.canonicalSourceUrl,
      );
      if (fullyMaterialized) {
        alreadyReattestedCount += 1;
        if (!dryRun) {
          await upsertAudit(ctx, {
            attestationOperationId: result.prepared.attestation.operationId,
            eventId: event._id,
            evidenceDigest: result.prepared.evidenceDigest,
            outcome: "reattested",
            sourceCount: result.prepared.sources.length,
          });
          // Repairs runs produced by the pre-proof ordering may already have
          // materialized occurrences but a stale hidden publication state.
          await refreshEventPublicationStates(ctx, [event._id]);
        }
        continue;
      }
      reattestedCount += 1;
      if (!dryRun) await applyCampaign(ctx, result.prepared);
    }
    if (!page.isDone && !page.continueCursor) {
      throw new Error("Campaign lineage migration pagination did not advance.");
    }
    if (!dryRun) {
      const now = Date.now();
      const baseScanned = restartCompleted ? 0 : state?.scannedCount ?? 0;
      const baseUpdated = restartCompleted ? 0 : state?.updatedCount ?? 0;
      const baseMismatch = restartCompleted ? 0 : state?.mismatchCount ?? 0;
      const next = {
        key: CAMPAIGN_LINEAGE_REATTESTATION_KEY,
        phase: page.isDone
          ? quarantinedCount + baseMismatch > 0
            ? "quarantined"
            : "complete"
          : "reattestation",
        cursor: page.isDone ? undefined : page.continueCursor,
        isDone: page.isDone,
        scannedCount: baseScanned + page.page.length,
        updatedCount: baseUpdated + reattestedCount,
        mismatchCount: baseMismatch + quarantinedCount,
        unchangedCount:
          (restartCompleted ? 0 : state?.unchangedCount ?? 0) +
          alreadyReattestedCount,
        quarantinedLineageMarkerCount: baseMismatch + quarantinedCount,
        completedAt: page.isDone ? now : undefined,
        updatedAt: now,
      } as const;
      if (state) {
        await ctx.db.patch(state._id, next);
      } else {
        await ctx.db.insert("eventDomainMigrationState", {
          ...next,
          createdAt: now,
        });
      }
    }
    return {
      alreadyReattestedCount,
      continueCursor: page.continueCursor,
      dryRun,
      isDone: page.isDone,
      quarantinedCount,
      reattestedCount,
      scannedCount: page.page.length,
    };
  },
});
