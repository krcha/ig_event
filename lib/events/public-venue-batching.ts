export const PUBLIC_VENUE_FIELDS_BATCH_SIZE = 100;

export function chunkPublicVenueIds(venueIds: string[]): string[][] {
  const batches: string[][] = [];
  for (let offset = 0; offset < venueIds.length; offset += PUBLIC_VENUE_FIELDS_BATCH_SIZE) {
    batches.push(venueIds.slice(offset, offset + PUBLIC_VENUE_FIELDS_BATCH_SIZE));
  }
  return batches;
}

/** Preserve input order while allowing at most two independent public reads. */
export async function loadPublicVenueBatches<T>(
  batches: readonly string[][],
  load: (ids: string[]) => Promise<T[]>,
): Promise<T[]> {
  const results: T[][] = new Array(batches.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  async function worker() {
    while (!failed && next < batches.length) {
      const index = next++;
      try {
        results[index] = await load(batches[index]);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, batches.length) }, worker));
  if (failed) throw failure;
  return results.flat();
}
