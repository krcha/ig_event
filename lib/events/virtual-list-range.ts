export function virtualListRange(
  range: { startIndex: number; endIndex: number; overscan: number; count: number },
  protectedIndexes: readonly number[] = [],
): number[] {
  const indexes = new Set<number>();
  const add = (index: number) => { if (index >= 0 && index < range.count) indexes.add(index); };
  for (let i = Math.max(0, range.startIndex - range.overscan); i <= Math.min(range.count - 1, range.endIndex + range.overscan); i++) add(i);
  // Keep focus and its Tab neighbours mounted even when the user scrolls away.
  for (const index of protectedIndexes) if (index >= 0) { add(index - 1); add(index); add(index + 1); }
  return [...indexes].sort((left, right) => left - right);
}
