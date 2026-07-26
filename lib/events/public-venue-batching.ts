export const PUBLIC_VENUE_FIELDS_BATCH_SIZE = 100;

export function chunkPublicVenueIds(venueIds: string[]): string[][] {
  const batches: string[][] = [];
  for (let offset = 0; offset < venueIds.length; offset += PUBLIC_VENUE_FIELDS_BATCH_SIZE) {
    batches.push(venueIds.slice(offset, offset + PUBLIC_VENUE_FIELDS_BATCH_SIZE));
  }
  return batches;
}
