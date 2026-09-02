type DateBoundModerationItem = {
  date: string;
};

export function buildSameDateModerationBatches<
  Item extends DateBoundModerationItem,
>(items: Item[], maxBatchSize: number): Item[][] {
  if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize < 1) {
    throw new Error("Moderation batch size must be a positive safe integer.");
  }

  const sortedItems = [...items].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  const batches: Item[][] = [];
  let currentBatch: Item[] = [];

  for (const item of sortedItems) {
    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= maxBatchSize ||
        currentBatch[0].date !== item.date)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
    }
    currentBatch.push(item);
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  return batches;
}
