import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { requireAdminApiAccess } from "@/lib/auth/admin-api";
import {
  createConvexHttpClient,
  requireServiceSecret,
} from "@/lib/convex/server";
import { getPersistedModerationConfidenceScore } from "@/lib/events/moderation-confidence";
import { buildSameDateModerationBatches } from "@/lib/events/moderation-uniqueness-batches";

type ApprovalRequestBody = {
  minConfidence?: number;
  moderationNote?: string;
};

type PendingEventVersion = {
  _id: string;
  date: string;
  updatedAt: number;
  confidenceScore: number | null;
};

type PendingEventPage = {
  continueCursor: string;
  isDone: boolean;
  page: PendingEventVersion[];
  pageStatus?: string | null;
};

type PendingUniquenessDisposition =
  | "unique"
  | "duplicate"
  | "ambiguous"
  | "ineligible"
  | "indeterminate";

type PendingUniquenessItem = {
  id: string;
  expectedUpdatedAt: number;
  disposition: PendingUniquenessDisposition;
  reason: string;
  conflictIds: string[];
};

type PendingUniquenessResult = {
  complete: boolean;
  items: PendingUniquenessItem[];
};

type ApprovalResult = {
  complete: boolean;
  approvedIds: string[];
  skipped: PendingUniquenessItem[];
};

const PENDING_QUEUE_PAGE_SIZE = 25;
const MAX_PENDING_QUEUE_ITEMS = 1_000;
const MAX_UNIQUENESS_CLASSIFICATION_CHUNK_SIZE = 10;
const UNIQUE_APPROVAL_CHUNK_SIZE = 5;
const MIN_MODERATION_NOTE_LENGTH = 20;
const MAX_MODERATION_NOTE_LENGTH = 1_000;

const listByStatusPaginatedQuery =
  "events:listByStatusPaginated" as unknown as FunctionReference<"query">;
const classifyPendingModerationUniquenessQuery =
  "events:classifyPendingModerationUniqueness" as unknown as FunctionReference<"query">;
const approveUniquePendingEventsMutation =
  "events:approveUniquePendingEvents" as unknown as FunctionReference<"mutation">;

function parseJsonObject(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isPendingUniquenessDisposition(
  value: unknown,
): value is PendingUniquenessDisposition {
  return (
    value === "unique" ||
    value === "duplicate" ||
    value === "ambiguous" ||
    value === "ineligible" ||
    value === "indeterminate"
  );
}

function validatePendingEventPage(
  value: unknown,
  pageSize: number,
): PendingEventPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid pending event page response.");
  }
  const result = value as Record<string, unknown>;
  if (
    typeof result.continueCursor !== "string" ||
    typeof result.isDone !== "boolean" ||
    !Array.isArray(result.page) ||
    result.page.length > pageSize ||
    (result.pageStatus !== undefined &&
      result.pageStatus !== null &&
      typeof result.pageStatus !== "string")
  ) {
    throw new Error("Invalid pending event page response.");
  }

  const page = result.page.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid pending event version response.");
    }
    const event = value as Record<string, unknown>;
    if (
      typeof event._id !== "string" ||
      event._id.length === 0 ||
      typeof event.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(event.date) ||
      !Number.isSafeInteger(event.updatedAt) ||
      (event.normalizedFieldsJson !== undefined &&
        event.normalizedFieldsJson !== null &&
        typeof event.normalizedFieldsJson !== "string") ||
      (event.rawExtractionJson !== undefined &&
        event.rawExtractionJson !== null &&
        typeof event.rawExtractionJson !== "string") ||
      (event.imageUrl !== undefined &&
        event.imageUrl !== null &&
        typeof event.imageUrl !== "string")
    ) {
      throw new Error("Invalid pending event version response.");
    }
    return {
      _id: event._id,
      date: event.date,
      updatedAt: event.updatedAt as number,
      confidenceScore: getPersistedModerationConfidenceScore({
        normalizedFields: parseJsonObject(
          event.normalizedFieldsJson as string | null | undefined,
        ),
        rawExtraction: parseJsonObject(
          event.rawExtractionJson as string | null | undefined,
        ),
        hasImage:
          typeof event.imageUrl === "string" && event.imageUrl.length > 0,
      }),
    };
  });

  return {
    continueCursor: result.continueCursor,
    isDone: result.isDone,
    page,
    pageStatus: result.pageStatus as string | null | undefined,
  };
}

