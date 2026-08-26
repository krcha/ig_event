/**
 * Compare JSON-compatible values exactly while treating object member order as
 * insignificant. Convex may canonicalize object keys when it persists a value,
 * whereas an audit snapshot preserves the construction order used by the
 * writer. Arrays remain ordered and every scalar value must still match.
 */
export function exactJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => exactJsonValue(value, right[index]))
    );
  }

  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        exactJsonValue(leftRecord[key], rightRecord[key]),
    )
  );
}
