# Public Event Categories

Public events have one primary category based on the event's format. Additional
tags can describe genres, activities, and explicitly stated free admission.

| Stable key | Public label | Covers |
| --- | --- | --- |
| `club` | Clubbing & DJ | Parties, DJ sets, raves, and dance nights |
| `live` | Live music | Concerts, live bands, solo performers, and tribute concerts |
| `culture` | Kultura & umetnost | Theatre, stand-up, exhibitions, film, performances, and discussions |
| `social` | Barovi & social | Social evenings, cocktail gatherings, and after-work events |
| `experience` | Radionice & iskustva | Workshops, quizzes, tastings, and participatory activities |
| `event` | Ostalo & specijalni dogadjaji | Sports screenings, openings, generic festivals, and other special events |

The application renders Serbian labels with their normal diacritics. Stable
keys keep existing category URLs and calendar hide filters compatible.

## Format And Tags

The shared implementation is `lib/taxonomy/event-categories.ts`. Public pages,
category pills, and calendar filtering use the same primary classifier.

Explicit format evidence in the event title takes priority over an old coarse
event type. A rock concert in a club is `live`; a rock DJ party is `club`; a
creative workshop at a cultural centre is `experience`. A venue's category alone
does not establish the event's format. A genre alone does not prove that music
will be performed live. When the title does not establish a format, the event's
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

## Legacy Data Compatibility

The six categories are a public presentation taxonomy. Existing Convex fields,
canonical extraction types, ingestion, and moderation keep their current
contracts. Existing records remain readable without a migration or re-scrape.

The old stored types `nightlife`, `live music`, and `arts & culture` remain valid
fallback evidence for `club`, `live`, and `culture`. The old `learning` type
falls back to `experience`; specific content such as an author discussion can
still classify as `culture`. More specific stored subtype labels and event
content can distinguish activities that the old types grouped together.

Run `npm run qa:event-categories` for deterministic format and overlapping-tag
fixtures. This check is included in `npm run qa:release`.