function validateUniquenessResult(
  value: unknown,
  expectedVersionById: Map<string, number>,
): PendingUniquenessResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid pending uniqueness response.");
  }
  const result = value as Record<string, unknown>;
  if (typeof result.complete !== "boolean" || !Array.isArray(result.items)) {
    throw new Error("Invalid pending uniqueness response.");
  }

  const items: PendingUniquenessItem[] = [];
  const seenIds = new Set<string>();
  for (const value of result.items) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid pending uniqueness response.");
    }
    const item = value as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      !expectedVersionById.has(item.id) ||
      seenIds.has(item.id) ||
      item.expectedUpdatedAt !== expectedVersionById.get(item.id) ||
      !isPendingUniquenessDisposition(item.disposition) ||
      typeof item.reason !== "string" ||
      item.reason.length === 0 ||
      !Array.isArray(item.conflictIds) ||
      item.conflictIds.some(
        (conflictId) =>
          typeof conflictId !== "string" || conflictId.length === 0,
      )
    ) {
      throw new Error("Invalid pending uniqueness response.");
    }
    seenIds.add(item.id);
    items.push({
      id: item.id,
      expectedUpdatedAt: item.expectedUpdatedAt as number,
      disposition: item.disposition,
      reason: item.reason,
      conflictIds: item.conflictIds as string[],
    });
  }

  if (items.length !== expectedVersionById.size) {
    throw new Error("Pending uniqueness response is incomplete.");
  }

  return { complete: result.complete, items };
}

function validateApprovalResult(
  value: unknown,
  expectedVersionById: Map<string, number>,
): ApprovalResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid unique approval response.");
  }
  const result = value as Record<string, unknown>;
  if (
    typeof result.complete !== "boolean" ||
    !Array.isArray(result.approvedIds) ||
    !Array.isArray(result.skipped)
  ) {
    throw new Error("Invalid unique approval response.");
  }

  const approvedIds = result.approvedIds.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  if (
    approvedIds.length !== result.approvedIds.length ||
    new Set(approvedIds).size !== approvedIds.length ||
    approvedIds.some((id) => !expectedVersionById.has(id))
  ) {
    throw new Error("Invalid unique approval response.");
  }

  const skippedResult = validateUniquenessResult(
    { complete: result.complete, items: result.skipped },
    new Map(
      [...expectedVersionById].filter(([id]) => !approvedIds.includes(id)),
    ),
  );
  if (
    approvedIds.length + skippedResult.items.length !==
    expectedVersionById.size
  ) {
    throw new Error("Invalid unique approval response.");
  }

  return {
    complete: result.complete,
    approvedIds,
    skipped: skippedResult.items,
  };
}

function emptyDispositionCounts(): Record<PendingUniquenessDisposition, number> {
  return {
    unique: 0,
    duplicate: 0,
    ambiguous: 0,
    ineligible: 0,
    indeterminate: 0,
  };
}

