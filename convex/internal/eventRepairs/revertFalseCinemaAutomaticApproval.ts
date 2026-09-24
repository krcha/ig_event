import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { adaptInstagramScrapedPostToSourceDocument } from "../../../lib/domain/source-documents";
import { buildInstagramSourceOccurrenceFingerprint } from "../../../lib/domain/occurrences/source-fingerprint";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../../lib/events/source-occurrence-representation";
import { nextEventUpdatedAt } from "../../../lib/events/event-update-precondition";
import { normalizeHandle } from "../../../lib/pipeline/venue-normalization";
import { requireAdminOrServiceSecret } from "../../authz";
import {
  refreshCanonicalEventDerivedStates,
  writeEventAuditLog,
} from "../../eventDomain/persistence";
import { assertExistingSourceOccurrenceReceiptWithinBounds } from "../sourceOccurrenceReceipts";

const SOURCE_IDENTITY = "instagram-source-identity-v1:Ddli2yVFbp3";
const SOURCE_HANDLE = "kulturni_centar_beograda";
const POST_ID = "3991749943207770743";
const RECEIPT_ID = "mh75d6rya6k597g4639w2we9ss8ezydx";
const EVENT_IDS = [
  "j574fb8vtkvxv039pzvknamq458ey23a",
  "j5773jdyck0k1sp39h9y55g7g98ezd5j",
  "j5781tvm1qjdyehn625kmjvc7x8ey9x8",
  "j57c0hgkd60ksyr3g5jb63wpqs8eynp4",
] as const;

type ReadCtx = QueryCtx | MutationCtx;
type Version = {
  id: Id<"events">;
  expectedUpdatedAt: number;
  expectedNormalizedFieldsJson: string;
  expectedSourceLinkId: Id<"instagramEventSources">;
  expectedSourceLinkUpdatedAt: number;
};

function parseObject(value: string | undefined): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value ?? "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function sourceNamesTheOtherFilm(caption: string): boolean {
  const normalized = caption.normalize("NFKC").toLocaleUpperCase("sr-Latn")
    .replace(/\s+/gu, " ");
  return normalized.includes("I SINOVI") && !normalized.includes("I I SINOVI");
}

async function loadExactSourceAndReceipt(ctx: ReadCtx) {
  const [sourceRows, receiptRows] = await Promise.all([
    ctx.db.query("scrapedPosts")
      .withIndex("by_handle_postId", (q) =>
        q.eq("handle", SOURCE_HANDLE).eq("postId", POST_ID))
      .take(2),
    ctx.db.query("instagramSourceOccurrenceReceipts")
      .withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", SOURCE_IDENTITY))
      .take(2),
  ]);
  const source = sourceRows.length === 1 ? sourceRows[0] : null;
  const receipt = receiptRows.length === 1 ? receiptRows[0] : null;
  if (!source || !receipt || receipt._id !== RECEIPT_ID) {
    throw new Error("The reviewed cinema source or receipt is missing or ambiguous.");
  }
  assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
  const fingerprint = buildInstagramSourceOccurrenceFingerprint(source);
  if (
    normalizeHandle(source.username) !== SOURCE_HANDLE ||
    adaptInstagramScrapedPostToSourceDocument(source).sourceIdentity !== SOURCE_IDENTITY ||
    source.analysisRevision !== (source.sourceRevision ?? 1) ||
    source.analysisContractVersion !== "event_evidence_v2" ||
    source.analysisIsEvent !== true ||
    !source.analysisModel?.startsWith("gpt-5-mini") ||
    !source.analysisResultJson ||
    !source.caption ||
    !sourceNamesTheOtherFilm(source.caption) ||
    receipt.sourceFingerprint !== fingerprint ||
    receipt.deferredChildCount !== 0 ||
    receipt.deferredChildKeys.length !== 0 ||
    !receipt.expectedOccurrences ||
    receipt.expectedOccurrences.length !== receipt.expectedKeys.length ||
    receipt.satisfiedOccurrences.length !== receipt.expectedKeys.length ||
    receipt.satisfiedKeys.length !== receipt.expectedKeys.length
  ) {
    throw new Error("The reviewed cinema source is not the current complete analysis generation.");
  }
  return { source, receipt, fingerprint };
}

