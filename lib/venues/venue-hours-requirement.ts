import { normalizeTaxonomyText, venueRequiresPhysicalDetails } from "../taxonomy/venue-types.ts";

const THEATER_AND_CINEMA_CATEGORIES = new Set(["bioskop", "cinema", "pozoriste", "teatar", "theater", "theatre"]);

// Reviewed directory profiles that may be stored under the broader "venue" or "culture" category.
const THEATER_AND_CINEMA_HANDLES = new Set([
  "4beograd",
  "akademija28",
  "atelje212",
  "beogradskodramskopozoriste",
  "bioskopbalkan",
  "bitefteatar",
  "conceptcinema_bg",
  "heartefact_",
  "jdpbgd",
  "jugoslovenskakinoteka",
  "kpgteatar",
  "madlenianum",
  "mtsdvorana",
  "narodno_pozoriste_u_beogradu",
  "novi_bioskop_zvezda",
  "pinecone.theater",
  "pozoriste.lutaka.pinokio",
  "pozoristeterazije",
  "reflektor.teatar",
  "scena1.zaduzbina",
  "teatar_ulica",
  "teatar_vuk",
  "teatarlevo",
  "teatarnabrdu",
  "teatarodeonofficial",
  "tuckwoodcineplex",
  "vecernjascena.radovic",
]);

export function venueRequiresOpeningHours(venue: {
  category?: string | null;
  instagramHandle?: string | null;
}): boolean {
  const category = normalizeTaxonomyText(venue.category);
  const handle = venue.instagramHandle?.trim().replace(/^@+/, "").toLowerCase() ?? "";
  return venueRequiresPhysicalDetails(venue.category)
    && !THEATER_AND_CINEMA_CATEGORIES.has(category)
    && !THEATER_AND_CINEMA_HANDLES.has(handle);
}