export async function POST(request: Request) {
  const adminAccess = await requireAdminApiAccess();
  if (!adminAccess.ok) {
    return adminAccess.response;
  }
  const reviewedBy = adminAccess.userId;
  if (!reviewedBy) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: ApprovalRequestBody;
  try {
    body = (await request.json()) as ApprovalRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const moderationNote = body.moderationNote?.trim() || "";
  if (
    moderationNote.length < MIN_MODERATION_NOTE_LENGTH ||
    moderationNote.length > MAX_MODERATION_NOTE_LENGTH
  ) {
    return NextResponse.json(
      { error: "Approval note must contain 20-1000 characters." },
      { status: 400 },
    );
  }

  const minimumConfidence = body.minConfidence;
  if (
    minimumConfidence !== undefined &&
    (typeof minimumConfidence !== "number" ||
      !Number.isFinite(minimumConfidence) ||
      minimumConfidence < 0 ||
      minimumConfidence > 1)
  ) {
    return NextResponse.json(
      { error: "Minimum confidence must be a number from 0 through 1." },
      { status: 400 },
    );
  }

  let reviewedCount = 0;
  let approvedCount = 0;
  let skippedDuringApprovalCount = 0;
  let confidenceEligibleCount = 0;
  let belowConfidenceCount = 0;
  let classificationSplitCount = 0;

  try {
    const serviceSecret = requireServiceSecret();
    const convex = createConvexHttpClient();
    const pendingVersions: PendingEventVersion[] = [];
    const seenPendingIds = new Set<string>();
    let cursor: string | null = null;
    let queueComplete = false;

    for (
      let pageNumber = 0;
      pageNumber < Math.ceil(MAX_PENDING_QUEUE_ITEMS / PENDING_QUEUE_PAGE_SIZE);
      pageNumber += 1
    ) {
      const rawPage = await convex.query(listByStatusPaginatedQuery, {
        status: "pending",
        serviceSecret,
        paginationOpts: {
          cursor,
          numItems: PENDING_QUEUE_PAGE_SIZE,
        },
      });
      const page = validatePendingEventPage(rawPage, PENDING_QUEUE_PAGE_SIZE);
      if (page.pageStatus === "SplitRequired") {
        throw new Error(
          "Pending queue pagination requires a split; no approval was started.",
        );
      }
      for (const event of page.page) {
        if (seenPendingIds.has(event._id)) {
          throw new Error(
            "Pending queue returned a duplicate event; no approval was started.",
          );
        }
        seenPendingIds.add(event._id);
        pendingVersions.push(event);
      }
      if (page.isDone) {
        queueComplete = true;
        break;
      }
      if (!page.continueCursor || page.continueCursor === cursor) {
        throw new Error(
          "Pending queue pagination cursor stalled; no approval was started.",
        );
      }
      cursor = page.continueCursor;
    }

    if (!queueComplete) {
      throw new Error(
        `Pending queue exceeds the safe full-approval bound of ${MAX_PENDING_QUEUE_ITEMS}; no approval was started.`,
      );
    }
    reviewedCount = pendingVersions.length;
    const confidenceEligibleVersions =
      minimumConfidence === undefined
        ? pendingVersions
        : pendingVersions.filter(
            (event) =>
              event.confidenceScore !== null &&
              event.confidenceScore >= minimumConfidence,
          );
    confidenceEligibleCount = confidenceEligibleVersions.length;
    belowConfidenceCount = reviewedCount - confidenceEligibleCount;

    const classificationAsOfMs = Date.now();
    const classifications: PendingUniquenessItem[] = [];
    const classificationChunks = buildSameDateModerationBatches(
      confidenceEligibleVersions,
      MAX_UNIQUENESS_CLASSIFICATION_CHUNK_SIZE,
    );
    while (classificationChunks.length > 0) {
      const chunk = classificationChunks.shift();
      if (!chunk) {
        throw new Error("Pending uniqueness classification queue is invalid.");
      }
      const expectedVersionById = new Map(
        chunk.map((event) => [event._id, event.updatedAt] as const),
      );
      let rawClassification: unknown;
      try {
        rawClassification = await convex.query(
          classifyPendingModerationUniquenessQuery,
          {
            items: chunk.map((event) => ({
              id: event._id,
              expectedUpdatedAt: event.updatedAt,
            })),
            asOfMs: classificationAsOfMs,
            serviceSecret,
          },
        );
      } catch (error) {
        if (chunk.length === 1) {
          throw error;
        }
        const midpoint = Math.ceil(chunk.length / 2);
        classificationChunks.unshift(
          chunk.slice(0, midpoint),
          chunk.slice(midpoint),
        );
        classificationSplitCount += 1;
        continue;
      }
      const classification = validateUniquenessResult(
        rawClassification,
        expectedVersionById,
      );
      if (!classification.complete) {
        throw new Error(
          "Full pending uniqueness classification is incomplete; no approval was started.",
        );
      }
      classifications.push(...classification.items);
    }

    const dispositionCounts = emptyDispositionCounts();
    for (const item of classifications) {
      dispositionCounts[item.disposition] += 1;
    }
    const uniqueItems = classifications.filter(
      (item) => item.disposition === "unique",
    );

    for (
      let index = 0;
      index < uniqueItems.length;
      index += UNIQUE_APPROVAL_CHUNK_SIZE
    ) {
      const chunk = uniqueItems.slice(
        index,
        index + UNIQUE_APPROVAL_CHUNK_SIZE,
      );
      const expectedVersionById = new Map(
        chunk.map((item) => [item.id, item.expectedUpdatedAt] as const),
      );
      const rawApproval = await convex.mutation(
        approveUniquePendingEventsMutation,
        {
          items: chunk.map((item) => ({
            id: item.id,
            expectedUpdatedAt: item.expectedUpdatedAt,
          })),
          moderationNote,
          reviewedBy,
          serviceSecret,
        },
      );
      const approval = validateApprovalResult(rawApproval, expectedVersionById);
      if (!approval.complete) {
        throw new Error(
          `Unique approval stopped after ${approvedCount} confirmed approvals because a batch became indeterminate.`,
        );
      }
      approvedCount += approval.approvedIds.length;
      skippedDuringApprovalCount += approval.skipped.length;
    }

    return NextResponse.json({
      ok: true,
      complete: true,
      reviewedCount,
      minimumConfidence: minimumConfidence ?? null,
      confidenceEligibleCount,
      belowConfidenceCount,
      classificationSplitCount,
      dispositionCounts,
      approvedCount,
      skippedDuringApprovalCount,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to approve the complete unique pending queue.",
        complete: false,
        reviewedCount,
        minimumConfidence: minimumConfidence ?? null,
        confidenceEligibleCount,
        belowConfidenceCount,
        classificationSplitCount,
        approvedCount,
        skippedDuringApprovalCount,
      },
      { status: 500 },
    );
  }
}
