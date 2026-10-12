# Isolated real-post extraction evaluation

`scripts/evaluate-instagram-real-posts.mjs` tests Luna against the exact retained
captions and original public poster bytes for 23 Instagram posts audited on
2026-10-12. The manually labeled corpus is
`scripts/fixtures/instagram-real-posts-2026-10-12.json`.

The corpus includes the 83 public canonical venue names and aliases from the
audit, plus read-only production role/account-name contexts for its 21 source
handles. Both variants use the same directory and source contexts. These are
bounded fixture snapshots. For production parity, pass the separate read-only
complete resolver export with `--venue-snapshot`; the harness uses the same
operational-directory adapters as ingestion and records its digest. Keep that
local export outside Git. If a
baseline was initially run with different account context, its affected cases
must be run again under an explicitly named variant; keep the original
artifacts and report which response supplied the matched comparison.

The corpus deliberately includes failure cases and preservation controls:
American date formatting, contradictory weekdays, music repertoire, aligned
poster rows, independently named room programs, separate museum branches and
sessions, ordinary discounts, a city roundup, general film release dates,
named bar programs, doors versus start, a multi-act party, an afterparty,
explicit multiple dates, payment eligibility, one party on two floors, tribute
bands, real screenings, genuine shows inside a ticket promotion, mixed weekly
programs, and a touring performance outside Belgrade.

## Safety boundary

The script calls the production extraction wrapper and the pure
`prepareEventsForInsert` planner. It never starts ingestion, constructs a Convex
client, calls a Convex query/mutation, writes an event, or changes existing
source receipts. Importing the same registered Convex entrypoint as the QA
scripts only establishes the required module initialization order.

A network guard permits only GET of a case's exact retained image URL and one
OpenAI Responses request per case and variant. The model must be `gpt-6-luna`.
Concurrency is limited to two. It records the attempt before sending; a later
invocation resumes saved results and does not automatically retry a failed or
interrupted paid request. Use a new variant name to explicitly authorize and
identify another run.

Credentials are read from a protected key file, never supplied as a command
line value. Provider artifacts and source images must be written outside both
the repository containing the harness and the repository being evaluated.
Authorization headers and key values are not saved in reports. Retained image
and normalized provider image hashes identify the actual pixels used.

## Run a comparison

Freeze the baseline repository before changing the prompt or planner. The
baseline needs its own `lib`, `convex`, and `scripts` files, and the same installed
dependencies. The harness's `--code-root` loader resolves imports inside that
snapshot, so it tests the baseline planner as well as the baseline prompt.

```bash
node --experimental-strip-types scripts/evaluate-instagram-real-posts.mjs \
  --out /absolute/path/outside-repo/luna-evaluation \
  --variant baseline --code-root /absolute/path/frozen-baseline \
  --venue-snapshot /absolute/path/outside-repo/venue-resolver-snapshot.json \
  --key-file /absolute/path/protected-openai-key.txt --run

node --experimental-strip-types scripts/evaluate-instagram-real-posts.mjs \
  --out /absolute/path/outside-repo/luna-evaluation \
  --variant candidate --code-root /absolute/path/candidate-repo \
  --venue-snapshot /absolute/path/outside-repo/venue-resolver-snapshot.json \
  --key-file /absolute/path/protected-openai-key.txt --run
```

`--case para-october-us-dates,prorock-weekday-repertoire` selects a bounded
subset. `--concurrency 1` runs serially. One result file is saved per case;
`summary.json` records passing cases/checks, failures, token usage and duration,
plus each case's planned, approved and pending occurrence counts. It separately
counts approved rows missing a venue so an unsafe approval cannot hide behind a
correct occurrence count.
Result files retain the original valid extraction, provider envelope, request
without image payloads, normalized fields and planned event dispositions.
Unknown or incomplete responses remain failures, not non-events.
Source-code, corpus and pixel hashes identify the evaluated inputs. Total
case duration includes image loading and normalization; provider duration is
recorded separately on runs made with the current harness.

Reevaluate an existing response against a changed planner without another paid
request:

```bash
node --experimental-strip-types scripts/evaluate-instagram-real-posts.mjs \
  --out /absolute/path/outside-repo/luna-evaluation \
  --variant candidate --code-root /absolute/path/candidate-repo \
  --venue-snapshot /absolute/path/outside-repo/venue-resolver-snapshot.json --offline
```

That command changes the saved planned outcomes; preserve/copy the original
artifact directory when a before/after planner comparison is required. It does
not retest the changed prompt. Use a new variant for a fresh prompt comparison.

## Interpretation

