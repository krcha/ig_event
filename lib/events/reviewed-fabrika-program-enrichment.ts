import { getEventTimeSortMinutes } from "./event-time.ts";

export const FABRIKA_WEEKLY_POST_URL = "https://www.instagram.com/p/Ddi7AbOtCTO/";

export type ReviewedFabrikaProgramNight = "thursday" | "friday" | "saturday";

type ProgramReview = {
  primaryId: string;
  primaryVenueId: string;
  directId: string;
  directUrl: string;
  date: string;
  primaryTitle: string;
  primaryTime: string;
  directTitle: string;
  directTime: string;
  directVenue: string;
  directEventType: string;
  artists: readonly string[];
  captionAnchors: readonly string[];
  priorDescription?: string;
  description: string;
  sourceUpdateText: string;
};

export const FABRIKA_PROGRAM_REVIEWS: Record<ReviewedFabrikaProgramNight, ProgramReview> = {
  thursday: {
    primaryId: "j572dh1yabw86w41kgac4ppnx98ex3je",
    primaryVenueId: "k178xx56eaadyf9x5tarervn3h8993zc",
    directId: "j579m5955n6dmsnzdf6nk6aeks8f10ek",
    directUrl: "https://www.instagram.com/p/Ddo4DGsNlYf/",
    date: "2026-09-24",
    primaryTitle: "DJ NIGHT",
    primaryTime: "21:00-01:00",
    directTitle: "Insta Slinksta, Seratlicp, Pedja Skakavac",
    directTime: "21:00",
    directVenue: "Fabrika Alternativne Kulturne Scene",
    directEventType: "nightlife",
    artists: ["@insta_slinksta", "@seratlicp", "@pedja_skakavac"],
    captionAnchors: ["četvrtak 24.09.", "DJ Night - dub, reggae, ska, raga, dnb", "@insta_slinksta", "@seratlicp", "@pedja_skakavac"],
    priorDescription: "DJ Night: dub, reggae, ska, raga i dnb. Rezidenti: @insta_slinksta, @seratlicp i @pedja_skakavac.",
    description: "DJ Night: dub, reggae, ska, raga i dnb. Rezidenti: @insta_slinksta, @seratlicp i @pedja_skakavac.",
    sourceUpdateText: "Rezidenti: @insta_slinksta, @seratlicp i @pedja_skakavac. Dub, reggae, ska, raga i dnb.",
  },
  friday: {
    primaryId: "j578vvypm195gj20edqg7eks2h8ewvdr",
    primaryVenueId: "k178xx56eaadyf9x5tarervn3h8993zc",
    directId: "j5760s6gmpwmvmgnm9b8yw2ydd8f0196",
    directUrl: "https://www.instagram.com/p/Ddo5jmqtbUd/",
    date: "2026-09-25",
    primaryTitle: "FREYJA'S NIGHT / KONCERT",
    primaryTime: "21:00-03:00",
    directTitle: "FREYA’S NIGHTS",
    directTime: "21:00",
    directVenue: "Radnička 5N, Ada Ciganlija",
    directEventType: "nightlife",
    artists: ["@tona_tozla", "@ana7perisic", "@rakicvule"],
    captionAnchors: ["petak 25.09.", "Freya’s Night - reggae, r&b, drum & bass", "@tona_tozla", "@ana7perisic", "@rakicvule"],
    description: "Freya's Night: reggae, R&B i drum & bass. Nastupaju @tona_tozla, @ana7perisic i @rakicvule.",
    sourceUpdateText: "Nastupaju @tona_tozla, @ana7perisic i @rakicvule. Reggae, R&B i drum & bass.",
  },
  saturday: {
    primaryId: "j57cwmv2pebkd5qd6n1zp03r1x8ex791",
    primaryVenueId: "k178xx56eaadyf9x5tarervn3h8993zc",
    directId: "j57a5kp6f0bbtbkqgvsv5f4czn8f1d84",
    directUrl: "https://www.instagram.com/p/Ddo50o5tWyp/",
    date: "2026-09-26",
    primaryTitle: "KONCERT / DJ NIGHT",
    primaryTime: "21:00-03:00",
    directTitle: "Cvat i Afazija",
    directTime: "21:00",
    directVenue: "Fabrika Alternativne Kulturne Scene",
    directEventType: "live music",
    artists: ["Cvat", "Afazija"],
    captionAnchors: ["subote 26.09.", "ugostimo Cvat i Afaziju", "Koncert - alt rock, post hardcore, punk"],
    description: "Koncert: Cvat i Afazija; alt rock, post hardcore i punk.",
    sourceUpdateText: "Nastupaju Cvat i Afazija. Alt rock, post hardcore i punk.",
  },
};

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
  reviewedSourceUpdate?: { text: string; sourceUrl: string; sourceEventId: string };
};

