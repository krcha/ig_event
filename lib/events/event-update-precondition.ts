export type EventStatusPrecondition = "pending" | "approved" | "rejected";

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
