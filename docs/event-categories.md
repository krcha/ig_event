# Public Event Categories

Public events have one primary category based on the event's format. Additional
tags can describe genres, activities, and explicitly stated free admission.

| Stable key | Public label | Covers |
| --- | --- | --- |
| `club` | Zurke | Parties, DJ sets, raves, and dance nights |
| `live` | Live music | Concerts, live bands, solo performers, and tribute concerts |
| `culture` | Kultura | Theatre, stand-up, exhibitions, film, performances, and discussions |
| `social` | Barovi | Social evenings, cocktail gatherings, and after-work events |
| `event` | Ostalo | Workshops, quizzes, tastings, participatory activities, sports screenings, openings, generic festivals, and other special events |

The `club` and `culture` keys retain their existing URLs with the shorter public
labels. The former `experience` filter key is an alias for `event`, and historical
links focused on either Radionice or Ostalo now select the combined Ostalo group.

When all categories are enabled, choosing one chip shows only that category.
Other chips can then be added or removed from that selection. All, or clicking
the only selected category, restores every category. Other active filters remain
in the URL while the category selection changes.

## Format And Tags

The shared implementation is `lib/taxonomy/event-categories.ts`. Public pages,
category pills, and calendar filtering use the same primary classifier.

Explicit format evidence in the event title takes priority over an old coarse
event type. A rock concert in a club is `live`; a rock DJ party is `club`; a
creative workshop at a cultural centre is `event`. A venue's category alone
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

The five categories are a public presentation taxonomy. Existing Convex fields,
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