async function loadExactCandidate(
  ctx: ReadCtx,
  source: Doc<"scrapedPosts">,
  receipt: Doc<"instagramSourceOccurrenceReceipts">,
  id: Id<"events">,
) {
  const event = await ctx.db.get(id);
  const links = await ctx.db.query("instagramEventSources")
    .withIndex("by_event", (q) => q.eq("eventId", id)).take(2);
  const link = links.length === 1 ? links[0] : null;
  const fields = parseObject(event?.normalizedFieldsJson);
  const raw = parseObject(event?.rawExtractionJson);
  const splitIndex = fields?.splitEventIndex;
  const rows = raw?.schedule_entries;
  const row = Array.isArray(rows) && Number.isSafeInteger(splitIndex) &&
    Number(splitIndex) >= 1 ? rows[Number(splitIndex) - 1] : null;
  const rowFields = row && typeof row === "object" && !Array.isArray(row)
    ? row as Record<string, unknown> : null;
  const expected = receipt.expectedOccurrences?.filter((item) =>
    item.key === link?.sourceOccurrenceKey) ?? [];
  const satisfied = receipt.satisfiedOccurrences.filter((item) =>
    item.key === link?.sourceOccurrenceKey && item.eventId === id);
  const occurrence = link?.sourceOccurrenceId
    ? await ctx.db.get(link.sourceOccurrenceId)
    : null;
  if (
    !event || !link || !fields || !raw || !rowFields ||
    !EVENT_IDS.includes(String(id) as typeof EVENT_IDS[number]) ||
    event.status !== "approved" ||
    event.automaticUniqueApprovalPolicyVersion !== 1 ||
    event.humanReviewedLegacySourcePolicyVersion !== undefined ||
    event.humanReviewedStructuredSourcePolicyVersion !== undefined ||
    event.reviewedAt !== undefined || event.reviewedBy !== undefined ||
    event.title !== "I I SINOVI" ||
    event.instagramPostId !== POST_ID ||
    event.rawExtractionJson !== source.analysisResultJson ||
    event.sourceCaption !== source.caption ||
    event.sourcePostedAt !== source.postedAt ||
    fields.extractionContractVersion !== "event_evidence_v2" ||
    fields.extractionIsEvent !== true ||
    fields.sourceGroundingInstagramHandle !== SOURCE_HANDLE ||
    fields.sourceOccurrenceKey !== event.sourceOccurrenceKey ||
    fields.sourceOccurrenceSourceFingerprint !== receipt.sourceFingerprint ||
    fields.automaticUniqueApprovalPolicyVersion !== 1 ||
    fields.moderationAutoApproved !== true ||
    fields.moderationAutoApproveRule !== "server_verified_unique_v1" ||
    fields.identityEvidenceVerified !== false ||
    fields.structuredEvidenceVerified !== false ||
    fields.rowSourceText !== "20:00 I I SINOVI" ||
    rowFields.source_text !== fields.rowSourceText ||
    rowFields.title !== event.title ||
    !rowFields.date_evidence ||
    typeof rowFields.date_evidence !== "object" ||
    (rowFields.date_evidence as Record<string, unknown>).resolved_date !== event.date ||
    link.sourceIdentity !== SOURCE_IDENTITY ||
    link.sourceFingerprint !== receipt.sourceFingerprint ||
    link.eventId !== id ||
    link.sourceOccurrenceKey !== event.sourceOccurrenceKey ||
    expected.length !== 1 || satisfied.length !== 1 ||
    !sourceOccurrenceRepresentativeMatchesExpected(event, expected[0]) ||
    !occurrence || occurrence.state !== "satisfied" ||
    occurrence.canonicalEventId !== id ||
    occurrence.sourceDocumentId !== source._id ||
    occurrence.sourceRevision !== (source.sourceRevision ?? 1) ||
    occurrence.sourceIdentity !== SOURCE_IDENTITY ||
    occurrence.sourceFingerprint !== receipt.sourceFingerprint ||
    occurrence.sourceOccurrenceKey !== link.sourceOccurrenceKey
  ) {
    throw new Error(`The reviewed false cinema approval changed: ${id}.`);
  }
  return { event, link, fields };
}

async function loadPlan(ctx: ReadCtx) {
  const { source, receipt } = await loadExactSourceAndReceipt(ctx);
  const candidates = [];
  for (const id of EVENT_IDS) {
    candidates.push(await loadExactCandidate(ctx, source, receipt, id as Id<"events">));
  }
  return { source, receipt, candidates };
}

export async function previewFalseCinemaAutomaticApprovalReversalHandler(
  ctx: QueryCtx,
  args: { serviceSecret: string },
) {
  const authorization = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  if (authorization.kind !== "service") {
    throw new Error("False cinema approval reversal requires service authentication.");
  }
  const plan = await loadPlan(ctx);
  return {
    sourceIdentity: SOURCE_IDENTITY,
    sourceId: plan.source._id,
    sourceUpdatedAt: plan.source.updatedAt,
    receiptId: plan.receipt._id,
    receiptUpdatedAt: plan.receipt.updatedAt,
    sourceFingerprint: plan.receipt.sourceFingerprint,
    items: plan.candidates.map(({ event, link }) => ({
      id: event._id,
      expectedUpdatedAt: event.updatedAt,
      expectedNormalizedFieldsJson: event.normalizedFieldsJson ?? "",
      expectedSourceLinkId: link._id,
      expectedSourceLinkUpdatedAt: link.updatedAt,
      title: event.title,
      date: event.date,
    })),
  };
}

