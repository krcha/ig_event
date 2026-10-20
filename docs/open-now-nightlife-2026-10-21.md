# Open now: nightlife date and confirmed endings

The user requested that Tuesday's outing remain Tuesday after midnight. On
2026-10-21 they revised the public filter to exclude events whose ending cannot
be established from an announced event range or matching venue opening hours.

## Public behavior

- Home keeps its existing 07:00 Europe/Belgrade nightlife rollover, including
  when Open now is enabled. Map retains its existing 06:00 display rollover.
- Live candidate reads use civil yesterday and today, independently of the
  displayed date. This retains actual Wednesday 01:00 starts during Tuesday's
  outing and handles month/year boundaries without shifting canonical dates.
- Complete announced ranges and matching continuous venue openings use their
  exact end/closing boundary. Future starts, confirmed closures, closing gaps
  and previous nightlife days do not become possibly active.
- Missing endings/hours are distinct from closed in diagnostics, but both are
  excluded from public Open now unless a complete announced event range proves
  that the event is active. A 24/7 venue supplies no finite event ending by
  itself. No event duration is fabricated or written to ingestion/moderation.
- A complete announced event range remains authoritative even when regular
  venue hours are missing or end earlier. An event with no announced start can
  retain the existing finite, currently open venue-hours behavior.
- A known early-morning start belongs to its actual outing day. A Tuesday
  01:00 event cannot revive on Wednesday 01:00.
- Ordinary date browsing still loads that date only and does not show this
  filter's exclusions. Open now continues to refresh each minute/on visibility.

## Verification

The focused venue-hours suite covers Tuesday 23:00 -> Wednesday 01:00, exact
end/closing boundaries, unknown versus closed/partial schedules, 24/7 openings,
split gaps, current-civil early starts, no next-night revival, DST and month/year
boundaries. It also requires `matchesOpenNowEvent` to reject diagnostically
possible events while retaining known finite endings after midnight. Calendar
and map suites verify independent display/candidate dates.

The real public baseline at Wednesday 01:xx showed home incorrectly selecting
Wednesday with zero events, while map selected Tuesday with zero events. The
same public data contained 84 candidates: 37 Tuesday and 47 Wednesday. Under
the earlier uncertainty policy, a read-only diagnostic at 01:11 found 10 possible
Tuesday events, zero confirmed active events, eight mapped events and two
unmapped events. The current confirmed-only filter excludes those possible
events; a zero-event result is correct when no event has a confirmed active
window. Public data can change; these are timestamped observations, not
permanent expected counts.

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