function comparable(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").trim().toLocaleLowerCase("sr-Latn");
}

/** Exact reviewed direct posts can enrich a weekly card without changing its occurrence identity. */
export function buildReviewedFabrikaProgramEnrichmentPatch(
  night: ReviewedFabrikaProgramNight,
  primary: ReviewedEvent,
  direct: ReviewedEvent,
  persistedCaption: string | undefined,
): {
  description: string;
  ticketPrice: string;
  reviewedSourceUpdate: { text: string; sourceUrl: string; sourceEventId: string };
  alreadyDone: boolean;
} {
  const review = FABRIKA_PROGRAM_REVIEWS[night];
  const caption = comparable(persistedCaption);
  const reviewedArtists = review.artists.map(comparable);
  if (
    primary._id !== review.primaryId ||
    direct._id !== review.directId ||
    primary.status !== "approved" ||
    direct.status !== "pending" ||
    primary.instagramPostUrl !== FABRIKA_WEEKLY_POST_URL ||
    direct.instagramPostUrl !== review.directUrl ||
    primary.title !== review.primaryTitle ||
    direct.title !== review.directTitle ||
    primary.date !== review.date ||
    direct.date !== review.date ||
    primary.time !== review.primaryTime ||
    direct.time !== review.directTime ||
    getEventTimeSortMinutes(primary.time) !== getEventTimeSortMinutes(direct.time) ||
    primary.venueId !== review.primaryVenueId ||
    primary.venue !== "Fabrika Alternativne Kulturne Scene" ||
    direct.venue !== review.directVenue ||
    (direct.venueId !== undefined && direct.venueId !== primary.venueId) ||
    comparable(primary.venueInstagramHandle) !== "faks_beograd" ||
    (direct.venueInstagramHandle !== undefined && comparable(direct.venueInstagramHandle) !== "faks_beograd") ||
    primary.eventType !== "nightlife" ||
    direct.eventType !== review.directEventType ||
    direct.artists.length !== reviewedArtists.length ||
    direct.artists.some((artist, index) => comparable(artist) !== reviewedArtists[index]) ||
    direct.ticketPrice !== "500 rsd" ||
    caption !== comparable(direct.sourceCaption) ||
    !caption.includes("21:00") ||
    !caption.includes("500 rsd") ||
    !caption.includes("radnička 5n") ||
    review.captionAnchors.some((anchor) => !caption.includes(comparable(anchor)))
  ) {
    throw new Error(`Reviewed Fabrika ${night} identity or direct-post evidence changed.`);
  }
  const alreadyDone =
    primary.reviewedSourceUpdate?.text === review.sourceUpdateText &&
    primary.reviewedSourceUpdate?.sourceUrl === review.directUrl &&
    primary.reviewedSourceUpdate?.sourceEventId === review.directId &&
    primary.description === review.description &&
    primary.ticketPrice === "500 RSD";
  if (
    !alreadyDone &&
    (primary.artists.length !== 0 ||
      primary.description !== review.priorDescription ||
      ![undefined, "500 RSD"].includes(primary.ticketPrice) ||
      primary.reviewedSourceUpdate !== undefined)
  ) {
    throw new Error(`Reviewed Fabrika ${night} public details changed before enrichment.`);
  }
  return {
    reviewedSourceUpdate: {
      text: review.sourceUpdateText,
      sourceUrl: review.directUrl,
      sourceEventId: review.directId,
    },
    description: review.description,
    ticketPrice: "500 RSD",
    alreadyDone,
  };
}
