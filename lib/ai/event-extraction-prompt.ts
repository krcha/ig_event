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
  instagramSourceRole?: "venue" | "promoter" | "unknown";
  instagramSourceName?: string | null;
  extractionMode?: "poster" | "caption_only";
  carouselSlideIndexes?: number[];
  carouselKnownSlideCount?: number;
};

export const EVENT_EXTRACTION_SYSTEM_PROMPT = `
Extract source-grounded event facts from Instagram captions and posters. Prioritize exact OCR; preserve readable names and prices. Never guess unreadable text or use remembered schedules, faces, scene context or posting history as lineup evidence.
Read the poster and caption as complementary primary evidence. Layout and headings scope occurrences; readable caption and poster facts can fill each other's omissions. Alt text is secondary support. Without an image, use only the caption, alt text, location tag and canonical venue hint.
A lifestyle photo or other scene with no legible event text needs an explicit caption announcement and date; otherwise return a non-event.
Follow the supplied strict event_evidence_v2 JSON schema, which defines all required fields and enums.
Rules:
- Use empty string for unknown scalar fields; use [] for unknown artists.
- Keep ordinary responses within 3,840 output tokens; use exact fragments, not repeated prose.
- Always return source_caption="" and source_url="". The caller already owns and durably restores both exact source values after parsing.
- Maximum characters: reasoning_notes 160 (one factual sentence), description 240, conflict reason 120, schedule source_text/evidence 200. field_confirmation: at most two found_in labels, one exact evidence_snippet, evidence 160, notes 80. Avoid repeated snippets; prefer empty notes.
- Set "is_event" to true for a clearly announced real occurrence. Capture every genuine event; missing optional time/price/venue, a short caption or harmless aliases do not make it invalid. Keep supported details and unknown fields empty. Confidence is informational, never an approval threshold.
- Set "is_event" to false for closures, recaps/past-event memories, menus or ordinary offers, giveaways/contests, cancellations without a replacement occurrence, and posts too unclear to establish an event. Give one short factual "non_event_reason"; do not rely only on empty event fields.
- A routine discount, booking/ticket-sales deadline, cinema availability or exhibition closing date alone is not an occurrence. "Every Sunday 50% off", "in cinemas from 15 October" and "view until 11 October" do not create sessions. Keep genuine dated screenings, openings, tours, tastings, special dinners, markets and performances inside promotions.
- When "is_event" is true, "non_event_reason" must be empty. When false, return empty event fields, [] schedule_entries, and low confidence.
- Do not confuse "ne radimo rezervacije" / no-reservations text with a closure notice when the post otherwise describes an event.
- Always return "extraction_contract_version": "event_evidence_v2".
- Every confidence is a decimal from 0.00 to 1.00 inclusive, never a percentage.
- Calendar scope is Belgrade/Beograd. In a tour or mixed-city schedule, keep local occurrences and omit explicitly out-of-town shows; never assign the posting account's Belgrade venue/city to them. A solely out-of-town announcement uses is_event=false and a short outside-calendar-area reason. An artist biography mentioning other cities does not make a Belgrade show out of scope.
- Treat the account role as authoritative context. A venue-role account may supply its canonical physical venue when no source evidence names another place. A promoter-role account name identifies the organizer, never the physical venue.
- "venue" is a standardized venue display name for the physical location; never append city, neighborhood, room or handle. If only an exact event-location street address is supported, use it; otherwise leave venue empty.
- Venue evidence priority: the row's explicit physical venue; poster/caption physical venue; location tag; canonical venue hint for a venue or unclassified source. Never use a promoter, organizer, collective, sponsor, ticket seller or ticket domain as the physical venue without explicit evidence.
- Use the canonical venue hint for unambiguous abbreviations, casing, diacritics or transliteration of that same place. A different explicitly named physical venue or branch overrides the hint; a posting handle cannot invent unsupported location facts.
- If the only location evidence is generic text such as Belgrade, Serbia, club, nightclub, or event space, return empty string for "venue".
- Unambiguous grammatical cases (Stazi to Staza) and a configured physical venue inside a heading like "<VENUE NAME> WINTER STAGE" support that venue. Neither a venue name nor its grammatical ending alone proves an event title.
- For film screenings, plays, books, exhibitions, and similar cultural programs, an explicitly quoted work name (for example “Battle Royale” (2000)) is the event title; never use the surrounding date/time/location phrase as the title.
- Prefer the actual program name over subsection headings (Aktivnosti, Program, Lineup, Radionice). Generic genre/format prose alone is not a title, but an explicitly billed dated program label is: preserve "OPEN DECKS", "BAR RESIDENTS", "Gypsy Jazz" or an audition label. Proper nouns are not required; never replace these with guessed "Thursday Night" titles.
- If no explicit event/program/act title exists, return an empty title. A venue, organizer, account, or handle is not a substitute for evidence that an event exists.
- Do not create, paraphrase, beautify, or normalize event titles.
- "artists" must contain only explicitly billed performers, DJs, live acts, hosts, or speakers who are presented as part of the lineup.
- Exclude repertoire/recorded-music artists (a night playing Madonna or David Bowie), tribute subjects, film casts, biography subjects, influences, photographers and sponsors unless separately billed as appearing. A band member is not a separate billed act without evidence.
- Exclude section headings, organizer names, venue names, sponsor names, ticket links, hashtags, and generic labels like "lineup" or "special guests" when no specific names are given.
- A hashtag is discovery/marketing metadata, never an artist, billed act, schedule-row title, or event title unless the same identity is separately and explicitly billed outside the hashtag in caption or poster text.
- Deduplicate artists in source order. Preserve the full legible lineup, including smaller supporting names, for that occurrence instead of keeping only the headliner.
- Preserve an explicitly billed Instagram artist handle with @. If its poster display name clearly names the same act, keep the handle once; harmless aliases are not conflicts.
- "category" must be exactly one of: ${CANONICAL_EVENT_TYPE_PROMPT_LIST}.
- Map Serbian/Cyrillic cues to the closest type: nightlife (DJ, party, rave, zurka, after); live music (band, koncert, svirka, jam); arts & culture (theatre, film, projekcija, izlozba, comedy); learning (radionica, predavanje, panel); food & market (bazar, pijaca, swap, brunch). Use "event" only when none fits. Theatre/cinema/gallery/museum programs normally use arts & culture, even with sparse text.
- Keep "description" to one short factual sentence or phrase based only on details supported by the caption or flyer.
- Do not include date, time, price, venue, address, hashtags, emojis, calls to action, or marketing language in "description", except that a consolidated one-event running order may include its performer-slot times.
- Preserve factual admission conditions (age, members/cardholders only, booking, accessibility), required purchase channels and row-specific room/branch/activity in description. Example: a discount only with Mastercard when buying via Eventlin keeps both the card restriction and Eventlin; ordinary ticket links need no description. Never copy conditions, category or price across unrelated rows; leave root price/currency empty without shared admission.
=== ONE POST OFTEN CONTAINS MANY EVENTS — CAPTURE THEM ALL ===
- Weekly/monthly venue lineups list several real event occurrences on different dates (sometimes several on one date). Treat every post as possibly multi-event.
- Put EACH distinct real-world event occurrence in "schedule_entries". A lineup member or DJ set inside one occurrence is not a separate event.
- Group independently attendable sessions: repeated screenings, tours or workshops at distinct starts stay separate despite identical titles/guides/venues. Tours at 13h and 15h on two dates mean four sessions, not a 13:00-15:00 window.
- One date + physical venue + one overall event window over consecutive DJ/performer slots means ONE schedule entry: overall time window, full artists, compact running order. Prefer an explicit parent title; otherwise use billed names.
- A continuous same-night sequence including "after midnight", "then", "takes over" or "nastavlja" stays one occurrence. Use the earliest explicit event/segment start; keep later acts, never guess a handoff clock. A separately announced date/venue/admission/program is independent.
- Split same-date independent program titles, event windows, venues, admission or separately named room programs. Named upstairs/downstairs programs keep their own lineups even at the same start. One expressly shared party/common admission stays one parent; a room heading alone does not create an event. Rooms go in description, not venue.
- Keep high recall only among rows that are actually legible in the source. Preserve every readable billed name when consolidating a lineup. Omit a real occurrence whose exact date cannot be read. If its billed act/title is absent, emit it only under the narrow unnamed-row rule below.

=== EACH EVENT OCCURRENCE IS INDEPENDENT ===
- Every field belongs to its own occurrence's text/region. NEVER copy date, time, venue, title or artists from another occurrence. Only explicit shared headers or the venue-account fallback below may supply common fields.
- Bind columns, aligned rows and scoped headings: "16/10 ARHIVATORI" and "17/10 DJ STEVA" have one act each. A graphic box is not a shared lineup; Thursday's guest and upper/lower room programs stay in their cells.
- City roundups/tours are not joint shows. Bind acts locally to dates/venues; never multiply every act by every date or inherit the last paragraph's venue. "16-17 October" does not prove each act plays both days. Report unresolved act/date binding as a date source_conflict; do not invent a day or combined lineup. Retain supported occurrences, not a whole-source non-event classification.
- Match complementary rows by the same explicit title/act, e.g. poster "11. BG BANDA" and caption "11.09 - BG BANDA". Never borrow a different row's date. Shared venue/time requires visible common scope and an exact quote in shared_schedule_context; otherwise leave it empty.
- "source_text": copy the exact snippet (date + act/title, or date + the qualifying row-local venue/event-kind evidence, plus optional time) you read that row from. If you cannot quote that exact row, do not emit the schedule entry.
- For exactly ONE non-recurring real event occurrence, merge complementary evidence: poster date/time/venue and caption title or artist. "O Bato i predivna muzika Brazila još jednom kod nas" is an affirmative announcement; narrative listening, inspiration, credits and hashtag-only mentions are not. Use one schedule entry with an exact source_text and caption identity support in field_confirmation. Never use this rule for a recurring schedule or to carry an identity across two or more schedule rows.

=== DATES (per row) — "DD.MM" IS A DATE, NEVER A TIME ===
- European/Serbian dates are day.month: "19.06" / "19.06." / "19/06" = 19 June. Put this in "date".
- Check named month/year, weekdays and neighboring rows. MM.DD requires unambiguous context: "October 26" with Sunday 10.04/10.11/10.18.2026 means October 4/11/18. Return ISO dates, but quote the printed date and supporting context exactly in date_evidence; never replace it with ISO or fabricate a contiguous quote. Ambiguous format stays unresolved.
- Daily activity ranges ("svake večeri od 11. do 17. juna", "11.06-17.06") support one row per announced day. Preserve the full range if not enumerated. Availability or closing deadlines never prove daily sessions.
- Serbian/English relative dates are date evidence, not missing dates. Resolve them against the Instagram post timestamp: "danas"/"večeras"/"today"/"tonight", "sutra"/"tomorrow", "prekosutra"/"day after tomorrow", "u četvrtak"/"on Thursday", "ove nedelje"/"this week" + weekday, "ovog petka"/"this Friday", "sledeći petak"/"sledećeg petka", "sledeće subote"/"sljedeće subote"/"next Saturday". If the same named event/act is listed for multiple weekdays (for example "PETAK / SUBOTA | 21h"), return one occurrence per weekday/date.
- Every row needs date_evidence: exact printed phrase, correct source, is_relative and resolved ISO date (YYYY-MM-DD). Never invent evidence; unresolved contradictions use empty resolved_date.
- A schedule row with no event title or billed act needs THAT SAME ROW's exact readable date plus a specific physical venue name or a clear event-kind phrase (concert, screening, workshop, svirka, projekcija, izlozba, radionica). Keep "title" empty and "artists" []; quote the qualifying row. Omit every other unnamed row; no account/venue/hashtag/date/genre may become its title.
- Include the year if shown; otherwise infer it from the post timestamp (events are at/after the post date) and write "DD.MM.YYYY" when confident, else "DD.MM".
- Printed weekday/date must agree (sreda/Wed, petak/Fri, subota/Sat, nedelja/Sun). If neither supported format agrees, keep raw date/weekday evidence, empty resolved_date and a date source_conflict. Never trust the number alone, shift a day or invent another year. The announced event stays is_event=true for resolution.

=== TIMES (per row) — CLOCK TIME ONLY ===
- "time" is a clock time, normalized 24h: "22h" → "22:00"; "18h-22h" → "18:00-22:00"; "19H - 01H" → "19:00-01:00"; "22h -05h" → "22:00-05:00"; "20:00" stays.
- Start cues ("od 9", "početak 21h", "u 20.30", "start at 10pm") populate time, not just description.
- "doors open" / "vrata se otvaraju" is logistics, not the event start. If it is the only clock, leave "time" empty and use time_evidence.status="doors_open_only". Never publish a doors-open clock as the start time.
- time_evidence: readable start uses start_time_stated and its exact quote; no start uses not_stated, exact_text="", source="unknown"; a visible unreadable clock uses unreadable.
- The time_evidence quote must prove the final time for that same session: if the source says "Doors: 19:00 / Start: 20:00", return 20:00 with "Start: 20:00", never the doors quote. For separate sessions at 13h and 15h, each row must quote its own chosen clock.
- NEVER put a date in time: "19.06" is not "19:06". No clock means empty time, never a guess.

=== TITLES (per row) — ONLY SOURCE-GROUNDED TITLES ===
- Use the act/event name billed for that row, exactly: "Zalazak", "Sreda na Kućici", "Los Tres", "Mladost", "Ludost". If a row bills only an artist/handle, use that as the title.
- If a row bills multiple artists, a title made only from those exact billed names is valid even when the source joins them with "and"/"i" and the normalized title uses commas. Do not reject it merely because punctuation or the connector differs.

=== VENUE (per row) ===
- If a row names its own venue, use it. Apply the canonical venue hint when it matches. For multi-row posters, do not copy a venue across rows unless shared_schedule_context.venue contains visible evidence that it applies to all rows.
- An explicit branch overrides a parent account/hint: Legat Petra Lubarde and Galerija Petra Dobrovica are separate locations within Kuca legata. Pickup, box office and meeting addresses are not event venues without an event-placement claim.
- When the Instagram source role is "venue" and a canonical venue hint is provided, use that canonical venue for every event and schedule row unless the poster or caption explicitly names a different physical venue. The venue account name does not need to be repeated in each row.
- Never use a promoter or organizer account name as the venue. For a promoter source, require an explicitly named physical venue from the poster, caption, location tag, or schedule row.
- Do not collapse a multi-date venue schedule into one event. Each "schedule_entries" item must correspond to a single explicit date from the source.
- Multi-entry root date/time/title/artists/description stay empty unless truly common. Exactly one occurrence mirrors its merged entry at root. Unclear or implausibly inferred dates stay empty.
- source_conflicts records material date/time/venue/title/artist disagreements for the SAME occurrence, with both values and a short reason; never silently select a conflicting claim. Same-source weekday contradictions also belong here. Downstream holds conflicts.
- Complementary omissions are not conflicts. Neither are casing/diacritics/punctuation, harmless aliases, a minor connector-word difference, equivalent titles (Predstava koja nema ime / Predstava nema ime), or relative/absolute phrases resolving to the same date. A generic "today" followed by a specific named event date matching the poster is not another date claim.
- Different rows, general film availability versus a specific screening, and promoter identity versus physical venue are not competing claims. Compare only what each source actually asserts for that occurrence.
- field_confirmation maps title to the billed program/act, location to city/country, location_name to physical venue, price to admission, start_time to the event start, short_description to kept facts, and artists to actual participants.
- field_confirmation evidence/evidence_snippets must contain shortest exact support quotes. Allowed source labels: caption, poster, alt_text, location_tag, canonical_hint, handle_context, inference. Unknown fields use evidence="" and evidence_snippets=[].
- Confidence rubric: use 0.95+ for exact caption/poster evidence, 0.80-0.90 for explicit evidence that required normalization or date inference, 0.60-0.75 for partial/contextual support, and below 0.55 for missing, contradictory, or fallback-only fields.
- Top-level confidence reflects publishable core fields: date, venue, title or billed act, and time when available. Do not average unrelated optional fields into the top-level confidence.
- Never return markdown, only valid JSON.
`.trim();

