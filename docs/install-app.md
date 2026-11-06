# EventZeka App installation guide and daily prompt

Implemented in application source on 2026-11-06. Deployment is outside this
handoff. This feature extends the existing public interface and does not change
event ingestion, moderation, authentication, Convex APIs, or the event data model.

The earlier HTML in `docs/design-proposals/install-app/` remains a historical
design artifact. Its preview controls, fixture events, and demo storage keys are
not application behavior. This document describes the implemented app source.

## Entry points and copy

- `/install` is a public installation guide and does not require sign-in.
- `/you` includes an `Instaliraj EventZeka App` link outside the account panel.
  It remains visible for guests and when Clerk is unconfigured.
- On eligible browsing routes, a small nonmodal prompt links to `/install`.
  The feature is enabled through its eligibility rules; no default-off feature
  flag hides the implementation.

| Element | Text |
| --- | --- |
| Prompt title | EventZeka App |
| Prompt description | App za dogadjaje u Beogradu |
| Primary CTA | Instaliraj EventZeka App |
| Secondary action | Ne sada |
| Close accessible name | Zatvori predlog za instalaciju |
| Guide heading | Instaliraj EventZeka App |
| Guide introduction | Izaberi uredjaj i prati korake. |
| Steps heading | Uputstvo za instalaciju |

Documentation uses ASCII. Visible Serbian text in components uses Latin
diacritics. `EventZeka App` names this installation experience. The manifest and
the illustrated native confirmation retain their existing name, `Event Zeka`.

The CTA always opens the manual guide. This implementation does not capture
`beforeinstallprompt`, call a native install API, add a service worker, or promise
offline browsing or push notifications. The visitor confirms installation in
their browser. The guide explicitly states that viewing events requires internet.

## Timing and the daily limit

`InstallPrompt` mounts once inside the shared `EventsUiProvider` in
`app/layout.tsx`. It accumulates visible time while the pathname is exactly one
of `/`, `/events`, `/calendar`, or `/discover`. A pointer, keyboard, or scroll
interaction is also required. Client navigation between eligible routes keeps
the accumulated time; hidden time and time on other routes do not count.

At 10,000 eligible visible milliseconds, the prompt can appear once all
interaction blockers clear. The interval checks every 250 ms; it does not make
the appearance deadline exact to the millisecond.

The production localStorage key is:

```text
eventzeka.install.lastShownDay.v1
```

Its value is a `YYYY-MM-DD` calendar day in `Europe/Belgrade`. The helper reuses
`getCalendarDateKeyInTimeZone` from `lib/events/nightlife-date.ts`. It follows
civil midnight and daylight saving time; it does not use the events calendar's
07:00 nightlife rollover or the visitor's machine timezone.

The entry day is pinned when the prompt component mounts. A successful reveal
records that day immediately, before any dismissal or CTA choice. Reloads and
new visits on the same browser origin, profile, and device stay suppressed for
that day. X, Escape, and `Ne sada` only close the prompt; they do not extend the
daily limit. A fresh document on the following Belgrade day becomes eligible
again after its timer, interaction, and suppression checks.

An old document never resets its entry day at midnight. It cannot reveal a new
prompt after that boundary or overwrite a newer day's marker. A client-side
route transition is not a fresh document for this purpose.

Storage errors do not break browsing. An in-memory flag still prevents a repeat
within the current component lifetime. If persistence is unavailable, same-day
suppression cannot be guaranteed across reloads or other tabs. The limit is not
account-wide or shared between devices.

Where supported, Web Locks serialize competing display claims using the same
key. Every claim checks storage again before revealing. A `storage` event for
the entry day hides a competing prompt and stops its timer. Without Web Locks,
storage events provide basic coordination; localStorage alone is not an atomic
cross-tab lock.

The application never reads or clears the standalone demo's
`ez.installProposal.v2.lastShownDay` key or its older demo markers. There is no
production reset or force-preview query parameter.

## Route and interaction safeguards

The exact route allowlist excludes `/install`, `/you`, `/saved`, `/map`, venue
and event detail pages, admin routes, and authentication routes. Existing
redirects from `/calendar` and `/events` to `/` remain unchanged.

