import { normalizeTaxonomyText } from "../taxonomy/venue-types";

export type CompassVenueType =
  | "cocktail-bar"
  | "wine-bar"
  | "kafana"
  | "club"
  | "bar"
  | "pub"
  | "live-music-venue"
  | "restaurant/cafe";

type VenueIdentity = {
  _id: string;
  name: string;
  category?: string | null;
  instagramHandle?: string;
  location?: string | null;
};

type VenueProfile = {
  type: CompassVenueType;
  source: string;
  verifiedOn: string;
};

type ReviewedVenue = [venueId: string, handle: string, type: CompassVenueType, source: string];

// Each ID and handle pair identifies one existing venue record, including
// separate floors/branches. Sources describe the place, not tonight's lineup.
const reviewedVenues: readonly ReviewedVenue[] = [
  ["k17dqbjstn1wtsxn9mhsj7d2h98gaw8p", "ljubavnica_bar", "cocktail-bar", "https://ljubicabgd.rs/ljubavnica/"],
  ["k177m0m9karm9rpygqnw7zayds8966ek", "riddlebarbelgrade", "cocktail-bar", "https://riddle.bar/"],
  ["k17a22381tkddgmwreq2rcqpr5896j00", "lorobarbelgrade", "cocktail-bar", "https://loro.rs/bar/"],
  ["k171tvgkfzjv8h7nvq7m082k8h896ptp", "noblerootsbar", "cocktail-bar", "https://www.nobleroots.bar/"],
  ["k17207xq8hsegf8wh10jhh9svx89712q", "josephine.belgrade", "cocktail-bar", "https://www.the50.com/discovery/Establishments/Serbia/Belgrade/Josephine.html"],
  ["k17232hwd7yzmtas2cgv72s96x89792t", "old.pal.belgrade", "cocktail-bar", "https://www.instagram.com/old.pal.belgrade/"],
  ["k17e7vb74yx7e376z57h29qkw98977nb", "qbarbgd", "cocktail-bar", "https://www.instagram.com/qbarbgd/"],
  ["k17ewjc12nspqter4dpgmjxpt98978gt", "_simple.bar_", "cocktail-bar", "https://www.instagram.com/_simple.bar_/"],
  ["k17bj7d89wrn2z9xzy2w1kw46n8977ha", "yama.belgrade", "cocktail-bar", "https://www.instagram.com/yama.belgrade/"],
  ["k170ef2jka5k9w313hhybtffa1897508", "tattoobar.bg", "cocktail-bar", "https://www.instagram.com/tattoobar.bg/"],
  ["k17a3042cd49hnjjb5wm6r42e9896g6h", "gradska_kafana", "kafana", "https://gradskakafana.rs/"],
  ["k172exrkdr736myqhz228kxkf9896hhh", "kafana_bajka", "kafana", "https://www.instagram.com/kafana_bajka/"],
  ["k17f7z91gk55yzenabfc6exezd897c46", "kafanabulevar", "kafana", "https://www.instagram.com/kafanabulevar/"],
  ["k17e6bhe8pb9kbs1wm2a6jy0y5897n7j", "clubdrugstore", "club", "https://drugstorebeograd.com/"],
  ["k17cp35s3e07ebpthy4m4trf01896hwv", "20_44.nightclub", "club", "https://ra.co/events/2511197"],
  ["k17491x5y0ydmxz4tkwwmfa9mn896q5q", "the_bank_belgrade", "club", "https://thebank.rs/about-us/"],
  ["k179vtk216gam0evmsk0n2c1md897963", "karmakoma_belgrade", "club", "https://www.instagram.com/karmakoma_belgrade/"],
  ["k17bnt5w238f5ax2pwr11g2cxd896d00", "liftbg", "bar", "https://ra.co/events/2575951"],
  ["k1784rtf8rfcveqcwsp7kga36h897nrc", "bitefartcafe", "live-music-venue", "https://bitefartcafe.rs/"],
  ["k179z1xa0r0ktkxze716k0j401896kf2", "klubfest", "live-music-venue", "https://klubfest.rs/"],
  ["k17dtea2x2565taf82evxm525d896s83", "central.pub", "pub", "https://centralpub.rs/"],
  ["k1732mc9ca2bpnpx4ycmpkzy8d896gs7", "tramvaj_pub", "pub", "https://tramvaj.rs/kontakt/"],
  ["k17a1fgyzaxv2j7m124xqmkavs896ve9", "pejtonpub", "pub", "https://pejtonpub.rs/kontakt/"],
  ["k17am8xk4n92106zg984aehr8d8962s1", "pubbrod", "pub", "https://brod.co.rs/en/"],
];

const profilesById = new Map(reviewedVenues.map(([id, handle, type, source]) =>
  [id, { handle, type, source }] as const));

// These official sites identify the specific address. Use both fields when a
// venue has no reviewed record ID; names alone can identify a different branch.
const reviewedAddresses = [
  { name: /^(?:kafana )?druga kuca(?: beton hala)?$/, address: /\b(?:karadjordjeva 2|beton hala)\b/, type: "kafana", source: "https://drugakuca.rs/" },
  { name: /^(?:restoran )?beogradska mehana$/, address: /\bskadarska 13\b/, type: "kafana", source: "https://beogradskamehana.rs/" },
  { name: /^(?:kafana |restoran )?tri sesira$/, address: /\bskadarska 29\b/, type: "kafana", source: "https://trisesira.rs/" },
  { name: /^demokratija(?: bar)?$/, address: /\bzetska 13\b/, type: "cocktail-bar", source: "https://demokratijabar.rs/media/" },
] as const;

const explicitTypes = new Map<string, CompassVenueType>([
  ["cocktail bar", "cocktail-bar"],
  ["koktel bar", "cocktail-bar"],
  ["wine bar", "wine-bar"],
  ["vinski bar", "wine-bar"],
  ["kafana", "kafana"],
  ["club", "club"],
  ["bar", "bar"],
  ["pub", "pub"],
  ["live music venue", "live-music-venue"],
  ["restaurant cafe", "restaurant/cafe"],
]);

export function getReviewedCompassVenueProfile(venue: VenueIdentity): VenueProfile | undefined {
  const reviewed = profilesById.get(venue._id);
  const handle = venue.instagramHandle?.trim().replace(/^@+/, "").toLowerCase();
  if (reviewed && reviewed.handle === handle) {
    return { type: reviewed.type, source: reviewed.source, verifiedOn: "2026-11-23" };
  }

  const name = normalizeTaxonomyText(venue.name);
  const address = normalizeTaxonomyText(venue.location);
  const match = reviewedAddresses.find((profile) => profile.name.test(name) && profile.address.test(address));
  if (match) return { type: match.type, source: match.source, verifiedOn: "2026-11-23" };
}

export function getCompassVenueType(venue: VenueIdentity): CompassVenueType | undefined {
  return getReviewedCompassVenueProfile(venue)?.type ?? explicitTypes.get(normalizeTaxonomyText(venue.category));
}