Assertions inspect actual planned occurrences and approval status, including
date, venue, title, participant assignment, cardinality, source conflict and
time provenance. Passing schema validation alone is insufficient. A real
event should survive; a contradictory date should remain held; a routine offer
or release-only announcement should not become a scheduled performance.
The museum control requires all 17 source-confirmed sessions to approve, not
merely appear as pending rows. The dining control requires payment eligibility
and the booking channel in every occurrence's compact description.
The genuine screening, tribute, named bar-program, weekly-program and single-party
controls also require approval, so improved filtering cannot pass by holding
every legitimate event.

The planner uses a fixed evaluation date of 2026-10-01. This retains the full
October schedule and avoids wall-clock-dependent past-date failures. Original
source timestamps are preserved for relative-date resolution.

This is a purposive, single-response sample. Its passing fraction is not an
estimate of overall production accuracy or guaranteed stochastic repeatability.
Only one original image is retained publicly per image-backed case, so these
results cannot demonstrate coverage of unseen carousel siblings. Planned
approval is not a persistence-boundary attestation; existing deterministic
publication, merge safety and release gates remain required before deployment.

## Audited run on 2026-10-12

The evaluation used 23 real posts: 17 retained original posters and six caption-only
sources. Every HTTP response reported `gpt-6-luna`. The matched baseline used the
same production account contexts and complete resolver snapshot as the candidate
(579 venues and 1,248 identities). Five baseline cases were explicitly rerun after
correcting initially assumed account metadata; the other 18 original responses
were retained. The local exports and response artifacts remain outside Git.

The first full candidate used one prompt for all 23 posts. Its original 75-check
score was 20/23 passing cases and 72/75 assertions. Adding an explicit museum
approval check and strengthening positive approval controls produced the final
76-check corpus. These earlier results are preserved separately.

| Evaluation phase | Passing cases | Passing checks | Planned rows | Approved | Pending | Approved without venue |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Matched baseline, final controls | 11/23 | 48/76 | 94 | 54 | 40 | 1 |
| First full candidate, final controls | 19/23 | 72/76 | 100 | 73 | 27 | 1 |
| Fresh candidate-v2 subset | 3/3 | 8/8 | 9 | 2 | 7 | 0 |
| Final composed evaluation | 23/23 | 76/76 | 100 | 80 | 20 | 0 |

The final composed score replays 20 first-candidate responses and three fresh
candidate-v2 responses with the final planner. The fresh cases are Puter,
SoundClash and Vinyl; they verify the booking-condition fix and preserve the two
single-party controls. This is not a fresh 23-post run of one final prompt. The
54 paid calls comprise 23 original baseline calls, five corrected-context baseline
calls, 23 first-candidate calls and three candidate-v2 calls. All returned valid
responses. Offline replanning made no additional provider requests.

| Comparable response set | Input tokens | Cached input tokens | Output tokens | Reasoning tokens included in output |
| --- | ---: | ---: | ---: | ---: |
| Matched baseline, 23 posts | 207,737 | 165,110 | 48,832 | 19,649 |
| First full candidate, 23 posts | 158,517 | 118,030 | 49,718 | 18,580 |
| Fresh candidate-v2 subset, three posts | 20,856 | 10,792 | 5,967 | 2,439 |
| Final composed evaluation, 23 posts | 158,610 | 112,727 | 49,544 | 18,508 |

The first full candidate consumed 23.7% fewer input tokens. Output tokens increased
1.8%, partly because the improved extraction retained all 17 museum sessions.
The final composed set consumed 23.6% fewer input tokens and 1.5% more output
tokens. These are observed efficiency measurements, not overall accuracy or
latency estimates. Early baseline artifacts lack a separate provider-duration
measurement, so total case timings are not a fair speed comparison.

[OpenAI's Luna pricing](https://developers.openai.com/api/docs/models/gpt-6-luna)
lists $0.10 per million uncached input tokens, $0.01 cached input, $0.125 cache
writes, and $0.50 output. Applying only uncached input and output rates gives an
illustrative $0.04519 baseline versus $0.04071 first-candidate cost, 9.9% lower.
This is not observed billing: cache hits differ substantially between these runs,
and the cache-write/billing breakdown was not captured.

Passing every assertion does not mean every genuine occurrence auto-approves.
The final 20 pending rows comprise one ProRock weekday contradiction, two supported
city-roundup occurrences held by an unresolved global act/date conflict, seven
Puter occurrences whose model-supplied row quote is not contiguous source text,
nine Madlenianum plays held by a global shortened-title conflict, and one Silosi
occurrence with an inexact date quote. The Madlenianum rows also retain blank
planned venues; they are held rather than published. These are remaining limits
of autonomy. All 17 museum sessions approve, both one-party controls remain one
approved party, and the real screening/tribute/weekly-program controls approve.

Machine-readable phase summaries, source/code/pixel hashes, provenance of each
composed response, and the held rows are in the local evaluation directory's
`comparison.json`. The initial 75-check artifacts, stronger initial candidate,
fresh subset and final composed results each have separate directories.
