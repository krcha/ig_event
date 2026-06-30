export type ModerationQueuePriorityInput = {
  confidenceScore: number | null;
  titleUsedFallback: boolean;
  missingImage: boolean;
  allowMissingImage: boolean;
  missingTime: boolean;
  hasSuspiciousYear: boolean;
  suspectedDuplicateCount: number;
  hasResolvedDuplicate: boolean;
};

export function getModerationQueuePriorityScore(
  event: ModerationQueuePriorityInput,
): number {
  let score = 0;

  if (event.hasResolvedDuplicate) {
    score += 100;
  }
  if (event.suspectedDuplicateCount > 0) {
    score += Math.min(70, 35 + event.suspectedDuplicateCount * 10);
  }
  if (event.hasSuspiciousYear) {
    score += 35;
  }
  if (event.confidenceScore === null) {
    score += 25;
  } else if (event.confidenceScore < 0.7) {
    score += 30;
  } else if (event.confidenceScore < 0.9) {
    score += 10;
  }
  if (event.missingImage && !event.allowMissingImage) {
    score += 20;
  }
  if (event.titleUsedFallback) {
    score += 12;
  }

  return score;
}

export function compareModerationQueuePriority<T extends ModerationQueuePriorityInput & {
  createdAt: number;
  updatedAt: number;
}>(left: T, right: T): number {
  const priorityDelta =
    getModerationQueuePriorityScore(right) - getModerationQueuePriorityScore(left);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const updatedDelta = right.updatedAt - left.updatedAt;
  if (updatedDelta !== 0) {
    return updatedDelta;
  }

  return right.createdAt - left.createdAt;
}
