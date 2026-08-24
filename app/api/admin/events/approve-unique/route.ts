import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { requireAdminApiAccess } from "@/lib/auth/admin-api";
import { createAuthenticatedConvexHttpClient } from "@/lib/convex/server";

type ApprovalItem = {
  eventId?: string;
  expectedUpdatedAt?: number;
};

type ApprovalRequestBody = {
  items?: ApprovalItem[];
  moderationNote?: string;
};

type PendingUniquenessDisposition =
  | "unique"
  | "duplicate"
  | "ambiguous"
  | "ineligible"
  | "indeterminate";

type SkippedApproval = {
  id: string;
  expectedUpdatedAt: number;
  disposition: PendingUniquenessDisposition;
  reason: string;
  conflictIds: string[];
};

type ApprovalResult = {
  complete: boolean;
  approvedIds: string[];
  skipped: SkippedApproval[];
};

const MAX_UNIQUE_APPROVAL_ITEMS = 10;
const MIN_MODERATION_NOTE_LENGTH = 20;
const MAX_MODERATION_NOTE_LENGTH = 1_000;

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

function validateApprovalResult(
  value: unknown,
  expectedVersionById: Map<string, number>,
): ApprovalResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid unique pending approval response.");
  }
  const result = value as Record<string, unknown>;
  if (
    typeof result.complete !== "boolean" ||
    !Array.isArray(result.approvedIds) ||
    !Array.isArray(result.skipped)
  ) {
    throw new Error("Invalid unique pending approval response.");
  }

  const approvedIds = result.approvedIds.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  if (
    approvedIds.length !== result.approvedIds.length ||
    new Set(approvedIds).size !== approvedIds.length ||
    approvedIds.some((id) => !expectedVersionById.has(id))
  ) {
    throw new Error("Invalid unique pending approval response.");
  }

  const skipped: SkippedApproval[] = [];
  const skippedIds = new Set<string>();
  for (const rawItem of result.skipped) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      throw new Error("Invalid unique pending approval response.");
    }
    const item = rawItem as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      !expectedVersionById.has(item.id) ||
      skippedIds.has(item.id) ||
      item.expectedUpdatedAt !== expectedVersionById.get(item.id) ||
      !Number.isSafeInteger(item.expectedUpdatedAt) ||
      !isPendingUniquenessDisposition(item.disposition) ||
      typeof item.reason !== "string" ||
      item.reason.length === 0 ||
      !Array.isArray(item.conflictIds) ||
      item.conflictIds.some((id) => typeof id !== "string" || id.length === 0)
    ) {
      throw new Error("Invalid unique pending approval response.");
    }
    skippedIds.add(item.id);
    skipped.push({
      id: item.id,
      expectedUpdatedAt: item.expectedUpdatedAt as number,
      disposition: item.disposition,
      reason: item.reason,
      conflictIds: item.conflictIds as string[],
    });
  }

  if (
    approvedIds.some((id) => skippedIds.has(id)) ||
    approvedIds.length + skipped.length !== expectedVersionById.size ||
    result.complete === false && approvedIds.length > 0
  ) {
    throw new Error("Invalid unique pending approval response.");
  }

  return {
    complete: result.complete,
    approvedIds,
    skipped,
  };
}

function isVersionConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Event changed since the reviewed version:/iu.test(error.message)
  );
}

function isIncompleteClassification(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:uniqueness|unique pending).*(?:incomplete|indeterminate|safety limit)/iu.test(
      error.message,
    )
  );
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

  if (
    !Array.isArray(body.items) ||
    body.items.length === 0 ||
    body.items.length > MAX_UNIQUE_APPROVAL_ITEMS
  ) {
    return NextResponse.json(
      { error: "Unique pending approval requires 1-10 events." },
      { status: 400 },
    );
  }

  const items = body.items.map((item) => ({
    id: item.eventId?.trim() || "",
    expectedUpdatedAt: item.expectedUpdatedAt,
  }));
  const itemIds = new Set(items.map((item) => item.id));
  if (
    itemIds.size !== items.length ||
    items.some(
      (item) => !item.id || !Number.isSafeInteger(item.expectedUpdatedAt),
    )
  ) {
    return NextResponse.json(
      {
        error:
          "Each event requires one unique ID and its exact reviewed version.",
      },
      { status: 400 },
    );
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

  try {
    const convex = await createAuthenticatedConvexHttpClient();
    const rawResult = await convex.mutation(approveUniquePendingEventsMutation, {
      items: items.map((item) => ({
        id: item.id,
        expectedUpdatedAt: item.expectedUpdatedAt as number,
      })),
      moderationNote,
    });
    const result = validateApprovalResult(
      rawResult,
      new Map(
        items.map((item) => [item.id, item.expectedUpdatedAt as number] as const),
      ),
    );

    if (!result.complete) {
      return NextResponse.json(
        {
          ...result,
          error:
            "Server uniqueness classification is incomplete; no unchecked approval is allowed.",
        },
        { status: 422 },
      );
    }

    return NextResponse.json({
      ok: true,
      complete: true,
      approvedIds: result.approvedIds,
      skipped: result.skipped,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to approve unique pending events.",
      },
      {
        status: isVersionConflict(error)
          ? 409
          : isIncompleteClassification(error)
            ? 422
            : 500,
      },
    );
  }
}
