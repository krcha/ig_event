# EventZeka App: local design review, revision 3

Date: 2026-11-06. Scope: standalone HTML/CSS/JS proposal only.

Historical prototype review. Current application implementation and release
verification are documented in `docs/install-app.md` at the repository root.

## Repository boundary

All deliverables live under `docs/design-proposals/install-app/`. Existing app
files, dependencies declarations, production settings, services and data were
not edited. No commit or deployment was made. The existing locked dependencies
were used for the required repository checks.

## Visual review

Captured Chromium at 390x844, 320x740 and 1440x1000. iPhone, Android and desktop
instructions are illustrated HTML menus, not actual device/system screenshots.
Screenshots show a local prototype and explicitly labeled sample events.
Current popup captures have the `v3-` prefix; the unchanged guide retains its
`v2-` captures. Previous popup captures preserve older text, not the current copy.

The revision retains the exact name `EventZeka App` and primary action
`Instaliraj EventZeka App`. Popup description is now exactly
`App za dogadjaje u Beogradu` (with Serbian diacritics in HTML). The three-step
illustrated installation guide and platform tabs were retained.
Illustrated native dialogs still show the real current manifest name `Event Zeka`.

An independent fresh reviewer used the available default agent role because the
specialized Impeccable reviewer role was unavailable. The current full visual
review returned disposition `ship`, with no material visual fixes in the normal
viewport matrix. A later targeted text-enlargement check found clipping caused
by nowrap titles; those constraints were removed and normal captures regenerated.
The reviewer scored the enlarged-title clipping and retained-action fixes
resolved, with no observed regression in the eight normal captures. The final
verdict pass returned `ship` at the scope of those fixes.

The revision-2 detector scan returned zero material findings and 41 advisory
font-size/radius findings. These reflect local responsive typography and native
menu illustrations; they do not change DESIGN.md. No detector rules, files or
values were ignored. The source scan was not repeated after the wrapping fix;
that fix receives targeted browser verification instead.

The revision-3 index-only scan returned zero findings. The independent scoped
review scored the exact new copy, readability, CTA and navigation clearance
resolved at 320px, 390px and desktop, with disposition `ship` at that scope.

The supplied project icon, panorama and font files were reused unchanged.
See `assets/SOURCES.md` and the included font license.

## Prototype behavior checks

The previous version's unchanged behavioral checks remain relevant:

- No automatic display without interaction; visible-time threshold and focused
  input suppression; display after leaving the input.
- Escape focus recovery on the 320px layout. The previous session/30-day policy
  was superseded by the daily policy below.
- Hidden-time exclusion using controlled `visibilityState` and
  `visibilitychange` simulation, not an actual OS-background test.
- Guide tab ArrowLeft/ArrowRight, Home/End, one visible panel, explicit platform
  selection and iPhone/Android/desktop user-agent defaults.
- Search empty state, illustrative Save toggle and reduced-motion behavior.
- Both storage APIs throwing `SecurityError`: timed display and dismissal still
  work, without JavaScript errors.
- No horizontal overflow at 320/390/1440px; the prompt also fits 320x480.
- Requests stay local, no service-worker registration, and direct `file://`
  navigation between prompt/guide/platform tabs loads bundled images and fonts.

The current revision received a targeted browser pass: exact CTA navigation,
updated identity/guide copy, keyboard tabs, dismissal focus, and all three guide
panels at 320x480, 390x844, 768x1024 and 1440x1000. These normal-size checks
passed without clipping, horizontal overflow, JavaScript errors or external
application requests.

The listed enlargement issue was retested by doubling each element's captured
computed font size at 390x844. Both new titles remain within their containers.
At 390x480, the panel scrolls and both installation and dismissal remain usable.
Evidence: `v2-08-text200-prompt.png` and `v2-09-text200-guide.png`.
This is explicit CSS text-size simulation, not native browser/device text zoom.
The illustrative Events background has existing overflow under that simulation;
the result is a title/action fix, not whole-page text-resize conformance.

## Daily display policy

The normal demo records `YYYY-MM-DD` in `ez.installProposal.v2.lastShownDay`
when the popup is actually displayed. Calendar days use Europe/Belgrade, not a
rolling 24-hour timeout. The first eligible visit still requires 10 visible
seconds and a browsing interaction. Later visits that day are suppressed even
without dismissal. X and Ne sada only close the panel; the next day's new visit
can display it again. Old v1 dismissal and session markers are ignored.

The document pins its entry day and checks that it remains current before
display, so a tab left open across midnight does not spontaneously reopen the
popup or overwrite a newer day's marker. Storage events coordinate pending
tabs; this is not an atomic cross-tab locking guarantee. The explicit design
preview does not write a daily marker, and replay resets only the new demo key.

Independent daily browser QA passed: one real 10.7-second wait plus virtual
9.8/10.2-second boundaries, exact new description, mark-on-display, no extra
dismissal write, same-day reload/new-tab suppression, next-day fresh visit,
legacy-key isolation, preview/reset semantics, and blocked-storage fallback.
Summer and winter Belgrade midnight cases passed with the browser timezone set
to America/Los_Angeles. Old tabs remained suppressed across midnight, including
after a new-day tab displayed, without overwriting the newer marker. Pending-tab
storage-event coordination passed. No material daily-behavior bugs were found.

## Repository release gate

`npm run qa:release` completed with 136 checks passing and one failing check.
Lint, typecheck, framework compatibility and the production build passed.
`npm run build` completed in 20 seconds within the release gate.

The remaining failure is `qa:event-extraction-contract`, with these two existing
semantic cases:

- `cross-month range gets occurrence-specific normalized evidence`
- `range evidence cannot attest an outside occurrence`

Both expected `ok` and received `skip`. The same two cases failed in the
initial baseline run before the HTML proposal was written. No ingestion or
extraction changes were made to address this unrelated failure. The full
release gate is therefore NOT green; future production integration remains
subject to a clean release gate.

`git diff --check` and the standalone JavaScript syntax check passed.

## Verification limits

This artifact never invokes a native installation prompt, registers a service
worker, or calls application APIs. Real installation must be verified later on
supported iPhone/Safari, Android/Chrome and desktop browser versions. A manifest
alone is not proof of installability. Cross-route timing, application dialogs,
gesture coordination and production analytics are future integration work.
