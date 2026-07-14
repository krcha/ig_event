export type PublicEventDetailDataLoaderOptions<EventRecord, VenueRecord> = {
  loadEvent: () => Promise<EventRecord | null>;
  loadVenues: (event: EventRecord) => Promise<VenueRecord[]>;
};

export async function loadPublicEventDetailData<EventRecord, VenueRecord>(
  options: PublicEventDetailDataLoaderOptions<EventRecord, VenueRecord>,
): Promise<{
  event: EventRecord | null;
  venues: VenueRecord[];
}> {
  const event = await options.loadEvent();
  if (!event) {
    return { event: null, venues: [] };
  }

  const venues = await options.loadVenues(event);
  return { event, venues };
}