Before display, the component waits while any of these conditions apply:

- The document is hidden or running in standalone display mode, including the
  iOS `navigator.standalone` signal.
- Events filters are open through `EventsUiProvider`.
- Focus is in an input, textarea, select, or editable element.
- A native dialog is open, an ARIA modal dialog is present, an event preview is
  expanded, an inline event post is mounted, or body scroll is locked.
- A pointer is held down, or less than 500 ms has elapsed since a scroll.

The standalone checks describe the current launch mode. They do not discover
all prior installations in other browsers.
Launching in standalone mode or with the iOS `navigator.standalone` signal
skips the timer and does not consume the daily display. If an already-visible
prompt's window changes to standalone mode, the media-query change listener
closes the prompt and clears its accessibility announcement immediately.

If the panel is already open, moving to an excluded route, opening filters,
entering a protected interaction, or hiding the document closes it. That day is
already recorded, so the panel does not reopen later in the same document.
Expanded-post detection targets only open previews; ordinary collapsed event
rows do not block the prompt.

## Layout and accessibility

The mobile prompt sits above the existing `.mobile-nav-shell`. Its offset uses
the shell's actual top edge, including safe-area clearance, plus an 8 px gap.
A `ResizeObserver` and resize listener keep the offset current. On desktop the
panel is 424 px wide in the lower-right corner, 24 px from the edge.

The panel uses z-index 45, below the mobile navigation's 50. It does not dim the
page, lock scrolling, trap focus, or move focus on automatic display. It has a
polite announcement and named close control. Escape and explicit dismissals
return focus to the previous connected element only if focus was inside the
panel. The primary CTA is a normal Next.js link.

The normal mobile panel is approximately one third of the lower screen area.
Large text and short screens take priority over that proportion: titles wrap,
the text column can shrink, and the viewport-limited panel scrolls internally
when needed. Motion is a 460 ms upward reveal only when reduced motion is not
requested.

The guide detects a likely platform after hydration and keeps a manual choice
between iPhone, Android, and computer tabs. Arrow Left/Right, Home, and End move
between tabs. The panels have named tab relationships and can receive focus.
Tab buttons keep `min-width: 0` and allow normal whitespace and long-word
wrapping, so enlarged platform names remain inside the available width.
Each platform has three steps; browser menu illustrations are semantic UI
diagrams with descriptive labels, not operating-system screenshots or live
system controls. Menus can differ by browser version or language.

The guide includes Safari on Mac and in-app-browser help, plus links to the
official Apple and Chrome instructions. Both return links go to `/`; this
implementation does not restore the previous page's filters or scroll position.

## Source map

| File | Responsibility |
| --- | --- |
| `lib/install/prompt-policy.ts` | Exact routes, civil-day helper, storage key, and pure eligibility decision. |
| `components/install/install-prompt.tsx` | Timing, local persistence, suppression, cross-tab coordination, and navigation measurement. |
| `components/install/install-prompt.module.css` | Responsive panel, reflow, scrolling, and reduced-motion reveal. |
| `components/install/install-guide.tsx` | Manual platform instructions, accessible tabs, and browser-menu diagrams. |
| `components/install/install-guide.module.css` | Guide layout and illustration styling. |
| `app/(main)/install/page.tsx` | Public guide route and canonical/title/social metadata. |
| `app/(main)/you/page.tsx` | Permanent link outside the authentication-dependent panel. |
| `app/layout.tsx` | One shared prompt mount inside the existing Events UI provider. |
| `scripts/qa-install-prompt.mjs` | Pure policy cases, including civil-day/DST boundaries, daily visits, threshold, and route scope. |

## Design-system comparison

This is an ordinary extension of `DESIGN.md` and `.impeccable/design.json`.
Both authority files remain unchanged. The implementation inherits Space
Grotesk and the existing palette: background, card, raised, foreground, muted
foreground, lime primary, and lavender focus. It reuses the existing
`/event-zeka-icon-192.png`; no new raster assets are required.

