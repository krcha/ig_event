import type { NightlifeLineupSource } from "../../lib/events/nightlife-lineup-coalescing";

export function parseCoalescingJsonRecord(
  value: string,
  label: string,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the fail-closed error below.
  }
  throw new Error(`${label} must be a JSON object.`);
}

export function readNightlifeLineupSource(
  value: unknown,
): NightlifeLineupSource | null {
  return value === "caption" ||
    value === "poster" ||
    value === "alt_text" ||
    value === "unknown"
    ? value
    : null;
}

export function exactStringSetEquals(left: string[], right: string[]): boolean {
  return (
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.length === right.length &&
    left.every((value) => right.includes(value))
  );
}
