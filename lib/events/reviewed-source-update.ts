import { canonicalizeSourceUrl } from "../domain/source-url.ts";

export type ReviewedSourceUpdate = {
  text: string;
  sourceUrl: string;
  sourceEventId: string;
};

type EventWithReviewedSourceUpdate = {
  _id: string;
  instagramPostUrl?: string;
  reviewedSourceUpdate?: ReviewedSourceUpdate;
};

/** Render only a concise update linked to a distinct, valid source post. */
export function getPublicReviewedSourceUpdate(event: EventWithReviewedSourceUpdate):
  { text: string; sourceUrl: string } | null {
  const update = event.reviewedSourceUpdate;
  const text = update?.text.replace(/\s+/gu, " ").trim() ?? "";
  if (
    !update ||
    !text ||
    text.length > 240 ||
    !update.sourceEventId ||
    update.sourceEventId === event._id
  ) {
    return null;
  }

  const primarySource = canonicalizeSourceUrl("instagram", event.instagramPostUrl);
  const updateSource = canonicalizeSourceUrl("instagram", update.sourceUrl);
  if (
    !primarySource.ok ||
    !updateSource.ok ||
    primarySource.value.canonicalUrl === updateSource.value.canonicalUrl
  ) {
    return null;
  }

  return { text, sourceUrl: updateSource.value.canonicalUrl };
}
