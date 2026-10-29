# Open now: venue availability and nightlife dates

The user requested that Tuesday's outing remain Tuesday after midnight. On
2026-10-29 they revised Open now to describe whether the venue is currently open,
using its working hours. This replaces the previous confirmed-event-ending
policy from 2026-10-21.

## Public behavior

- Home keeps its existing 07:00 Europe/Belgrade nightlife rollover, including
  when Open now is enabled. Map retains its existing 06:00 display rollover.
- Live candidate reads use civil yesterday and today, independently of the
  displayed date. This retains actual Wednesday 01:00 starts during Tuesday's
  outing and handles month/year boundaries without shifting canonical dates.
- Venue hours determine availability with an inclusive opening and exclusive
  closing boundary, including overnight periods and split opening gaps. A venue
  that reopens during the same outing becomes available again.
- Event start/end times do not establish venue availability. The current
  outing's listings can appear before the event starts or after it ends if the
  venue is open. An announced range never overrides closed or unknown venue
  hours. A verified 24/7 venue is eligible without an inferred event ending.
- Missing, invalid, source-none, conflicting source/timezone metadata and
  omitted-weekday schedules remain unknown and are excluded from public
  results. Explicitly closed days remain distinct from unknown in diagnostics.
- The existing cache refresh policy is unchanged: provider schedules are due
  for refresh after seven days, while reviewed manual schedules do not expire.
  Expiry schedules refresh rather than silently removing stored hours.
- A known early-morning start belongs to its actual outing day. A Tuesday
  01:00 event cannot revive on Wednesday 01:00. Announced times are used only to
  assign the event to its outing; unknown-time listings retain their stored
  outing date. Previous outings expire at 07:00 even in a 24/7 venue.
- Canonical event times, display-only closing inference, ingestion and moderation
  remain unchanged. Open now does not claim that an event itself is in progress.
- Ordinary date browsing still loads that date only and does not show this
  filter's exclusions. Open now continues to refresh each minute/on visibility.

## Verification

The focused venue-hours suite covers before-start/after-end listings, announced
ranges at closed/unknown venues, Tuesday 23:00 -> Wednesday 01:00, exact venue
closing boundaries, unknown versus closed/partial schedules, 24/7 openings,
split gaps and reopening, early starts, no next-night revival, cache metadata,
DST and month/year boundaries. `matchesOpenNowEvent` rejects diagnostically
possible hours. Map fixtures verify the same venue-hours eligibility in lineups,
pins and popups. Calendar/map suites retain independent display/candidate dates.

The historical 2026-10-21 public baseline at Wednesday 01:xx showed home incorrectly selecting
Wednesday with zero events, while map selected Tuesday with zero events. The
same public data contained 84 candidates: 37 Tuesday and 47 Wednesday. Under
the earlier uncertainty policy, a read-only diagnostic at 01:11 found 10 possible
Tuesday events, zero confirmed active events, eight mapped events and two
unmapped events. That investigation predates the venue-hours-only policy and is
not the current expected result set. A zero-event result is still correct when
no current-outing venue has verified open hours. Public data can change; these
are timestamped observations, not permanent expected counts.

Run `npm run qa:release` and `git diff --check` for source verification. Browser
evidence must attest the actual deployed build and compare the selected date,
eligible IDs, absence of uncertainty badges, counts and toggle-off behavior
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