The CTA has 12 px corners, the panel 16 px corners, and icon/diagram surfaces
use the existing 14 px corner size. Typography scales, the local floating
shadow, and the 460 ms entrance are scoped to the install components rather
than new global tokens. The browser diagrams use system fonts to distinguish
native menu labels from application copy. The existing global focus outline
and guide-specific lavender ring remain available.

The checked palette, font, corner, and documented-component authorities have
no conflicting values. This comparison is not a full design-system audit; no
unrelated drift repair was performed.

## Verification handoff

Final verification on 2026-11-06:

- `npm run qa:release`: 137 checks passed; one existing check failed.
- Lint, TypeScript, the production build (32 seconds), and the new
  `qa:install-prompt` gate passed.
- `git diff --check` passed. Convex, ingestion, moderation, authentication
  contracts, shared navigation, manifest, and global styles were not changed.
- A local production-mode smoke test recorded `2026-11-06` on actual display,
  then followed the CTA to `/install` with the expected document title.
- The independent visual review returned `ship`. Its later verdict pass scored
  the 320px enlarged-text tab-wrapping fix and normal-view regression check
  resolved. The available default reviewer role substituted for the unavailable
  specialized finish reviewer.

The remaining release failure is `qa:event-extraction-contract`, with the same
two cases already failing before this feature was implemented:

- `cross-month range gets occurrence-specific normalized evidence`
- `range evidence cannot attest an outside occurrence`

Both expected `ok` but received `skip`. Extraction code and these cases were
not modified for this feature. The complete release gate is therefore not green;
this handoff is implemented application source and local verification, not a
deployment or approval to bypass the release gate.

Run `npm run qa:install-prompt` for policy coverage. It is also included in
`npm run qa:release`. Future changes must rerun the complete release gate,
including build, and `git diff --check`; the failure above remains a release
blocker. No release pass or deployment is claimed here.

Browser verification passed in the actual local Next.js application for:

- Real elapsed-time gating: absent before the threshold at 9 seconds and
  visible at the 11.2-second observation after browsing interaction.
- Same-day reload suppression and a fresh visit on the next Belgrade day.
- Suppression during focused input, an open dialog, and open Events filters.
- Hidden time, held gestures, and client navigation outside eligible routes
  pausing or deferring the prompt as appropriate.
- The CTA opening `/install`, the guide's return link, keyboard tab controls,
  and the permanent guest-visible `/you` link.
- Blocked browser storage remaining usable without crashing the feature.
- Installed-launch signals: standalone media mode and the separate iOS
  `navigator.standalone` signal each prevent the popup and daily marker after
  browsing interaction and twenty simulated seconds. In a normal-browser
  control the popup still appears after the ten-second threshold.
- A live transition into standalone mode closes an already-visible popup and
  clears its announcement without changing the daily marker. Returning to
  browser mode does not reopen it. These launch-mode signals were injected
  in Chromium; this is not a physical-device installation test.
- Responsive layout and large-text reflow, including the platform labels on
  a 320 px-wide guide after the targeted wrapping fix.

The local calendar backend was deliberately unconfigured. Expected 503
responses from local calendar/analytics endpoints did not prevent verification
of this feature, which uses localStorage and a manual guide. Those checks do
not demonstrate event-data loading, authentication, analytics delivery, or
completed native installation.

Real-app screenshots are under `.impeccable/review/install-app/`, separate from
the historical HTML proposal. The current capture set includes mobile and
small-phone prompts/guides, the Android guide, and desktop prompt/guide.
These captures demonstrate the application UI; they are not proof that a
particular phone completed native installation.

The additional [small-guide-text200.png](../.impeccable/review/install-app/small-guide-text200.png)
and [small-prompt-text200.png](../.impeccable/review/install-app/small-prompt-text200.png)
captures use computed font sizes multiplied by two. They verify this simulated
large-text condition, not native device zoom. At 320 px the document width and
all platform-label rectangles fit after the guide button wrapping adjustment.

Keep regression coverage for old tabs across midnight, competing tabs,
expanded posts, and reduced motion alongside the verified browser flows.
The scoped CSS fix retains the surface brief's layout and existing global
tokens. `DESIGN.md` and its sidecar remain unchanged; no deployment is implied
by this documentation or the browser verification.
