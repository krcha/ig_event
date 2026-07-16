export type EventStatusPrecondition = "pending" | "approved" | "rejected";

type EventWritePatch = Record<string, unknown> & {
  status?: EventStatusPrecondition;
};

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
  const changesApprovedRow = Object.entries(patch).some(
    ([field, value]) => field !== "status" && value !== undefined,
  );
  if (keepsEventPublic && changesApprovedRow) {
    throw new Error(
      "Service-authenticated updates must demote an approved event before changing it.",
    );
  }
}
