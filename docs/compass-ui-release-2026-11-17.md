# Compass UI release, November 17, 2026

## Baseline and recovery

The release starts from production source commit
`40596d395f4432a6e703a7e43c2938bef0992575` and image
`sha256:5e949422beaec7e94ea4377d6c87d651440f7dc53adcb538ca48b1e224804724`.
The local annotated tag is `rollback/before-compass-2026-11-17`.

Before changes, the exact running image, source archive and private runtime
configuration were saved on the dedicated VPS in:

`/opt/eventzeka/private/rollback-before-compass-20261117.vklVJg`

Image decompression and Docker image loading were verified without restarting
production. SHA256SUMS covers the saved artifacts. Keep this directory private;
the Compose and inspection records include runtime credentials.

The scoped release operators are stored privately on the VPS as
`/opt/eventzeka/private/eventzeka-ui-{prepare,canary,promote,rollback}-template.py`.
The matching per-release receipt directory is
`/opt/eventzeka/private/compass-ui-<first twelve characters of release commit>/`.
For a later rollback, pass the full currently deployed compass release commit
to `eventzeka-ui-rollback-template.py`. It verifies release and configuration
identity before restoring the original application image for web and social.
It does not restore or modify the Convex database.

## Scope

- Existing Events and Discover gain optional nearest-first sorting using an
  explicit browser location request. Complete matching sets are sorted before
  virtualization or visible-deck slicing. Existing filters, saved events,
  authentication, source details and desktop layouts remain in place.
- Mobile posters retain their complete aspect ratio. Captions and compact
  transport actions overlay the image fades. Yandex Go uses a 32px original
  square asset inside a 44px target.
- `/next` confirms the current venue, asks for a vibe and presents confirmed
  open destinations in proximity order. Similar/different musical vibes use
  existing taxonomy and explicit genre families; unknown musical genres are
  not guessed. Nearby open places can be selected explicitly when vibe data
  is unavailable.
- Walking/driving times are approximate, using 4.5 km/h and 20 km/h with simple
  distance factors. Street routing is fetched only when requested, through a
  bounded same-origin POST endpoint with timeout, memory cache and upstream
  request budget. GPS is neither persisted nor placed in application URLs.
- Yandex receives destination coordinates only. Its application chooses the
  pickup point. The asset is from
  `https://go.yandex/apple-touch-icon-180x180.png`, reused from the approved
  preview. No Heineken message or assets are integrated into production.

## Verification and rollout

Run `npm run qa:release` and `git diff --check`, then retain their actual results
in the private release receipt. `qa:travel` includes genre/unknown-data,
opening-hours/arrival, distance ordering, destination-only taxi and route-proxy
validation. Build failures block promotion.

Build from the clean release commit with the production public build settings,
preserving the GeoIP database and previous static assets. Run web and social
canaries on loopback ports 3002/3003 with unique service identities. Only promote
after their health, readiness, public-page, static-asset and rendering checks
pass. Web and social use the same release image; backend, proxy and automation
containers are not recreated.

Browser checks used Chrome mobile emulation and simulated GPS, including actual
street-route response and map rendering, location denial, reduced motion,
guest save/undo and preview focus return. Physical phone orientation and native
Yandex application launch must be tested on the phone.
