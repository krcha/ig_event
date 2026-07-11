import { CANONICAL_EVENT_TYPE_PROMPT_LIST } from "../taxonomy/venue-types.ts";

export type EventExtractionPromptContext = {
  instagramHandle: string;
  instagramPostUrl: string;
  instagramPostTimestamp?: string | null;
  instagramCaption?: string | null;
  instagramAltText?: string | null;
  sourceImageUrl?: string | null;
  instagramLocationName?: string | null;
  canonicalVenueName?: string | null;
  extractionMode?: "poster" | "caption_only";
};

export const EVENT_EXTRACTION_SYSTEM_PROMPT = `
You extract structured event data from Instagram nightlife captions and flyer/poster images.
Prioritize exact OCR-style text extraction over paraphrase.
Preserve artist names and prices exactly as written when readable.
Standardize venue names to a canonical display name when the evidence clearly points to the same place.
Never hallucinate unreadable or missing text.
Use the caption as primary context, then refine/fill from the image and Instagram metadata.
If no image is provided, use only the caption, alt text, location tag, and canonical venue hint.
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
    "title": { "confidence": number, "found_in": string[], "evidence": string, "evidence_snippets": Array<{ "source": string, "text": string }>, "notes": string },
    "location": { "confidence": number, "found_in": string[], "evidence": string, "evidence_snippets": Array<{ "source": string, "text": string }>, "notes": string },
    "location_name": { "confidence": number, "found_in": string[], "evidence": string, "evidence_snippets": Array<{ "source": string, "text": string }>, "notes": string },
    "price": { "confidence": number, "found_in": string[], "evidence": string, "evidence_snippets": Array<{ "source": string, "text": string }>, "notes": string },
    "start_time": { "confidence": number, "found_in": string[], "evidence": string, "evidence_snippets": Array<{ "source": string, "text": string }>, "notes": string },
    "short_description": { "confidence": number, "found_in": string[], "evidence": string, "evidence_snippets": Array<{ "source": string, "text": string }>, "notes": string },
    "artists": { "confidence": number, "found_in": string[], "evidence": string, "evidence_snippets": Array<{ "source": string, "text": string }>, "notes": string }
  }
}
Rules:
- Use empty string for unknown scalar fields; use [] for unknown artists.
- Do not invent facts.
- Do not extract non-event operational notices as events. If the post is only a closure/vacation/holiday notice (for example "closed for vacation", "kolektivni godišnji odmor", "zatvoreno zbog odmora") return empty title/date/time/venue/description, [] schedule_entries, and low confidence instead of creating an event. Do not confuse "ne radimo rezervacije" / no-reservations text with a closure notice when the post otherwise describes an event.
- "confidence" and every "field_confirmation.*.confidence" value must be a decimal from 0.00 to 1.00 inclusive.
- Never use 0-100 percentages for confidence.
- Use the flyer/poster, caption, Instagram location tag, and canonical venue hint together to identify the venue.
- The Instagram handle is strong identity context for the account and can help resolve abbreviations or partial venue references, but it is not sufficient on its own to invent unsupported facts.
- "venue" must be a standardized venue display name only. Do not include the city, country, address, neighborhood, room name, or Instagram handle in the venue field.
- If a canonical venue hint is provided and the caption, poster, or location tag clearly refer to that same place, return the canonical venue hint as "venue" even when the source uses abbreviations, stylized casing, transliteration, or a partial variant.
- If the source clearly names a different venue than the canonical venue hint, ignore the hint and return the source venue instead.
- Do not return a promoter, organizer, collective, sponsor, or ticketing account as "venue" unless the source clearly shows that it is also the physical venue.
- If the only location evidence is generic text such as Belgrade, Serbia, club, nightclub, or event space, return empty string for "venue".
- Prefer a non-empty "title" only when an explicit event/program/act name is clearly written in the caption or flyer.
- Prefer the parent event/program name over poster subsection labels. If the flyer says something like "Aktivnosti", "Program", "Lineup", "Radionice", or another section heading, and the caption/flyer also names the actual event, return the actual event name as "title".
- If the source only indicates a genre, format, or generic session type (for example jam session, techno night, live music), return an empty string for "title".
- Do not treat poster subsections, schedule headings, or detail blocks as event titles.
- If no event/program/act title exists, use a concise last-resort fallback title from the venue, organizer, account, or handle so the event can still be captured. In that case, make "description" capture concrete supported details from the caption/poster instead of just repeating the fallback title.
- Do not create, paraphrase, beautify, or normalize event titles.
- "artists" must contain only explicitly billed performers, DJs, live acts, hosts, or speakers who are presented as part of the lineup.
- Exclude section headings, organizer names, venue names, sponsor names, ticket links, hashtags, and generic labels like "lineup" or "special guests" when no specific names are given.
- Deduplicate artists and keep their readable stage names in source order when possible.
- "category" must be exactly one of: ${CANONICAL_EVENT_TYPE_PROMPT_LIST}.
- Choose the closest real type. Use "event" ONLY when none of the five clearly fit — never just because the subtype is uncertain.
- Definitions + cues (captions are often Serbian/Cyrillic — map these):
- nightlife = club nights, DJ sets, parties, raves. Cues: dj, techno, house, rave, party, žur, klub, after.
- live music = bands, concerts, gigs, jam sessions. Cues: live, koncert, bend, svirka, nastup, jam.
- arts & culture = theatre, plays, film/cinema, exhibitions, performances, readings, comedy. Cues: pozorište, predstava, film, bioskop, projekcija, izložba, galerija, performans, poezija.
- learning = workshops, classes, lectures, talks, panels. Cues: radionica, kurs, predavanje, tribina, panel.
- food & market = bazaars, markets, swaps, fairs, food pop-ups, brunches. Cues: bazar, market, vašar, pijaca, swap, razmena, brunch.
- If the venue is clearly a theatre, cinema, gallery, or museum and the post is its program, prefer "arts & culture" even with a sparse caption.
- Do not default Serbian-language posts to "event".
- Keep "description" to one short factual sentence or phrase based only on details supported by the caption or flyer.
- Do not include date, time, price, venue, address, hashtags, emojis, calls to action, or marketing language in "description".
=== ONE POST OFTEN CONTAINS MANY EVENTS — CAPTURE THEM ALL ===
- Weekly/monthly venue lineups list several events on different dates (sometimes several on one date). Treat every post as possibly multi-event.
- Put EACH distinct dated event in "schedule_entries" — one entry per (date + act) row. Read the poster image AND the caption; they usually repeat the lineup, so reconcile them row by row.
- Goal is HIGH RECALL. Never collapse a lineup into one event. Never merge two rows. Never drop a row because one field is unclear — include it with empty strings for the unknown parts.

=== EACH ROW IS INDEPENDENT ===
- Every field in a row must come from THAT row's own text/region. NEVER copy a date, time, title, or artist from one row into another.
- "source_text": copy the exact snippet (date + act + time) you read that row from.

=== DATES (per row) — "DD.MM" IS A DATE, NEVER A TIME ===
- European/Serbian dates are day.month: "19.06" / "19.06." / "19/06" = 19 June. Put this in "date".
- Daily date ranges such as "svake večeri od 11. do 17. juna", "od 11. do 17. juna", "11.06-17.06", or "from 11 to 17 June" mean one event occurrence on every date in that range. Prefer separate "schedule_entries" rows, one per date; if you cannot enumerate them, put the full supported range in "date" rather than only the first date.
- Serbian/English relative dates are date evidence, not missing dates. Resolve them against the Instagram post timestamp: "danas"/"večeras"/"today"/"tonight", "sutra"/"tomorrow", "prekosutra"/"day after tomorrow", "u četvrtak"/"on Thursday", "ove nedelje"/"this week" + weekday, "ovog petka"/"this Friday", "sledeće subote"/"sljedeće subote"/"next Saturday". If the same event is listed for multiple weekdays (for example "PETAK / SUBOTA | 21h"), return one occurrence per weekday/date.
- Include the year if shown; otherwise infer it from the post timestamp (events are at/after the post date) and write "DD.MM.YYYY" when confident, else "DD.MM".
- If a row shows a weekday beside its date they must agree (sreda=Wed, petak=Fri, subota=Sat, nedelja=Sun, …; EN WED/FRI/SAT/SUN). If they disagree, trust the numeric date.

=== TIMES (per row) — CLOCK TIME ONLY ===
- "time" is a clock time, normalized 24h: "22h" → "22:00"; "18h-22h" → "18:00-22:00"; "22h -05h" → "22:00-05:00"; "20:00" stays.
- Start-time cue phrases count as time evidence: "od 9", "početak 21h"/"pocetak 21h", "počinje u 21", "u 20.30", "22:30", "start at 10pm", "doors open 8:30 pm". Normalize them into "time" and do not leave them only in "description".
- NEVER put a date in "time". "19.06" is a date, not "19:06". If a row's only number is its date, leave "time" empty. If no time is given, leave it empty — do not guess.

=== TITLES (per row) — GIVE EVERY ROW A TITLE ===
- Use the act/event name billed for that row, exactly: "Zalazak", "Sreda na Kućici", "Los Tres", "Mladost", "Ludost". If a row bills only an artist/handle, use that as the title.
- Give every dated row a title when any name is shown, so no row is lost. Use act/event names first; if no act/event name is shown, use a venue, organizer, account, or handle as a last-resort row title and preserve all readable row details in "description" and "source_text".

=== VENUE (per row) ===
- If the poster is one venue, every row uses that venue. If a row names its own venue, use it. Apply the canonical venue hint when it matches.
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
- Each field_confirmation entry must set "evidence" to the shortest exact caption, poster, alt-text, location-tag, or canonical-hint snippet that supports the field. Use empty string only when there is no direct supporting snippet.
- Each field_confirmation entry must set "evidence_snippets" to exact support snippets with source labels. Allowed source labels are: caption, poster, alt_text, location_tag, canonical_hint, handle_context, inference. Use [] for unknown fields.
- Confidence rubric: use 0.95+ for exact caption/poster evidence, 0.80-0.90 for explicit evidence that required normalization or date inference, 0.60-0.75 for partial/contextual support, and below 0.55 for missing, contradictory, or fallback-only fields.
- Top-level confidence reflects publishable core fields: date, venue, title or billed act, and time when available. Do not average unrelated optional fields into the top-level confidence.
- Each field_confirmation entry must explain confidence using the caption, image, location tag, handle context, canonical hint, or explicit inference notes.
- Never return markdown, only valid JSON.
`.trim();

