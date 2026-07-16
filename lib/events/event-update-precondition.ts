export type EventStatusPrecondition = "pending" | "approved" | "rejected";

type EventWritePatch = Record<string, unknown> & {
  status?: EventStatusPrecondition;
};

const PUBLIC_EVENT_FIELDS = new Set([
  "title",
  "date",
  "time",
  "timeSource",
  "timeEvidenceText",
  "timeConfidence",
  "timeStatus",
  "venue",
  "artists",
  "description",
  "imageUrl",
  "instagramPostUrl",
  "instagramPostId",
  "ticketPrice",
  "eventType",
  "sourceCaption",
  "promotionTier",
  "promotionStart",
  "promotionEnd",
  "promotionPriority",
]);

export function assertExpectedEventStatus(
  currentStatus: EventStatusPrecondition,
  expectedStatus: EventStatusPrecondition | undefined,
): void {
  if (expectedStatus !== undefined && currentStatus !== expectedStatus) {
    throw new Error(
      `Event status changed during update (expected ${expectedStatus}, found ${currentStatus}).`,
    );
  }
}

export function assertServiceCreateEventPolicy(
  requestedStatus: EventStatusPrecondition | undefined,
): void {
  if (requestedStatus === "approved") {
    throw new Error("Service-authenticated event creation cannot approve an event.");
  }
}

export function assertServiceUpdateEventPolicy(
  currentStatus: EventStatusPrecondition,
  patch: EventWritePatch,
): void {
  if (patch.status === "approved") {
    throw new Error("Service-authenticated event updates cannot approve an event.");
  }

  const keepsEventPublic = currentStatus === "approved" && patch.status === undefined;
  const changesPublicField = Object.keys(patch).some(
    (field) => patch[field] !== undefined && PUBLIC_EVENT_FIELDS.has(field),
  );
  if (keepsEventPublic && changesPublicField) {
    throw new Error(
      "Service-authenticated updates must demote an approved event before changing public fields.",
    );
  }
}
