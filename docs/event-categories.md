# Public Event Categories

Calendar discovery assigns one primary category based on what attendees will
do. A second category is possible when the event advertises a separate activity.
Formats and music genres refine these groups.

| Stable key | Public label | Covers |
| --- | --- | --- |
| `party` | Na žurku | DJ sets, dance parties, raves, and club nights |
| `live` | Na svirku | Concerts, live music, recitals, and live tribute acts |
| `culture` | Film, scena i kultura | Film screenings, theatre, stand-up, and staged performances |
| `exhibition` | Izložbe i sajmovi | Exhibitions, fairs, and curated markets |
| `participate` | Kviz, igra i radionice | Quizzes, games, workshops, and other activities the audience joins |
| `food` | Hrana i piće | Tastings, special menus, and food or drink programs |
| `talk` | Razgovori i predavanja | Panels, lectures, discussions, and conferences |
| `other` | Ostali događaji | Sports screenings and events without evidence for a more specific group |

The separate legacy event filters keep the `club`, `live`, `culture`, and
`event` keys. Their older `social` and `experience` links resolve to `event`.

When all categories are enabled, choosing one chip shows only that category.
Other chips can then be added or removed from that selection. All, or clicking
the only selected category, restores every category. Other active filters remain
in the URL while the category selection changes.

## Format And Tags

The discovery catalog is in `lib/taxonomy/event-discovery.ts`. Calendar filters
and category labels use its stable keys.

Explicit format evidence in the event title takes priority over an old coarse
event type. A rock concert in a club is `live`; a rock DJ party is `club`; a
creative workshop at a cultural centre is `event`. A venue's category alone
does not establish the event's format. A genre alone does not prove that music
will be performed live. A named act on a jazz evening supports a live
performance when the announcement does not identify a DJ set, playlist, or
other program instead. Social conversation or regular food and drinks do not
add a category; a separately announced discussion or tasting can. When the title does not establish a format, the event's
own description can refine a coarse legacy type, such as a ceramics workshop
stored as `arts & culture`.

Tags overlap across primary categories and require support in the event fields.
For example, a free rock concert has primary category `live`, the label
`Live music`, and tags `Rock` and `Besplatan ulaz`. A rock DJ party can retain a
`Rock` tag while its primary category remains `club`. Artist names alone do not
invent genres, and an unknown ticket price does not imply free admission.
Conditional free entry keeps its condition in the price display rather than
receiving an unconditional free-admission tag. A DJ workshop does not imply that
a DJ set is being performed.

The daily ingestion launcher runs discovery once after the current day's
ingestion and duplicate cleanup. It only considers newly created, published
events linked to that ingestion run, and skips events already classified.
Explicit evidence in the title, occurrence text, Instagram caption, and
description can classify a row directly. Ambiguous rows go to the model with
only distinct text and the event's identity context. Date, venue and confirmed
start time identify an occurrence. They are insufficient to assign a category
or genre on their own.

The agent uses the fixed 20-genre list and saves the exact supporting excerpt.
For a post listing multiple occurrences, only excerpts scoped to the current
occurrence are eligible, even when two dates share a line. A dated live bill
can support a local genre estimate when the billed act and a specialist venue
point to the same style. If that evidence is incomplete, the model can estimate
a known billed performer's style. Web research starts with the specific listing
and billed acts, and makes a further query when the first result lacks proof.
An event listing must match the title, venue and full date and carry the style
claim on the same page. A cited performer profile can support typical style.
If the category is still unknown, the agent can also look up the exact
occurrence once and accept an activity explicitly described on that listing.
The calendar distinguishes confirmed music sources from estimates. A genre
stays blank when the available evidence is inconclusive.

In the calendar, venue hours are shown separately from the event's announced
start and do not determine its time group or chronological order.

For an explicit one-time pass over existing published music events with no
genre, run `scripts/backfill-event-genres.mjs` with the usual TypeScript loader
and a private `--journal` path. The same journal resumes a partial run, and
`--scan-only` lists candidate counts. The backfill retains existing categories
and skips events with an established genre.

## Legacy Data Compatibility

The four legacy categories are a public presentation taxonomy. Existing Convex fields,
canonical extraction types, ingestion, and moderation keep their current
contracts. Existing records remain readable without a migration or re-scrape.

The old stored types `nightlife`, `live music`, and `arts & culture` remain valid
fallback evidence for `club`, `live`, and `culture`. The old `learning` type
falls back to `event`; specific content such as an author discussion can
still classify as `culture`. More specific stored subtype labels and event
content can distinguish activities that the old types grouped together.
Historical public labels such as `Clubbing & DJ`, `Kultura & umetnost`, and
`Radionice` remain recognized without changing any stored event type.

Run `npm run qa:event-categories` for deterministic format and overlapping-tag
fixtures. This check is included in `npm run qa:release`.

## Production Deployment, 2026-10-17

The categories are live on `https://eventzeka.com/` from code commit `62014b9`.
This was a web-only release; Convex, ingestion, moderation, and the separate
social publishing service were retained.

- Main container: `ig-event-web-event-categories-62014b9`.
- Source: `/root/ig_event-releases/event-categories-62014b9`.
- Compose: `/root/ig_event-release-artifacts/event-categories-62014b9/production.compose.yml`.
- Operator endpoint: `http://127.0.0.1:3131`.
- Required dependency mount: `/root/ig_event-releases/upcoming-role-audit-c38f9d9/node_modules`.
- Previous main container retained for rollback: `ig-event-web-upcoming-role-audit-c38f9d9`.

Keep the dependency source while this release uses its read-only mount. The new
main router has priority 1001 and retains the exclusion for `/api/social`.

Local `qa:release` (including the production build and 41 category fixtures) and
`git diff --check` passed. The Linux release passed lint, typecheck, and build
with the existing production environment. Private preview checks verified all
six categories against actual approved events, hide filters, event details,
health, map, and sign-in. Public verification confirmed the six filter keys,
health, and all 14 referenced JavaScript assets against the built release.
