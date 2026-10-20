import { SOCIAL_DESIGN_VERSION } from "./poster-directions.ts";

export const CLOSING_CTA_COPY = {
  title: "Zeka zna.",
  headline: ["ZEKA", "ZNA."],
  action: "Jo\u0161 doga\u0111aja na",
  benefit: "eventzeka.com",
} as const;

export function buildClosingCtaRenderVersion(publishDate?: string): string {
  const value = `${SOCIAL_DESIGN_VERSION}:closing:${publishDate || "default"}:${JSON.stringify(CLOSING_CTA_COPY)}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `z4-${(hash >>> 0).toString(36)}`;
}