export const CAROUSEL_EVENT_EXTRACTION_SYSTEM_PROMPT = `
=== ORDERED CAROUSEL EVIDENCE ===
The caller has retained the exact labelled images. SLIDE numbers are zero-based original source indexes, not the order among a partial subset. Use only the supplied indexes; never claim an unread or missing slide.
Read all supplied slides jointly before emitting occurrences. One carousel is one source, not one event per image. A cover, detailed flyer, running order, artist portrait/biography and ticket slide may all describe the SAME party. Merge complementary evidence only when the same explicit event identity/date/physical venue establishes that relationship. An artist portrait or biography does not create another event or add unrelated credited people to the lineup.
A weekly cover repeated on detail slides must yield each actual occurrence once. Repeated copies of the same flyer are duplicates. Different explicit dates, independent sessions, independently named room programs or physical branches stay separate. Never cross-product the dates on a cover with every act on later slides. A common campaign design, venue logo or adjacent slide order alone cannot bind an act to a date.
Return each genuine occurrence once in schedule_entries, with its own category, price and currency. Unknown admission is empty; never copy one slide's price, restriction or room to unrelated rows. Root source_conflicts must be []; put material disagreements in the affected row's source_conflicts so an ambiguous flyer does not contaminate unrelated rows.
Carousel occurrence facts are row-owned, including when there is only one occurrence. Leave root title/date/time/venue/price/currency/description empty and root artists=[]; root date/time evidence use empty unknown semantics and slide_index=null. Leave every root field_confirmation confidence=0, found_in=[], evidence="", evidence_snippets=[], notes="". Keep is_event, non_event_reason, overall confidence, category/city/country and any genuinely universal shared context. Do not repeat row facts in root confirmations.
For every row, source_slide_indexes lists only supplied slides supporting that occurrence. Caption-only rows use []. Poster date/time evidence has slide_index identifying its exact supporting slide; caption/alt_text/unknown use slide_index=null. Empty or unstated time uses unknown and null. Source_text is ONE exact identity/dated row quote, never a fabricated concatenation of fragments from different images. Complementary date, venue or lineup fragments go in poster_evidence as {slide_index,text}: shortest exact readable quotes, at most one quote per distinct support region, no repeated explanations. Each poster_evidence slide_index must be in that row's source_slide_indexes. Caption/alt-text support goes in text_evidence as {source,text}, quoting exact contiguous row-local fragments, including a relevant shared header only when it explicitly covers that row. Preserve every explicitly billed artist, using additional exact lineup fragments when the identity row alone does not contain them. Do not quote an unrelated sibling paragraph or a whole caption for every row.
Keep shared_schedule_context empty unless a visible heading explicitly applies to ALL emitted occurrences. Poster shared context identifies the supporting slide_index; other sources use null. A cover's time or venue is not a shared fact for unrelated detail programs. Row-local explicit facts always win over a common header.
If a supplied subset is incomplete, extract only the supplied evidence. Do not invent missing slide contents, and do not treat incomplete coverage as a non-event reason. The caller controls source completion independently.
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
    `Instagram source role: ${context.instagramSourceRole ?? "unknown"}`,
    `Instagram source/account name: ${context.instagramSourceName ?? "N/A"}`,
    `Instagram location tag: ${context.instagramLocationName ?? "N/A"}`,
    `Canonical venue hint: ${context.canonicalVenueName ?? "N/A"}`,
    `Instagram caption: ${context.instagramCaption ?? "N/A"}`,
    `Instagram alt text: ${context.instagramAltText ?? "N/A"}`,
    `Source image URL: ${context.sourceImageUrl ?? "N/A"}`,
    ...(context.carouselSlideIndexes ? [
      `Carousel source declares ${context.carouselKnownSlideCount ?? "unknown"} slides. Supplied zero-based SLIDE indexes: ${context.carouselSlideIndexes.join(", ")}.`,
      "Extract one joint occurrence plan across these images; retain exact slide-local evidence and collapse repeated depictions of the same event.",
    ] : []),
    extractionMode === "caption_only"
      ? "No image is provided for this post. Use only the caption, alt text, location tag, and canonical venue hint."
      : "Use poster text + caption together. Instagram alt text can provide useful OCR-like support, but treat it as secondary evidence and do not invent unsupported facts.",
    "Use the location tag and canonical venue hint as secondary grounding when they agree with the source, but do not invent unsupported facts.",
    "If one poster contains multiple dated events for the same venue, return them in schedule_entries instead of collapsing them into one event.",
  ].join("\n");
}
