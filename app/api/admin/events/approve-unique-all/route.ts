import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { requireAdminApiAccess } from "@/lib/auth/admin-api";
import { createAuthenticatedConvexHttpClient } from "@/lib/convex/server";
import { buildSameDateModerationBatches } from "@/lib/events/moderation-uniqueness-batches";

type ApprovalRequestBody = {
  moderationNote?: string;
};

type PendingEventVersion = {
  _id: string;
  date: string;
  updatedAt: number;
};

type PendingEventPage = {
  continueCursor: string;
  isDone: boolean;
  page: PendingEventVersion[];
  pageStatus?: string;
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
const UNIQUE_APPROVAL_CHUNK_SIZE = 10;
const MIN_MODERATION_NOTE_LENGTH = 20;
const MAX_MODERATION_NOTE_LENGTH = 1_000;

const listByStatusPaginatedQuery =
  "events:listByStatusPaginated" as unknown as FunctionReference<"query">;
const classifyPendingModerationUniquenessQuery =
  "events:classifyPendingModerationUniqueness" as unknown as FunctionReference<"query">;
const approveUniquePendingEventsMutation =
  "events:approveUniquePendingEvents" as unknown as FunctionReference<"mutation">;

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
    (result.pageStatus !== undefined && typeof result.pageStatus !== "string")
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
      !Number.isSafeInteger(event.updatedAt)
    ) {
      throw new Error("Invalid pending event version response.");
    }
    return {
      _id: event._id,
      date: event.date,
      updatedAt: event.updatedAt as number,
    };
  });

  return {
    continueCursor: result.continueCursor,
    isDone: result.isDone,
    page,
    pageStatus: result.pageStatus,
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

  let reviewedCount = 0;
  let approvedCount = 0;
  let skippedDuringApprovalCount = 0;

  try {
    const convex = await createAuthenticatedConvexHttpClient();
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

    const classificationAsOfMs = Date.now();
    const classifications: PendingUniquenessItem[] = [];
    const classificationChunks = buildSameDateModerationBatches(
      pendingVersions,
      UNIQUE_APPROVAL_CHUNK_SIZE,
    );
    for (const chunk of classificationChunks) {
      const expectedVersionById = new Map(
        chunk.map((event) => [event._id, event.updatedAt] as const),
      );
      const rawClassification = await convex.query(
        classifyPendingModerationUniquenessQuery,
        {
          items: chunk.map((event) => ({
            id: event._id,
            expectedUpdatedAt: event.updatedAt,
          })),
          asOfMs: classificationAsOfMs,
        },
      );
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
        approvedCount,
        skippedDuringApprovalCount,
      },
      { status: 500 },
    );
  }
}
