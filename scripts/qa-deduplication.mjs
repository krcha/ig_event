import assert from "node:assert/strict";
import { buildApprovedEventAutoCleanupGroups } from "../lib/events/approved-event-duplicates.ts";

function createEvent(overrides) {
  return {
    id: "event_id",
    title: "",
    date: "2026-03-13",
    time: null,
    venue: "",
    artists: [],
    description: null,
    imageUrl: null,
    instagramPostUrl: null,
    instagramPostId: null,
    ticketPrice: null,
    eventType: "event",
    sourceCaption: null,
    sourcePostedAt: null,
    normalizedFieldsJson: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const ciglaPromo = createEvent({
  id: "j5770n6m5p05r1nd9qjcb1aw7h82ng1v",
  title: "Cigla & Krigla Pub",
  venue: "Cigla & Krigla Pub",
  description: "Two live band events on separate dates at Cigla & Krigla Pub in Belgrade.",
  sourceCaption:
    "U petak ce biti zesca rokacina sa @odlivmozgova a u subotu @midnightbandbg svira za vas.",
  instagramPostUrl: "https://www.instagram.com/p/DVtNWCPCP_0/",
  instagramPostId: "3849791945304506356",
  updatedAt: 20,
  normalizedFieldsJson: JSON.stringify({
    normalizedDate: "2026-03-13",
    normalizedVenue: "Cigla & Krigla Pub",
    rawVenue: "Cigla & Krigla Pub",
    titleUsedFallback: true,
    postAltText:
      "13.3 ODLIV MOZGOVA 14.3 MIDNIGHT COVER BEND CIGLA KRIGLA BELGRADE PUB",
    sourceCaptionFromModel:
      "U petak ce biti zesca rokacina sa @odlivmozgova a u subotu @midnightbandbg svira za vas.",
  }),
});

const ciglaSchedule = createEvent({
  id: "j5726906ckvq1543tg56ygnt6582m0qa",
  title: "Cigla & Krigla Pub",
  venue: "Cigla & Krigla Pub",
  description: "Schedule of live music performances for March at Cigla & Krigla Pub in Belgrade.",
  sourceCaption: "Raspored svirki za mart.",
  instagramPostUrl: "https://www.instagram.com/p/DVqkc6jDJ1N/",
  instagramPostId: "3849049148226313549",
  updatedAt: 10,
  normalizedFieldsJson: JSON.stringify({
    normalizedDate: "2026-03-13",
    normalizedVenue: "Cigla & Krigla Pub",
    rawVenue: "Cigla & Krigla Pub",
    titleUsedFallback: true,
    postAltText:
      "13.3 ODLIV MOZGOVA 14.3 MIDNIGHT COVER BEND 20.3 VIS BANDITI 21.3 RUMMER",
    sourceCaptionFromModel: "Raspored svirki za mart.",
  }),
});

const illusionsFestival = createEvent({
  id: "j570qtx586038cdw4d8vy0vegn82kzpj",
  title: "ILLUSIONS Audio Visual Festival",
  venue: "ILLUSIONS",
  description: "ILLUSIONS Audio Visual Festival takes place on March 13-14 at Hangar in Belgrade.",
  sourceCaption:
    "ILLUSIONS Audio Visual Festival takes over Belgrade. March 13-14. Hangar Belgrade.",
  instagramPostUrl: "https://www.instagram.com/p/DVrRWdYDt3M/",
  instagramPostId: "3849246616679538124",
  updatedAt: 30,
  normalizedFieldsJson: JSON.stringify({
    normalizedDate: "2026-03-13",
    normalizedVenue: "ILLUSIONS",
    rawVenue: "ILLUSIONS",
    locationName: "Hangar",
    titleUsedFallback: false,
    sourceCaptionFromModel:
      "ILLUSIONS Audio Visual Festival March 13-14 Hangar Belgrade",
  }),
});

const illusionsPricing = createEvent({
  id: "j5747q97arehh11tvrv4wc2v3x82kx2s",
  title: "ILLUSIONS Audio Visual Festival",
  venue: "ILLUSIONS",
  description: "ILLUSIONS Audio Visual Festival taking place March 13-14 at Hangar Stage 1.",
  sourceCaption:
    "Prices just moved. ILLUSIONS Audio Visual Festival March 13-14 Hangar Belgrade.",
  instagramPostUrl: "https://www.instagram.com/p/DVf1aWpCIgW/",
  instagramPostId: "3846027514279921686",
  ticketPrice: "Regular 2690 RSD",
  eventType: "festival",
  updatedAt: 40,
  normalizedFieldsJson: JSON.stringify({
    normalizedDate: "2026-03-13",
    normalizedVenue: "ILLUSIONS",
    rawVenue: "ILLUSIONS",
    locationName: "Hangar",
    titleUsedFallback: false,
    sourceCaptionFromModel:
      "Prices just moved. ILLUSIONS Audio Visual Festival March 13-14 Hangar Belgrade.",
  }),
});

const illusionsLineup = createEvent({
  id: "j57bhqqmq2q2axjj771wmpvjks82jspt",
  title: "ILLUSIONS Audio Visual Festival",
  venue: "ILLUSIONS",
  artists: ["Crisis d'etat", "Bart Skils", "KiNK Live"],
  description: "ILLUSIONS Audio Visual Festival happening March 13-14 at Hangar Belgrade.",
  sourceCaption:
    "Day I of the ILLUSIONS Audio Visual Festival is one week away. Hangar is about to transform.",
  instagramPostUrl: "https://www.instagram.com/p/DVjYhkoCCx5/",
  instagramPostId: "3847026366889864313",
  eventType: "festival",
  updatedAt: 35,
  normalizedFieldsJson: JSON.stringify({
    normalizedDate: "2026-03-13",
    normalizedVenue: "ILLUSIONS",
    rawVenue: "ILLUSIONS",
    titleUsedFallback: false,
    sourceCaptionFromModel:
      "Day I of the ILLUSIONS Audio Visual Festival is one week away. Hangar Belgrade.",
  }),
});

const illusionsPress = createEvent({
  id: "j570av6yrp32fz613p6f3tc3kh82myar",
  title: "ILLUSIONS AUDIO-VISUAL FESTIVAL",
  venue: "Hangar",
  artists: [
    "KI/KI",
    "Patrick Mason",
    "Hot Since 82",
    "Alex Kennon",
    "Massano",
  ],
  description: "First day of festival sold out.",
  sourceCaption:
    "ILLUSIONS Audio-Visual Festival vraca se u Hangar 13-14. marta uz lineup koji predvode KI/KI i Patrick Mason.",
  instagramPostUrl: "https://www.instagram.com/p/DVrMtp5DNp4/",
  instagramPostId: "3849226220433365624",
  updatedAt: 25,
  normalizedFieldsJson: JSON.stringify({
    normalizedDate: "2026-03-13",
    normalizedVenue: "Hangar",
    rawVenue: "Hangar",
    locationName: "Belgrade, Serbia",
    titleUsedFallback: false,
    sourceCaptionFromModel:
      "ILLUSIONS Audio-Visual Festival vraca se u Hangar 13-14. marta uz lineup.",
  }),
});

const umamiPrimary = createEvent({
  id: "j571f4qnegnmr3f170yg1g6qjs82mwke",
  title: "Žurka LosTres",
  date: "2026-03-13",
  time: "21:00 - 02:00",
  venue: "Umami",
  artists: ["MILOSH"],
  description: "Party event at Umami gastrošor featuring MILOSH and LosTres on March 13.",
  sourceCaption:
    "Welcome to UMAMI. Žurka LosTres. PETAK 13.03. 21h - 02h. MILOSH.",
  instagramPostUrl: "https://www.instagram.com/p/DVrXQb7AC_J/",
  instagramPostId: "3849272591080501193",
  eventType: "party",
  updatedAt: 50,
  normalizedFieldsJson: JSON.stringify({
    normalizedDate: "2026-03-13",
    normalizedVenue: "Umami",
    rawVenue: "Umami",
    locationName: "UMAMI",
    titleUsedFallback: false,
    sourceCaptionFromModel:
      "Zurka LosTres. PETAK 13.03. 21h - 02h. MILOSH. UMAMI.",
    postAltText: "UMAMI 13. MART MILOSH losTres",
  }),
});

const umamiWeeklyHandle = createEvent({
  id: "j573d3cpxw54wcnzdxs8ppgvj982mqax",
  title: "lostreszurke",
  date: "2026-03-13",
  time: "21:00-02:00",
  venue: "Umami",
  artists: ["lostreszurke"],
  description: "DJ set by lostreszurke at Umami on Friday night.",
  sourceCaption:
    "UMAMI THIS WEEK. Friday @lostreszurke od 21h-02h. Saturday @mamime.bg. Sunday @1moretime.bg.",
  instagramPostUrl: "https://www.instagram.com/p/DVrYOCFALtZ/",
  instagramPostId: "3849276823938579289",
  eventType: "club night",
  updatedAt: 40,
  normalizedFieldsJson: JSON.stringify({
    normalizedDate: "2026-03-13",
    normalizedVenue: "Umami",
    rawVenue: "Umami",
    locationName: "UMAMI",
    titleUsedFallback: false,
    sourceCaptionFromModel:
      "UMAMI THIS WEEK. Friday @lostreszurke od 21h-02h.",
  }),
});

const umamiWeeklyPoster = createEvent({
  id: "j578mvx1hs6tsngh35dabf3phh82mdw8",
  title: "lostreszurke",
  date: "2026-03-13",
  time: "21:00-02:00",
  venue: "Umami",
  artists: ["lostreszurke"],
  description: "Event at Umami Friday night from 21h to 02h with lostreszurke.",
  sourceCaption:
    "UMAMI THIS WEEK. Friday @lostreszurke od 21h-02h. Saturday @mamime.bg. Sunday @1moretime.bg.",
  instagramPostUrl: "https://www.instagram.com/p/DVrXmFuANgy/",
  instagramPostId: "3849274079068608562",
  updatedAt: 35,
  normalizedFieldsJson: JSON.stringify({
    normalizedDate: "2026-03-13",
    normalizedVenue: "Umami",
    rawVenue: "Umami",
    locationName: "UMAMI",
    titleUsedFallback: false,
    sourceCaptionFromModel:
      "UMAMI THIS WEEK. Friday @lostreszurke od 21h-02h.",
  }),
});

const umamiWeeklyName = createEvent({
  id: "j57evbfvrsjhfaq1cpkgy03j3h82ms2t",
  title: "LOS TRES",
  date: "2026-03-13",
  time: "21:00-02:00",
  venue: "Umami",
  artists: ["LOS TRES"],
  description: "Event at Umami on March 13 featuring LOS TRES.",
  sourceCaption:
    "UMAMI THIS WEEK. Friday @lostreszurke od 21h-02h. Saturday @mamime.bg. Sunday @1moretime.bg.",
  instagramPostUrl: "https://www.instagram.com/p/DVrYHwIgExH/",
  instagramPostId: "3849276392353057863",
  updatedAt: 30,
  normalizedFieldsJson: JSON.stringify({
    normalizedDate: "2026-03-13",
    normalizedVenue: "Umami",
    rawVenue: "Umami",
    locationName: "UMAMI",
    titleUsedFallback: false,
    sourceCaptionFromModel:
      "UMAMI THIS WEEK. Friday @lostreszurke od 21h-02h.",
    postAltText: "UMAMI THIS WEEK LOS TRES PETAK 13.MAR",
  }),
});

const guzvaPrimary = createEvent({
  id: "j574sapjxgqe3j4qf5qvk0jhk182k1g6",
  title: "GUŽVA®",
  date: "2026-03-13",
  time: "22:00",
  venue: "GUŽVA®",
  artists: ["DJ Gilić", "DJ Vlasac"],
  description: "DJ Gilić B2B DJ Vlasac all-nighter event at Vinyl club in Belgrade.",
  sourceCaption:
    "GUŽVA. PETAK 13.03 22h. @aleksandargilic @vlasacevic_andrija. @vinyl.belgrade.",
  instagramPostUrl: "https://www.instagram.com/p/DVlr4pmiIKz/",
  instagramPostId: "3847674465618526899",
  eventType: "club night",
  updatedAt: 45,
  normalizedFieldsJson: JSON.stringify({
    normalizedDate: "2026-03-13",
    normalizedVenue: "GUŽVA®",
    rawVenue: "GUŽVA®",
    locationName: "Vinyl Belgrade Nightclub",
    titleUsedFallback: true,
    sourceCaptionFromModel:
      "GUZVA. PETAK 13.03 22h. @aleksandargilic @vlasacevic_andrija. @vinyl.belgrade.",
    postAltText: "DJ GILIC B2B DJ VLASAC guzva PETAK 13 MART START 22H",
  }),
});

const guzvaWeekly = createEvent({
  id: "j57c0q956a6m1cgfahb8xvkzj982n4na",
  title: "GUŽVA",
  date: "2026-03-13",
  time: null,
  venue: "Vinyl",
  artists: ["Aleksandar Gilić", "Vlasac"],
  description: "Gužva with Aleksandar Gilić & Vlasac.",
  sourceCaption:
    "CLUB VINYL SEASON 2. Friday @guzva011. When the needle drops, the night at Vinyl begins.",
  instagramPostUrl: "https://www.instagram.com/p/DVqub13jO-O/",
  instagramPostId: "3849093054947192718",
  updatedAt: 25,
  normalizedFieldsJson: JSON.stringify({
    normalizedDate: "2026-03-13",
    normalizedVenue: "Vinyl",
    rawVenue: "Vinyl",
    locationName: "Vinyl Belgrade Nightclub",
    titleUsedFallback: false,
    sourceCaptionFromModel:
      "CLUB VINYL SEASON 2. Friday @guzva011.",
    postAltText: "GUZVA ALEKSANDAR GILIC & VLASAC 13.03.",
  }),
});

const sameheadsPrimary = createEvent({
  id: "j57a61ynp36x7aack11shje0hx82k9ra",
  title: "20 Years of Sameheads",
  date: "2026-03-14",
  venue: "Karmakoma",
  artists: [
    "Alicia Carrera",
    "Electric Evelyn",
    "Ali Guney",
    "Emil Doesn't Drive",
    "Edin",
  ],
  description:
    "Celebration of 20 years of Sameheads at Karmakoma with Alicia Carrera and Electric Evelyn, plus a warmup at Dimsam.",
  sourceCaption:
    "MARCH 14. @sameheads with @aliciacarrera___ and @evelyn___siegmund at Karmakoma, plus warmup with @dimsam___.",
  instagramPostUrl: "https://www.instagram.com/p/DUqP5GLjOE0/",
  instagramPostId: "3830944327376101684",
  ticketPrice: "1200 RSD",
  updatedAt: 55,
  normalizedFieldsJson: JSON.stringify({
    normalizedDate: "2026-03-14",
    normalizedVenue: "Karmakoma",
    rawVenue: "Karmakoma",
    locationName: "Karmakoma Club",
    titleUsedFallback: false,
    sourceCaptionFromModel:
      "MARCH 14. @sameheads with @aliciacarrera___ and @evelyn___siegmund at Karmakoma, plus @dimsam___.",
  }),
});

const sameheadsTakeover = createEvent({
  id: "j578h2je9rts4yg8v4216hdgds82n8w1",
  title: "20 year Anniversary",
  date: "2026-03-14",
  venue: "karmakoma",
  artists: [
    "sameheads",
    "dimsam___",
    "emil_angelo",
    "aliciacarrera___",
    "evelyn___siegmund",
  ],
  description:
    "The @sameheads 20 year anniversary takeover in Belgrade at @dimsam___ and @karmakoma_belgrade.",
  sourceCaption:
    "The @sameheads 20 XX year anniversary tour kicks off in Belgrade. Takeover of @dimsam___ and @karmakoma_belgrade with @aliciacarrera___ & @evelyn___siegmund.",
  instagramPostUrl: "https://www.instagram.com/p/DVq6-V2CNaI/",
  instagramPostId: "3849148202301838984",
  updatedAt: 32,
  normalizedFieldsJson: JSON.stringify({
    normalizedDate: "2026-03-14",
    normalizedVenue: "karmakoma",
    rawVenue: "Karmakoma Club",
    locationName: "Karmakoma Club",
    titleUsedFallback: false,
    sourceCaptionFromModel:
      "The @sameheads 20 XX year anniversary tour kicks off. @dimsam___ and @karmakoma_belgrade with @aliciacarrera___ & @evelyn___siegmund.",
  }),
});

const tttMerchPromo = createEvent({
  id: "j5749bd4p26gz06nehed1xa33582n02q",
  title: "merch available After",
  date: "2026-03-12",
  venue: "karmakoma",
  artists: ["TTT", "ZUBI"],
  description:
    "Concert by TTT performing songs from the new album Važan i Veliki with guest ZUBI, merch available after show.",
  sourceCaption:
    "Još 7 dana do našeg velikog koncerta u Karmakomi. Izvodimo pesme sa novog albuma Važan i Veliki. Gosti ZUBI @zubikidaju.",
  instagramPostUrl: "https://www.instagram.com/p/DVguBbXjV9i/",
  instagramPostId: "3846276490019561314",
  updatedAt: 48,
  normalizedFieldsJson: JSON.stringify({
    normalizedDate: "2026-03-12",
    normalizedVenue: "karmakoma",
    rawVenue: "Karmakoma",
    titleUsedFallback: false,
    titleDerivedFromContext: true,
    titleContextCandidate: "merch available after",
    sourceCaptionFromModel:
      "Još 7 dana do velikog koncerta u Karmakomi. Novi album Važan i Veliki. Gosti ZUBI @zubikidaju.",
  }),
});

const tttGiveaway = createEvent({
  id: "j575pxp5x4y5fygn1ekpdsb9ds82mkh1",
  title: "Oblakoder",
  date: "2026-03-12",
  venue: "karmakoma",
  artists: ["Turbo Trans Turisti"],
  description:
    "Concert of Turbo Trans Turisti promoting their new album Važan i Veliki at Karmakoma in Belgrade.",
  sourceCaption:
    "Turbo Trans Turisti nastupiće 12. marta u Karmakomi uz promociju albuma Važan i Veliki.",
  instagramPostUrl: "https://www.instagram.com/p/DVqUS58Co-i/",
  instagramPostId: "3848978091632922530",
  updatedAt: 44,
  normalizedFieldsJson: JSON.stringify({
    normalizedDate: "2026-03-12",
    normalizedVenue: "karmakoma",
    rawVenue: "Karmakoma",
    titleUsedFallback: true,
    sourceCaptionFromModel:
      "Turbo Trans Turisti nastupiće 12. marta u Karmakomi uz promociju albuma Važan i Veliki.",
  }),
});

const bazaExhibitionOpening = createEvent({
  id: "j5703qcn59qca5k5sr67ewpwds82ncfz",
  title: "Irene Ivanović followed by a Party",
  date: "2026-03-12",
  time: "19:00",
  venue: "Baza Kulturnih Zbivanja",
  artists: ["Aleksssa"],
  description:
    "Opening of the exhibition The Weight of Light by Irene Ivanović followed by a party starting at 20:00 with DJ Aleksssa.",
  sourceCaption:
    "Vidimo se u Bazi 12. marta. 19:00 otvaranje izložbe THE WEIGHT OF LIGHT Irene Ivanović. 20:00 žurka startuje.",
  instagramPostUrl: "https://www.instagram.com/p/DVtJCirDeBs/",
  instagramPostId: "3849773013558747244",
  updatedAt: 43,
  normalizedFieldsJson: JSON.stringify({
    normalizedDate: "2026-03-12",
    normalizedVenue: "Baza Kulturnih Zbivanja",
    rawVenue: "Baza Kulturnih Zbivanja",
    titleUsedFallback: false,
    titleDerivedFromContext: true,
    titleContextCandidate: "Irene Ivanović followed by a party",
    sourceCaptionFromModel:
      "19:00 otvaranje izložbe THE WEIGHT OF LIGHT Irene Ivanović. 20:00 žurka startuje.",
  }),
});

const bazaScheduleEntry = createEvent({
  id: "j57184adsqqb35wk4s3ks51dx982nddv",
  title: "The Weight of Light",
  date: "2026-03-12",
  time: "19:00",
  venue: "Baza Kulturnih Zbivanja",
  artists: ["Irena Ivanović"],
  description: "Exhibition of works by Irena Ivanović.",
  sourceCaption:
    "ČET 12. MAR - The Weight of Light - izložba radova Irene Ivanović - 19h",
  instagramPostUrl: "https://www.instagram.com/p/DVn0jWHjZkd/",
  instagramPostId: "3848275533960681757",
  updatedAt: 39,
  normalizedFieldsJson: JSON.stringify({
    normalizedDate: "2026-03-12",
    normalizedVenue: "Baza Kulturnih Zbivanja",
    rawVenue: "Baza Kulturnih Zbivanja",
    titleUsedFallback: false,
    splitSourceLine:
      "ČET 12. MAR - The Weight of Light - izložba radova Irene Ivanović - 19h",
    sourceCaptionFromModel:
      "ČET 12. MAR - The Weight of Light - izložba radova Irene Ivanović - 19h",
  }),
});

const vinylScheduleEntry = createEvent({
  id: "j571r50ms9gx8mq5vj4wdcekgd82m1f6",
  title: "VINYL",
  date: "2026-03-12",
  venue: "Vinyl",
  artists: ["Intruder"],
  description: "Vinyl Intruder all nighter event.",
  sourceCaption:
    "CLUB VINYL SEASON 2. Thursday 12.03. Intruder - all nighter.",
  instagramPostUrl: "https://www.instagram.com/p/DVqub13jO-O/",
  instagramPostId: "3849093054947192718",
  updatedAt: 36,
  normalizedFieldsJson: JSON.stringify({
    normalizedDate: "2026-03-12",
    normalizedVenue: "Vinyl",
    rawVenue: "Vinyl",
    titleUsedFallback: false,
    splitSourceLine: "VINYL INTRUDER - ALL NIGHTER 12.03.",
    sourceCaptionFromModel:
      "CLUB VINYL SEASON 2. Thursday 12.03. Intruder - all nighter.",
  }),
});

const tavanScheduleEntry = createEvent({
  id: "j57996w7ker84j3ywa54hn2pm182m85p",
  title: "ZEITMASCHINE",
  date: "2026-03-12",
  venue: "Vinyl Belgrade Nightclub",
  artists: ["ZEITMASCHINE", "DUSCHAN RECHT", "TYWIN FOX"],
  description: "ZEITMASCHINE with Duschan Recht and Tywin Fox",
  sourceCaption:
    "TAVAN CLUB SEASON 1. Thursday @zeitmaschine.bgd with Duschan Recht x Tywin Fox.",
  instagramPostUrl: "https://www.instagram.com/p/DVrBjBPjUHs/",
  instagramPostId: "3849177111081075180",
  updatedAt: 34,
  normalizedFieldsJson: JSON.stringify({
    normalizedDate: "2026-03-12",
    normalizedVenue: "Vinyl Belgrade Nightclub",
    rawVenue: "Vinyl Belgrade Nightclub",
    titleUsedFallback: false,
    splitSourceLine:
      "ZEITMASCHINE DUSCHAN RECHT X TYWIN FOX 12.03. THU",
    sourceCaptionFromModel:
      "TAVAN CLUB SEASON 1. Thursday @zeitmaschine.bgd with Duschan Recht x Tywin Fox.",
  }),
});

const groups = buildApprovedEventAutoCleanupGroups([
  ciglaPromo,
  ciglaSchedule,
  illusionsFestival,
  illusionsPricing,
  illusionsLineup,
  illusionsPress,
  umamiPrimary,
  umamiWeeklyHandle,
  umamiWeeklyPoster,
  umamiWeeklyName,
  guzvaPrimary,
  guzvaWeekly,
  sameheadsPrimary,
  sameheadsTakeover,
  tttMerchPromo,
  tttGiveaway,
  bazaExhibitionOpening,
  bazaScheduleEntry,
  vinylScheduleEntry,
  tavanScheduleEntry,
]);

const groupedIdSets = groups.map(
  (group) => new Set([group.primaryEventId, ...group.duplicateEventIds]),
);

assert(
  groupedIdSets.some(
    (ids) =>
      ids.has(ciglaPromo.id) &&
      ids.has(ciglaSchedule.id) &&
      ids.size === 2,
  ),
  "Expected Cigla duplicates to collapse into one cleanup group.",
);

assert(
  groupedIdSets.some(
    (ids) =>
      ids.has(illusionsFestival.id) &&
      ids.has(illusionsPricing.id) &&
      ids.has(illusionsLineup.id) &&
      ids.has(illusionsPress.id) &&
      ids.size === 4,
  ),
  "Expected ILLUSIONS variants to collapse into one cleanup group.",
);

assert(
  groupedIdSets.some(
    (ids) =>
      ids.has(umamiPrimary.id) &&
      ids.has(umamiWeeklyHandle.id) &&
      ids.has(umamiWeeklyPoster.id) &&
      ids.has(umamiWeeklyName.id) &&
      ids.size === 4,
  ),
  "Expected Umami LosTres aliases and weekly-schedule variants to collapse into one cleanup group.",
);

assert(
  groupedIdSets.some(
    (ids) =>
      ids.has(guzvaPrimary.id) &&
      ids.has(guzvaWeekly.id) &&
      ids.size === 2,
  ),
  "Expected GUZVA and Vinyl weekly-schedule variants to collapse into one cleanup group.",
);

assert(
  groupedIdSets.some(
    (ids) =>
      ids.has(sameheadsPrimary.id) &&
      ids.has(sameheadsTakeover.id) &&
      ids.size === 2,
  ),
  "Expected Sameheads anniversary variants to collapse into one cleanup group via shared handle evidence.",
);

assert(
  groupedIdSets.some(
    (ids) => ids.has(tttMerchPromo.id) && ids.has(tttGiveaway.id) && ids.size === 2,
  ),
  "Expected acronym and album-promo aliases like TTT and Turbo Trans Turisti to collapse into one cleanup group.",
);

assert(
  groupedIdSets.some(
    (ids) =>
      ids.has(bazaExhibitionOpening.id) &&
      ids.has(bazaScheduleEntry.id) &&
      ids.size === 2,
  ),
  "Expected exhibition openings that embed the schedule title in a broader caption to collapse into one cleanup group.",
);

assert(
  !groupedIdSets.some(
    (ids) => ids.has(vinylScheduleEntry.id) && ids.has(tavanScheduleEntry.id),
  ),
  "Expected unrelated same-night Vinyl schedule entries to remain separate when their identities do not overlap.",
);

const illusionsGroup = groups.find((group) =>
  [group.primaryEventId, ...group.duplicateEventIds].includes(illusionsPress.id),
);

assert(illusionsGroup, "Expected the Hangar press mention to be grouped with the festival posts.");

const illusionsReasons = illusionsGroup.matchReasonsByEventId[illusionsPress.id] ?? [];
assert(
  illusionsReasons.includes("venue referenced in event text") ||
    illusionsGroup.primaryEventId === illusionsPress.id,
  "Expected venue-context matching to explain the Hangar/ILLUSIONS merge.",
);

console.log(
  "QA passed: duplicate cleanup groups catch schedule duplicates, venue variants, acronym aliases, and embedded event titles without collapsing unrelated same-night entries.",
);
