/**
 * LEGACY COMPATIBILITY ONLY.
 *
 * These are identity records learned before `venueIdentities` existed. They
 * contain no event-shape or reconciliation behavior. The tracked
 * `venue-identities-v1` migration mirrors them into indexed identity rows;
 * this file may be removed only after that migration and its equivalence audit
 * have completed in production.
 */
export type LegacyVenueAliasSeed = {
  aliases: readonly string[];
  canonicalHandle: string;
  ingestionCanonicalName?: string;
};

export const LEGACY_VENUE_ALIAS_SEEDS: readonly LegacyVenueAliasSeed[] = [
  {
    aliases: ["Pakao"],
    canonicalHandle: "pakaoklubbeograd",
  },
  {
    aliases: ["Vinyl"],
    canonicalHandle: "vinyl.belgrade",
  },
  {
    aliases: ["20/44", "20 44", "Klub 20/44", "Klub 20 44"],
    canonicalHandle: "20_44.nightclub",
    ingestionCanonicalName: "Klub 20/44",
  },
  {
    aliases: [
      "KC Grad",
      "KC Gradu",
      "K C Grad",
      "Kulturni centar Grad",
      "Kulturni Centar GRAD",
    ],
    canonicalHandle: "kcgrad",
    ingestionCanonicalName: "KC Grad",
  },
  {
    aliases: [
      "Silosi",
      "Silosi Beograd",
      "Silosi Belgrade",
      "Medonosni vrt Silosa",
      "Medonosni vrt Silosi",
    ],
    canonicalHandle: "silosibeograd",
  },
  {
    aliases: ["Kvaka 22", "Catch 22", "Catch22"],
    canonicalHandle: "kvaka22_catch22",
  },
  {
    aliases: ["Karmakoma"],
    canonicalHandle: "karmakoma_belgrade",
  },
  {
    aliases: ["Umami"],
    canonicalHandle: "umami.bg",
  },
  {
    aliases: ["Bluz i Pivo"],
    canonicalHandle: "bluzipivobar",
  },
  {
    aliases: ["Vrtoglavica"],
    canonicalHandle: "vrtoglavicaklub",
  },
  {
    aliases: ["Chillton", "Cilton", "Čilton"],
    canonicalHandle: "chillton_chillton",
  },
  {
    aliases: [
      "Chillton Bašta",
      "Chillton Bašti",
      "Chillton Bashta",
      "Chillton Bashti",
      "Čilton Bašta",
      "Čilton Bašti",
    ],
    canonicalHandle: "chillton_bashta",
  },
  {
    aliases: ["Dub Gastro Pub", "Dub Gastro"],
    canonicalHandle: "dubgastropub",
  },
  {
    aliases: [
      "Klub Studenata Tehnike KST",
      "Klub Studenata Tehnike",
      "KST Beograd",
      "KST",
    ],
    canonicalHandle: "klubstudenatatehnike",
  },
  {
    aliases: ["Freestyler", "Freestyler Belgrade", "Splav Freestyler"],
    canonicalHandle: "freestylerbelgrade_official",
  },
  {
    aliases: [
      "Kolarac",
      "Art bioskop Kolarac",
      "Kolarac Art Bioskop",
      "Bioskop Kolarac",
    ],
    canonicalHandle: "kolarac_kolarceva_zaduzbina",
  },
  {
    aliases: [
      "Sinnerman",
      "SinnerMan",
      "Sinnerman Jazz",
      "Sinnerman Jazz Club",
    ],
    canonicalHandle: "sinnermanjazzclub",
  },
  {
    aliases: ["Beton", "Beton Club", "Beton Event Center"],
    canonicalHandle: "betonbelgrade",
  },
  {
    aliases: [
      "Nula Pet",
      "Nula pet _0.5",
      "0,5",
      "0.5",
      "Pab 0,5",
      "Pab 0.5",
      "Pub 0,5",
      "Pub 0.5",
      "Basta Paba Nula Pet",
      "Bašta Paba Nula Pet",
    ],
    canonicalHandle: "nulapet_0.5",
  },
  {
    aliases: [
      "Amfiteatar ispod Muzeja istorije Jugoslavije",
      "Amphitheater in front of the Museum of Yugoslav History",
      "Muzej istorije Jugoslavije",
      "Muzej Jugoslavije",
      "Museum of Yugoslav History",
      "Museum of Yugoslavia",
    ],
    canonicalHandle: "muzej_jugoslavije",
  },
  {
    aliases: ["Ljubica", "Ljubica Beograd"],
    canonicalHandle: "ljubicabeograd",
  },
  {
    aliases: ["Kafana Pavle Korčagin"],
    canonicalHandle: "kafanapavlekorcagin",
  },
  {
    aliases: [
      "Supa",
      "Šupa",
      "шупа",
      "Kafe Supa",
      "Kafe Šupa",
      "Кафе Шупа",
      "Cafe Supa",
      "Cafe Šupa",
    ],
    canonicalHandle: "kafesupa",
  },
  {
    aliases: [
      "Spomen muzej Ive Andrica",
      "Spomen-muzej Ive Andrica",
      "Spomen-muzej Ive Andrića",
      "Спомен музеј Иве Андрића",
      "Спомен-музеј Иве Андрића",
      "Memorial Museum of Ivo Andric",
      "Memorial Museum of Ivo Andrić",
    ],
    canonicalHandle: "muzejgradabeograda",
  },
] as const;