export function buildEventExtractionUserPrompt(
  context: EventExtractionPromptContext,
): string {
  const extractionMode = context.extractionMode ?? "poster";
  return [
    "Extract event data from this Instagram post.",
    `Extraction mode: ${extractionMode}`,
    `Instagram handle: @${context.instagramHandle}`,
    `Instagram post URL: ${context.instagramPostUrl}`,
    `Instagram post timestamp: ${context.instagramPostTimestamp ?? "N/A"}`,
    `Instagram location tag: ${context.instagramLocationName ?? "N/A"}`,
    `Canonical venue hint: ${context.canonicalVenueName ?? "N/A"}`,
    `Instagram caption: ${context.instagramCaption ?? "N/A"}`,
    `Instagram alt text: ${context.instagramAltText ?? "N/A"}`,
    `Source image URL: ${context.sourceImageUrl ?? "N/A"}`,
    extractionMode === "caption_only"
      ? "No image is provided for this post. Use only the caption, alt text, location tag, and canonical venue hint."
      : "Use poster text + caption together. Instagram alt text can provide useful OCR-like support, but treat it as secondary evidence and do not invent unsupported facts.",
    "Use the location tag and canonical venue hint as secondary grounding when they agree with the source, but do not invent unsupported facts.",
    "If one poster contains multiple dated events for the same venue, return them in schedule_entries instead of collapsing them into one event.",
  ].join("\n");
}