export async function applyFalseCinemaAutomaticApprovalReversalHandler(
  ctx: MutationCtx,
  args: {
    sourceId: Id<"scrapedPosts">;
    sourceUpdatedAt: number;
    receiptId: Id<"instagramSourceOccurrenceReceipts">;
    receiptUpdatedAt: number;
    sourceFingerprint: string;
    items: Version[];
    serviceSecret: string;
  },
) {
  const authorization = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  if (authorization.kind !== "service") {
    throw new Error("False cinema approval reversal requires service authentication.");
  }
  if (
    args.items.length !== EVENT_IDS.length ||
    new Set(args.items.map((item) => item.id)).size !== EVENT_IDS.length ||
    args.items.some((item) =>
      !EVENT_IDS.includes(String(item.id) as typeof EVENT_IDS[number]) ||
      !Number.isSafeInteger(item.expectedUpdatedAt) ||
      !Number.isSafeInteger(item.expectedSourceLinkUpdatedAt)) ||
    !Number.isSafeInteger(args.sourceUpdatedAt) ||
    !Number.isSafeInteger(args.receiptUpdatedAt)
  ) {
    throw new Error("False cinema approval reversal requires the exact four reviewed versions.");
  }
  const plan = await loadPlan(ctx);
  if (
    plan.source._id !== args.sourceId ||
    plan.source.updatedAt !== args.sourceUpdatedAt ||
    plan.receipt._id !== args.receiptId ||
    plan.receipt.updatedAt !== args.receiptUpdatedAt ||
    plan.receipt.sourceFingerprint !== args.sourceFingerprint
  ) {
    throw new Error("False cinema approval reversal source or receipt version changed.");
  }
  const expectedById = new Map(args.items.map((item) => [item.id, item]));
  for (const { event, link } of plan.candidates) {
    const expected = expectedById.get(event._id);
    if (
      !expected ||
      expected.expectedUpdatedAt !== event.updatedAt ||
      expected.expectedNormalizedFieldsJson !== event.normalizedFieldsJson ||
      expected.expectedSourceLinkId !== link._id ||
      expected.expectedSourceLinkUpdatedAt !== link.updatedAt
    ) {
      throw new Error(`False cinema approval reversal event version changed: ${event._id}.`);
    }
  }
  const updated = [];
  for (const { event, fields } of plan.candidates) {
    const {
      automaticUniqueApprovalPolicyVersion: _automaticMarker,
      automaticUniqueCollisionProofVersion: _collisionMarker,
      ...retainedFields
    } = fields;
    const nextFields = {
      ...retainedFields,
      moderationAutoApproved: false,
      moderationAutoApproveRule: null,
      moderationPendingReasons: ["requires_human_approval", "invalid_identity_evidence"],
      moderationSignals: [...new Set([
        "requires_human_approval",
        ...(Array.isArray(fields.moderationSignals)
          ? fields.moderationSignals.filter((signal): signal is string =>
              typeof signal === "string" &&
              signal !== "requires_human_approval" &&
              signal !== "poster_caption_conflict")
          : []),
        "invalid_identity_evidence",
      ])],
    };
    const updatedAt = nextEventUpdatedAt(event.updatedAt);
    await ctx.db.patch(event._id, {
      status: "pending",
      automaticUniqueApprovalPolicyVersion: undefined,
      normalizedFieldsJson: JSON.stringify(nextFields),
      updatedAt,
    });
    updated.push({ id: event._id, updatedAt });
  }
  await refreshCanonicalEventDerivedStates(ctx, updated.map((item) => item.id));
  for (const item of updated) {
    const event = await ctx.db.get(item.id);
    if (
      !event || event.status !== "pending" ||
      event.automaticUniqueApprovalPolicyVersion !== undefined ||
      event.publicationState === "publishable"
    ) {
      throw new Error(`False cinema approval reversal failed publication proof: ${item.id}.`);
    }
    await writeEventAuditLog(ctx, item.id, "false_automatic_unique_approval_reverted", {
      actor: authorization.actor,
      note: "Current caption names I SINOVI; these four extracted I I SINOVI rows lack verified identity evidence.",
      patch: {
        sourceIdentity: SOURCE_IDENTITY,
        sourcePostId: POST_ID,
        receiptId: plan.receipt._id,
        sourceFingerprint: plan.receipt.sourceFingerprint,
        previousStatus: "approved",
        status: "pending",
        automaticUniqueApprovalPolicyVersion: 1,
      },
    });
  }
  return { updatedCount: updated.length, updated };
}
