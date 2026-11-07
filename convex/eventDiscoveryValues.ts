import { v } from "convex/values";
import { DISCOVERY_CATEGORIES, DISCOVERY_FORMATS, MUSIC_GENRES } from "../lib/taxonomy/event-discovery";

const category = v.union(...DISCOVERY_CATEGORIES.map(({ key }) => v.literal(key)));
const genre = v.union(...MUSIC_GENRES.map(({ key }) => v.literal(key)));
const format = v.union(...DISCOVERY_FORMATS.map(({ key }) => v.literal(key)));

export const eventDiscoveryTaxonomy = v.object({
  primaryCategory: category,
  categories: v.array(category),
  genres: v.array(genre),
  formats: v.array(format),
});
