import { getEventTimeSortMinutes } from "./event-time.ts";

export const FABRIKA_DJ_NIGHT_PRIMARY_ID = "j572dh1yabw86w41kgac4ppnx98ex3je";
export const FABRIKA_DJ_NIGHT_DIRECT_ID = "j579m5955n6dmsnzdf6nk6aeks8f10ek";
export const FABRIKA_DJ_NIGHT_WEEKLY_URL = "https://www.instagram.com/p/Ddi7AbOtCTO/";
export const FABRIKA_DJ_NIGHT_DIRECT_URL = "https://www.instagram.com/p/Ddo4DGsNlYf/";
export const FABRIKA_DJ_NIGHT_DESCRIPTION =
  "DJ Night: dub, reggae, ska, raga i dnb. Rezidenti: @insta_slinksta, @seratlicp i @pedja_skakavac.";
export const FABRIKA_DJ_NIGHT_TICKET_PRICE = "500 RSD";

type ReviewedEvent = {
  _id: string;
  status: string;
  title: string;
  date: string;
  time?: string;
  venue: string;
  venueId?: string;
  venueInstagramHandle?: string;
  artists: readonly string[];
  eventType: string;
  instagramPostUrl?: string;
  sourceCaption?: string;
  description?: string;
  ticketPrice?: string;
};

function normalize(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").trim().toLocaleLowerCase("sr-Latn");
}

/** One reviewed pair. The direct post is evidence, not a second public card. */
export function buildReviewedFabrikaDjNightEnrichmentPatch(
  primary: ReviewedEvent,
  direct: ReviewedEvent,
  persistedDirectCaption: string | undefined,
): { description: string; ticketPrice: string; alreadyDone: boolean } {
  const caption = normalize(direct.sourceCaption);
  const normalizedArtists = direct.artists.map(normalize);
  const requiredArtists = ["@insta_slinksta", "@seratlicp", "@pedja_skakavac"];
  if (
    primary._id !== FABRIKA_DJ_NIGHT_PRIMARY_ID ||
    direct._id !== FABRIKA_DJ_NIGHT_DIRECT_ID ||
    primary.status !== "approved" ||
    direct.status !== "pending" ||
    primary.instagramPostUrl !== FABRIKA_DJ_NIGHT_WEEKLY_URL ||
    direct.instagramPostUrl !== FABRIKA_DJ_NIGHT_DIRECT_URL ||
    normalize(primary.title) !== "dj night" ||
    primary.date !== "2026-09-24" ||
    direct.date !== primary.date ||
    primary.time !== "21:00-01:00" ||
    direct.time !== "21:00" ||
    getEventTimeSortMinutes(primary.time) !== getEventTimeSortMinutes(direct.time) ||
    !primary.venueId ||
    primary.venueId !== direct.venueId ||
    primary.venue !== "Fabrika Alternativne Kulturne Scene" ||
    direct.venue !== primary.venue ||
    normalize(primary.venueInstagramHandle) !== "faks_beograd" ||
    normalize(direct.venueInstagramHandle) !== "faks_beograd" ||
    primary.eventType !== "nightlife" ||
    direct.eventType !== "nightlife" ||
    primary.artists.length !== 0 ||
    normalizedArtists.length !== requiredArtists.length ||
    requiredArtists.some((artist, index) => normalizedArtists[index] !== artist) ||
    direct.ticketPrice !== "500 rsd" ||
    normalize(persistedDirectCaption) !== caption ||
    !caption.includes("dj night - dub, reggae, ska, raga, dnb") ||
    !caption.includes("četvrtak 24.09.") ||
    !caption.includes("21:00") ||
    !caption.includes("500 rsd") ||
    !caption.includes("radnička 5n") ||
    requiredArtists.some((artist) => !caption.includes(artist))
  ) {
    throw new Error("Reviewed Fabrika DJ Night identity or direct-post evidence changed.");
  }
  const alreadyDone =
    primary.description === FABRIKA_DJ_NIGHT_DESCRIPTION &&
    primary.ticketPrice === FABRIKA_DJ_NIGHT_TICKET_PRICE;
  if (
    !alreadyDone &&
    (primary.description !== undefined || primary.ticketPrice !== undefined)
  ) {
    throw new Error("Reviewed Fabrika DJ Night public details changed before enrichment.");
  }
  return {
    description: FABRIKA_DJ_NIGHT_DESCRIPTION,
    ticketPrice: FABRIKA_DJ_NIGHT_TICKET_PRICE,
    alreadyDone,
  };
}
