import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import {
  assertExpectedEventStatus,
  assertServiceUpdateEventPolicy,
  nextEventUpdatedAt,
} from "../../../lib/events/event-update-precondition";
import { requireAdminOrServiceSecret } from "../../authz";
import type { SourceGroundingReprocessItem } from "../../eventDomain/contracts";
import {
  assertApprovalCandidatePolicy,
  assertPersistedServiceSourcePolicy,
} from "../../eventDomain/sourceApproval";
import {
  refreshCanonicalEventDerivedStates,
  writeEventAuditLog,
} from "../../eventDomain/persistence";
import { requireCanonicalInstagramPostUrl } from "../../eventDomain/sourceUrlPolicy";

const MAX_SOURCE_GROUNDING_REPROCESS_BATCH_SIZE = 100;
const SOURCE_GROUNDING_REPROCESS_SOURCE_REASONS = new Set([
  "caption_source_event_mismatch",
  "unverified_core_event_source",
]);
const SOURCE_GROUNDING_REPROCESS_REMOVABLE_REASONS = new Set([
  ...SOURCE_GROUNDING_REPROCESS_SOURCE_REASONS,
  "requires_human_approval",
]);

function readModerationPendingReasons(
  normalizedFieldsJson: string | undefined,
): string[] {
  try {
    const parsed = JSON.parse(normalizedFieldsJson ?? "{}");
    return Array.isArray(parsed?.moderationPendingReasons)
      ? parsed.moderationPendingReasons.filter(
          (reason: unknown): reason is string =>
            typeof reason === "string" && reason.length > 0,
        )
      : [];
  } catch {
    return [];
  }
}

function assertSourceGroundingReprocessReasons(event: Doc<"events">): void {
  const reasons = readModerationPendingReasons(event.normalizedFieldsJson);
  if (
    !reasons.some((reason) =>
      SOURCE_GROUNDING_REPROCESS_SOURCE_REASONS.has(reason),
    )
  ) {
    throw new Error(`Source-grounding hold required for event ${event._id}.`);
  }
  const nonRemovable = reasons.filter(
    (reason) => !SOURCE_GROUNDING_REPROCESS_REMOVABLE_REASONS.has(reason),
  );
  if (nonRemovable.length > 0) {
    throw new Error(
      `Unrelated moderation holds block source-grounding reprocessing for event ${event._id}: ${nonRemovable.join(", ")}.`,
    );
  }
}

export async function reprocessPendingSourceGroundingBatchHandler(
  ctx: MutationCtx,
  args: {
    serviceSecret: string;
    items: SourceGroundingReprocessItem[];
  },
) {
  const { actor, kind } = await requireAdminOrServiceSecret(
    ctx,
    args.serviceSecret,
  );
  if (kind !== "service") {
    throw new Error("Service authentication required.");
  }
  if (args.items.length === 0) {
    throw new Error(
      "Source-grounding reprocessing requires at least one event.",
    );
  }
  if (args.items.length > MAX_SOURCE_GROUNDING_REPROCESS_BATCH_SIZE) {
    throw new Error(
      `Source-grounding reprocessing is limited to ${MAX_SOURCE_GROUNDING_REPROCESS_BATCH_SIZE} events.`,
    );
  }

  const eventIds = new Set<string>();
  const prepared: Array<{
    event: Doc<"events">;
    item: (typeof args.items)[number];
  }> = [];
  for (const item of args.items) {
    if (eventIds.has(item.id)) {
      throw new Error(
        `Duplicate source-grounding reprocess event ID: ${item.id}.`,
      );
    }
    eventIds.add(item.id);
    if (!Number.isSafeInteger(item.expectedUpdatedAt)) {
      throw new Error(`Invalid expectedUpdatedAt for event ${item.id}.`);
    }
    if (item.nextNormalizedFieldsJson === item.expectedNormalizedFieldsJson) {
      throw new Error(
        `Source-grounding attestation did not change for event ${item.id}.`,
      );
    }

    const event = await ctx.db.get(item.id);
    if (!event) {
      throw new Error(`Event not found: ${item.id}.`);
    }
    assertExpectedEventStatus(event.status, "pending");
    if (event.updatedAt !== item.expectedUpdatedAt) {
      throw new Error(`Event changed during reprocessing: ${item.id}.`);
    }
    if (event.normalizedFieldsJson !== item.expectedNormalizedFieldsJson) {
      throw new Error(
        `Normalized fields changed during reprocessing: ${item.id}.`,
      );
    }
    assertSourceGroundingReprocessReasons(event);
    prepared.push({ event, item });
  }

  for (const { event, item } of prepared) {
    if (!event.venueInstagramHandle) {
      throw new Error(
        `Resolved source venue handle required for event ${event._id}.`,
      );
    }
    const policyPatch = {
      status: "approved" as const,
      normalizedFieldsJson: item.nextNormalizedFieldsJson,
    };
    requireCanonicalInstagramPostUrl(
      event.instagramPostUrl,
      `Source-grounding approval ${event._id}`,
    );
    assertServiceUpdateEventPolicy(event.status, policyPatch, event);
    await assertPersistedServiceSourcePolicy(ctx, event);
    await assertApprovalCandidatePolicy(
      ctx,
      { ...event, normalizedFieldsJson: item.nextNormalizedFieldsJson },
      [event._id],
    );
    await ctx.db.patch(event._id, {
      status: "approved",
      normalizedFieldsJson: item.nextNormalizedFieldsJson,
      updatedAt: nextEventUpdatedAt(event.updatedAt),
    });
    await writeEventAuditLog(ctx, event._id, "source_grounding_reprocessed", {
      actor,
      patch: policyPatch,
    });
  }

  await refreshCanonicalEventDerivedStates(
    ctx,
    prepared.map(({ event }) => event._id),
  );

  return {
    updatedCount: prepared.length,
    eventIds: prepared.map(({ event }) => event._id),
  };
}
