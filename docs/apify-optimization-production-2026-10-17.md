# Apify optimization and reviewed Vinyl correction, 2026-10-17

## Production release

The web release uses commit `065c717`, with the reviewed backend operator added
in `2699875`. Both commits are on `origin/main`.

- Active web container: `ig-event-web-apify-recent-065c717`.
- Source: `/root/ig_event-releases/apify-recent-065c717`.
- Compose: `/root/ig_event-release-artifacts/apify-recent-065c717/production.compose.yml`.
- Loopback endpoint: `http://127.0.0.1:3133`.
- Required dependency mount: `/root/ig_event-releases/upcoming-role-audit-c38f9d9/node_modules`.
- Previous web container retained: `ig-event-web-event-categories-62014b9`.

Keep the dependency source while this release mounts it. The main Traefik
router has priority 1002 and retains the exclusion for `/api/social`. The
separate social container and Convex backend container were not restarted.

New paid Apify acquisition is limited to a rolling 24-hour UTC window, sends
`skipPinnedPosts: true`, and starts with `basicData`. Required missing fields
and incomplete carousels trigger one targeted details phase for verified fresh
posts. All retained slides, including video previews, must be complete and
ordered. Incomplete saved Basic datasets are excluded before history deduplication;
complete historical dataset imports remain available without another paid scrape.

The production environment now agrees with these defaults: `basicData`, pinned
post skipping, and `CRON_DAYS_BACK=1`. Existing per-handle authorization of $0.01
and daily budget of $7 were retained. Both phases share the logical cap and
deadline; details can use only the verified remaining amount. If the remaining
cap cannot cover a complete source, the attempt fails without advancing its
checkpoint. A carousel can cost more than a single Basic post because it may
need both phases; no fixed percentage saving is promised.

One capped real Basic validation run, `l0gFdMKT70hL7ZaP2`, returned a fresh video
with its nonempty caption and preview, charging $0.0015. Its actual payload was
also replayed through the released adapter with network disabled, requiring
one Basic phase and no details. Private receipts are under
`/root/ig_event-release-artifacts/apify-optimization-20261017` and
`/root/ig_event-release-artifacts/apify-recent-065c717`.

## Reviewed event correction

The retained public URL is
`https://eventzeka.com/events/j57dzmm51dzqzgata6wpxs94bh8g6tkx`.
Its title is now `ĐIR`, its canonical venue is Vinyl
(`k17bp4t9435fgrfxkbpjb7ax3h897rjd`, `vinyl.belgrade`), and its date, unknown
time, both announced artists, original source and media were retained.

The existing Vinyl catalog entry was corrected to latitude `44.813957`, longitude
`20.4502897`, and `Braće Krsmanović 8, Beograd 11000` using the user's Maps link
and current venue evidence. This supersedes an incorrect exact-name match to
an OSM music shop. The separate ĐIR catalog entry was not renamed.

The Vinyl weekly schedule contained another approved row for the same Oct 18
program, `j574j5vzb12fwe8ys7n53c8mv58g79cy`. Its exact Sunday caption mentions
`@djir.bg`; its poster row states `18.10. ĐIR — KNEŽEVIĆ`. The dedicated reviewed
fold retained the requested URL, moved both complete source bindings onto it,
and rejected the redundant row. Immutable source observations and the other
weekly rows were preserved. The retained event is explicitly `publishable`.

Before folding, the weekly source still had an unbound Oct 16 expected child.
The existing processing lease and occurrence-satisfaction APIs confirmed only
that past child, retained the exact Oct 17/18 bindings, and completed the cached
source receipt. This made the weekly source complete without an Apify or OpenAI
request. No generic duplicate or publication guard was weakened.

The source account `djir.bg` is now classified as `promoter` with its active
state retained, preventing future account-name fallback to a physical venue.
Private before snapshots, plans, receipts, backend logs and public verification
are under `/root/ig_event-release-artifacts/djir-vinyl-review-20261017`.
See `docs/reviewed-promoter-schedule-fold.md` for the guarded operator contract.

## Verification

`npm run qa:release`, including the production build, 40 Apify scenarios and the
extended reviewed-fold checks, passed. Generated backend types were reviewed;
the subsequent typecheck and `git diff --check` passed. The Linux web release
passed lint, typecheck and build. Backend codegen, deployment dry run and actual
deployment succeeded; existing Convex source files, schema, configuration and
runtime versions were retained. Bundled dependency chunk hashes changed during
the rebuild.

Private preview and public checks confirmed health, expected route redirects,
all six categories, and all 14 referenced JavaScript assets. The public event
returns HTTP 200 with the corrected title, address and coordinates. At 390px,
the event and venue pages have no horizontal overflow; Vinyl's directions link
contains exactly `44.813957,20.4502897`. Both observed source payloads and the
retained event's date, time, billing, media and original extraction were checked
after the fold. Temporary preview/build containers and secret files were removed.
