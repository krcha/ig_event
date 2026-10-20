# Open now: nightlife date and uncertain endings

The user requested that Tuesday's outing remain Tuesday after midnight and
explicitly chose to include possibly ongoing events with an uncertainty label.

## Public behavior

- Home keeps its existing 07:00 Europe/Belgrade nightlife rollover, including
  when Open now is enabled. Map retains its existing 06:00 display rollover.
- Live candidate reads use civil yesterday and today, independently of the
  displayed date. This retains actual Wednesday 01:00 starts during Tuesday's
  outing and handles month/year boundaries without shifting canonical dates.
- Complete announced ranges and matching continuous venue openings use their
  exact end/closing boundary. Future starts, confirmed closures, closing gaps
  and previous nightlife days do not become possibly active.
- Missing endings/hours are distinct from closed. Eligible unresolved events
  appear as `Possibly still on - end unconfirmed` on home rows, desktop map
  lineup and mobile map popups. The label is an eligibility assumption; it
  does not write a fabricated event end or alter ingestion/moderation.
- A known early-morning start belongs to its actual outing day for possible
  eligibility. A Tuesday 01:00 event cannot revive on Wednesday 01:00.
- Ordinary date browsing still loads that date only and does not show this
  uncertainty badge. Open now continues to refresh each minute/on visibility.

## Verification

The focused venue-hours suite covers Tuesday 23:00 -> Wednesday 01:00, exact
end/closing boundaries, unknown versus closed/partial schedules, 24/7 openings,
split gaps, current-civil early starts, no next-night revival, DST and month/year
boundaries. Calendar and map suites verify independent display/candidate dates.

The real public baseline at Wednesday 01:xx showed home incorrectly selecting
Wednesday with zero events, while map selected Tuesday with zero events. The
same public data contained 84 candidates: 37 Tuesday and 47 Wednesday. Under
the newly authorized policy, a read-only diagnostic at 01:11 found 10 possible
Tuesday events, zero confirmed active events, eight mapped events and two
unmapped events. Public data can change; these are timestamped observations,
not permanent expected counts.

Run `npm run qa:release` and `git diff --check` for source verification. Browser
evidence must attest the actual deployed build and compare the selected date,
eligible IDs, uncertainty badges, counts, mobile popup and toggle-off behavior
with a contemporaneous read-only public-data snapshot.

## Production retention policy

Maintain one active web release and one stopped rollback release. Required
backend, proxy, scheduler and social-generation services are parts of the same
production system, not disposable duplicate web copies. Remove temporary build
and preview containers after verification. Preserve mounted shared dependencies,
current data/configuration and one verified backup before removing old releases.
Never use a host-wide Docker/volume prune for project cleanup.

Application source and reviewed operational documentation belong in GitHub.
Credentials, live databases, private exports, runtime environment and browser
session data remain outside Git in restricted server storage.
