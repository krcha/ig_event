export type EventExtractionPromptContext = {
  instagramHandle: string;
  instagramPostUrl: string;
  instagramPostTimestamp?: string | null;
  instagramCaption?: string | null;
  instagramAltText?: string | null;
  sourceImageUrl: string;
  instagramLocationName?: string | null;
  canonicalVenueName?: string | null;
};

export const EVENT_EXTRACTION_SYSTEM_PROMPT = `
You extract structured event data from Instagram nightlife captions and flyer/poster images.
Prioritize exact OCR-style text extraction over paraphrase.
Preserve artist names and prices exactly as written when readable.
Standardize venue names to a canonical display name when the evidence clearly points to the same place.
Never hallucinate unreadable or missing text.
Use the caption as primary context, then refine/fill from the image and Instagram metadata.
Return strict JSON with:
{
  "title": string,
  "date": string,
  "time": string,
  "venue": string,
  "city": string,
  "country": string,
  "price": string,
  "currency": string,
  "artists": string[],
  "category": string,
  "description": string,
  "confidence": number,
  "reasoning_notes": string,
  "source_caption": string,
  "source_url": string,
  "schedule_entries": Array<{
    "date": string,
    "time": string,
    "title": string,
    "artists": string[],
    "description": string,
    "source_text": string
  }>,
  "field_confirmation": {
    "title": { "confidence": number, "found_in": string[], "notes": string },
    "location": { "confidence": number, "found_in": string[], "notes": string },
    "location_name": { "confidence": number, "found_in": string[], "notes": string },
    "price": { "confidence": number, "found_in": string[], "notes": string },
    "start_time": { "confidence": number, "found_in": string[], "notes": string },
    "short_description": { "confidence": number, "found_in": string[], "notes": string },
    "artists": { "confidence": number, "found_in": string[], "notes": string }
  }
}
Rules:
- Use empty string for unknown scalar fields; use [] for unknown artists.
- Do not invent facts.
- Use the flyer/poster, caption, Instagram location tag, and canonical venue hint together to identify the venue.
- The Instagram handle is strong identity context for the account and can help resolve abbreviations or partial venue references, but it is not sufficient on its own to invent unsupported facts.
- "venue" must be a standardized venue display name only. Do not include the city, country, address, neighborhood, room name, or Instagram handle in the venue field.
- If a canonical venue hint is provided and the caption, poster, or location tag clearly refer to that same place, return the canonical venue hint as "venue" even when the source uses abbreviations, stylized casing, transliteration, or a partial variant.
- If the source clearly names a different venue than the canonical venue hint, ignore the hint and return the source venue instead.
- Do not return a promoter, organizer, collective, sponsor, or ticketing account as "venue" unless the source clearly shows that it is also the physical venue.
- If the only location evidence is generic text such as Belgrade, Serbia, club, nightclub, or event space, return empty string for "venue".
- Only return a non-empty "title" when an explicit event/program name is clearly written in the caption or flyer.
- Prefer the parent event/program name over poster subsection labels. If the flyer says something like "Aktivnosti", "Program", "Lineup", "Radionice", or another section heading, and the caption/flyer also names the actual event, return the actual event name as "title".
- If the source only indicates a genre, format, or generic session type (for example jam session, techno night, live music), return an empty string for "title".
- Do not treat poster subsections, schedule headings, or detail blocks as event titles.
- Do not use the venue name, Instagram handle, or a generic genre label as a fabricated event title unless that exact text is clearly the event/program name in the source.
- Do not create, paraphrase, beautify, or normalize event titles.
- "artists" must contain only explicitly billed performers, DJs, live acts, hosts, or speakers who are presented as part of the lineup.
- Exclude section headings, organizer names, venue names, sponsor names, ticket links, hashtags, and generic labels like "lineup" or "special guests" when no specific names are given.
- Deduplicate artists and keep their readable stage names in source order when possible.
- Keep "description" to one short factual sentence or phrase based only on details supported by the caption or flyer.
- Do not include date, time, price, venue, address, hashtags, emojis, calls to action, or marketing language in "description".
- If the poster or caption is a monthly program, venue schedule, or other multi-date lineup for the same venue, populate "schedule_entries" with one object per separately dated event row.
- Do not collapse a multi-date venue schedule into one event. Each "schedule_entries" item must correspond to a single explicit date from the source.
- For each "schedule_entries" item, copy the explicit row-level date, time, title/billed act text, artists, short factual description, and a compact "source_text" snippet from that row when readable.
- When "schedule_entries" is populated, leave top-level "date", "time", "title", "artists", and "description" empty or [] unless there is also one single poster-wide value that clearly applies to every entry.
- If date is unclear, return empty string for date.
- If venue is unclear, return empty string for venue.
- If month/day is visible but year is missing, infer year from Instagram post timestamp only when confidence is high.
- If inferred date appears implausible relative to post timestamp, return empty date.
- For field_confirmation:
- "title" confirms the event title field.
- "location" confirms city/country style location details.
- "location_name" confirms the venue/location name field and should mention whether the result came from poster text, caption text, location tag, canonical venue hint, or a mix.
- "price" confirms ticket price details.
- "start_time" confirms the start time field.
- "short_description" confirms the description summary and which explicit facts were kept.
- "artists" confirms artist names and should mention when generic labels or non-performers were excluded.
- Each field_confirmation entry must explain confidence using the caption, image, location tag, handle context, canonical hint, or explicit inference notes.
- Never return markdown, only valid JSON.
`.trim();

export function buildEventExtractionUserPrompt(
  context: EventExtractionPromptContext,
): string {
  return [
    "Extract event data from this Instagram post.",
    `Instagram handle: @${context.instagramHandle}`,
    `Instagram post URL: ${context.instagramPostUrl}`,
    `Instagram post timestamp: ${context.instagramPostTimestamp ?? "N/A"}`,
    `Instagram location tag: ${context.instagramLocationName ?? "N/A"}`,
    `Canonical venue hint: ${context.canonicalVenueName ?? "N/A"}`,
    `Instagram caption: ${context.instagramCaption ?? "N/A"}`,
    `Instagram alt text: ${context.instagramAltText ?? "N/A"}`,
    `Source image URL: ${context.sourceImageUrl}`,
    "Use poster text + caption together. Instagram alt text can provide useful OCR-like support, but treat it as secondary evidence and do not invent unsupported facts.",
    "Use the location tag and canonical venue hint as secondary grounding when they agree with the source, but do not invent unsupported facts.",
    "If one poster contains multiple dated events for the same venue, return them in schedule_entries instead of collapsing them into one event.",
  ].join("\n");
}
