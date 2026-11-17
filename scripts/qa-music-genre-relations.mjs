import assert from "node:assert/strict";
import { MUSIC_GENRES } from "../lib/taxonomy/event-discovery.ts";
import { genreProof } from "../lib/taxonomy/explicit-event-discovery.ts";
import { normalizeTaxonomyText } from "../lib/taxonomy/venue-types.ts";
import {
  CLOSE_MUSIC_GENRE_PAIRS, CONTRASTING_MUSIC_GENRE_PAIRS, MUSIC_GENRE_DEFINITIONS,
  compareMusicGenres, getMusicGenreGuide,
} from "../lib/taxonomy/music-genre-relations.ts";

const cases = [
  [["house"], ["house"], "same"],
  [["house"], ["techno"], "close"],
  [["house"], ["rock"], "contrast"],
  [["house"], ["jazz-blues"], "contrast"],
  [["classical"], ["ambient"], "unknown"],
  [["house"], [], "unknown"],
  [[], ["rock"], "unknown"],
  [["electronic", "house"], ["techno"], "close"],
  [["house", "rock"], ["techno"], "mixed"],
  [["house", "pop"], ["house"], "mixed"],
  [["house", "ambient"], ["rock"], "unknown"],
  [["house", "techno"], ["rock", "folk"], "contrast"],
  [["house", "rock"], ["house", "rock"], "mixed"],
  [["house", "techno"], ["techno", "house", "house"], "same"],
  [["house"], ["trance"], "close"],
  [["house"], ["drum-and-bass"], "unknown"],
  [["pop"], ["rnb-soul"], "unknown"],
  [["latin"], ["afro-amapiano"], "unknown"],
  [["house"], ["afro-amapiano"], "unknown"],
  [["techno"], ["indie-alternative"], "unknown"],
  [["hip-hop"], ["classical"], "contrast"],
  [["hip-hop"], ["house"], "contrast"],
  [["rnb-soul"], ["techno"], "contrast"],
  [["pop"], ["techno"], "contrast"],
  [["latin"], ["techno"], "contrast"],
  [["afro-amapiano"], ["rock"], "contrast"],
  [["indie-alternative"], ["hip-hop"], "contrast"],
  [["jazz-blues"], ["metal-punk"], "contrast"],
  [["ambient"], ["metal-punk"], "contrast"],
  [["pop"], ["classical"], "contrast"],
  [["latin"], ["metal-punk"], "contrast"],
  [["reggae-dub"], ["techno"], "contrast"],
  [["afro-amapiano"], ["classical"], "contrast"],
  [["etno-world"], ["techno"], "contrast"],
  [["jazz-blues", "house"], ["house"], "mixed"],
  [["hip-hop", "rnb-soul"], ["classical"], "contrast"],
  [["pop", "rnb-soul"], ["rnb-soul"], "mixed"],
  [["invented-style"], ["rock"], "unknown"],
];
for (const [a, b, expected] of cases) {
  assert.equal(compareMusicGenres(a, b).kind, expected, `${a} / ${b}: ${expected}`);
  assert.equal(compareMusicGenres(b, a).kind, expected, `Relations must be symmetric: ${b} / ${a}`);
}

const pairKey = ([a, b]) => [a, b].sort().join("|");
const close = new Set(CLOSE_MUSIC_GENRE_PAIRS.map(pairKey));
const contrast = new Set(CONTRASTING_MUSIC_GENRE_PAIRS.map(pairKey));
assert.equal(close.size, CLOSE_MUSIC_GENRE_PAIRS.length, "Close rules must not duplicate an edge.");
assert.equal(contrast.size, CONTRASTING_MUSIC_GENRE_PAIRS.length, "Contrast rules must not duplicate an edge.");
for (const edge of close) assert.equal(contrast.has(edge), false, "A pair cannot be both close and contrast.");
assert.equal(compareMusicGenres(["house"], ["disco-funk"]).kind, "close");
assert.equal(compareMusicGenres(["disco-funk"], ["rnb-soul"]).kind, "close");
assert.equal(compareMusicGenres(["rnb-soul"], ["jazz-blues"]).kind, "close");
assert.equal(compareMusicGenres(["house"], ["jazz-blues"]).kind, "contrast", "A chain of close styles must not override an explicit contrasting direction.");
assert.equal(compareMusicGenres(["house"], ["rnb-soul"]).kind, "unknown", "Never traverse even a two-edge chain of related styles.");

const keys = MUSIC_GENRES.map(({ key }) => key);
assert.deepEqual(Object.keys(MUSIC_GENRE_DEFINITIONS), keys, "Every existing canonical genre has exactly one glossary definition.");
for (const key of keys) {
  assert.ok(CONTRASTING_MUSIC_GENRE_PAIRS.some(pair => pair.includes(key)),
    `${key} must offer at least one explicitly curated different musical direction.`);
  const examples = MUSIC_GENRE_DEFINITIONS[key].match(/examples: ([^.]+)\./)?.[1].split(",");
  assert.ok(examples?.length, `${key} must have concrete style examples.`);
  for (const example of examples) assert.ok(genreProof[key].test(normalizeTaxonomyText(example)),
    `Guide example ${example.trim()} must be supported by the existing ${key} proof vocabulary.`);
}
for (const a of keys) for (const b of keys) {
  const result = compareMusicGenres([a], [b]);
  assert.equal(result.kind, compareMusicGenres([b], [a]).kind);
  if (result.kind === "contrast") assert.equal(contrast.has(pairKey([a, b])), true, "Only explicit contrast edges can select different music.");
  if (result.kind === "close") assert.equal(close.has(pairKey([a, b])), true, "Only explicit one-hop close edges can select similar music.");
}
const left = Object.freeze(["electronic", "house", "house"]);
const right = Object.freeze(["techno"]);
const comparison = compareMusicGenres(left, right);
assert.deepEqual(comparison.left, ["house"]);
assert.deepEqual(comparison.right, ["techno"]);
assert.deepEqual(comparison.closePairs, [["house", "techno"]]);
assert.equal(comparison.reason, "related-genres");
assert.deepEqual(left, ["electronic", "house", "house"], "Normalization must not mutate canonical input arrays.");
assert.equal(compareMusicGenres([], []).reason, "missing-genres");
assert.equal(compareMusicGenres(["house"], ["drum-and-bass"]).reason, "unresolved-relation");
assert.equal(compareMusicGenres(["house", "rock"], ["techno"]).reason, "mixed-programme");

const guide = getMusicGenreGuide();
for (const key of keys) assert.ok(guide.includes(`${key}: ${MUSIC_GENRE_DEFINITIONS[key]}`));
for (const [a, b] of CONTRASTING_MUSIC_GENRE_PAIRS) assert.ok(guide.includes(`${a} <-> ${b}`), "Agent guidance and actual contrast policy must stay synchronized.");
assert.match(guide, /same|Same/);
assert.match(guide, /one-hop/);
assert.match(guide, /NOT genres/);
assert.match(guide, /not proof of what is playing at a venue now/);
assert.match(guide, /Preserve empty results and abstention/);
console.log("Music genre relations QA passed: exhaustive canonical guide, symmetric one-hop edges, explicit contrasts, mixed/unknown abstention and immutable normalization.");
