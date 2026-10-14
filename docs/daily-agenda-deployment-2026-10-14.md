# Three-day agenda production deployment

Deployed on 2026-10-14, Europe/Belgrade. See
[daily-agenda-posting.md](daily-agenda-posting.md) for the content and API contract.

The posting time was subsequently changed to 16:30 Belgrade on the same date.
See [the schedule update](daily-agenda-schedule-2026-10-14.md) for that change.
The current production state below includes the user's requested removal of
backups, superseded releases and undeployed preview images. The first-publication
section records the initial 00:15 run.

## Active release

- Social source: `/root/ig_event-releases/agenda-v8-20261013`.
- Runtime container: `ig-event-web-agenda-v8-release`.
- Social Compose:
  `/root/ig_event-release-artifacts/agenda-v8-20261013/compose.yml`.
- The persisted Compose file enables only the existing `/api/social` host rules,
  with Traefik priority 905. It uses its own installed dependencies and bundled
  fonts. Port 3108 is bound to loopback for operator checks.
- Main app: `ig-event-web-autonomous-moderation-f7bc8523cb4d`, with source at
  `/root/ig_event-releases/autonomous-moderation-f7bc8523cb4d` and Compose at
  `/root/ig_event-release-artifacts/autonomous-moderation-f7bc8523cb4d/production.compose.yml`.
  Its required dependency mount is
  `/root/ig_event-releases/be6575e/node_modules`.
- The previous v7 social container and superseded web containers were removed.
  They are no longer available as running fallbacks.
- Current production sources, Compose files, required dependencies, environment
  files and operational data were retained. Artifact backups, obsolete release
  sources and private preview receipts were removed at the user's request.
- The main application, Convex, ingestion, moderation, Clerk, OpenAI and Apify
  were not redeployed or migrated during this cleanup. The active instaloader
  service, its source context, session and state were retained.

## n8n

- Workflow: `EzekaDailyIg001`, existing owner project preserved.
- Published and active version: `cddfd23d-b0ea-438a-bde1-05390b6cce24`.
- Publisher SHA-256:
  `91f75ada366e550daa1fe1c301ff0639500c133ee46e7056de49e6d7907c8461`.
- Cron: `30 16 * * *`, timezone `Europe/Belgrade`.
- The latest successful publication state is for 2026-10-14, post
  `18079091330387866`, with no pending publish marker. It remains in the live
  n8n database, including the successful execution and global publication state.
- The other ten active workflow versions were unchanged. The n8n container was
  restarted after verifying that no execution was running, new or waiting.
- Temporary workflow exports and deployment backups were removed after
  verification. The operational n8n SQLite database and its Docker volume were
  retained; no credentials or database copy are in Git.

The source workflow export is intentionally inactive with null static data.
Production was updated by merging its publisher and schedule into the fresh
live export, retaining the live static data and workflow identity.

## Verification

- `npm run qa:release` and `git diff --check` passed for the final code.
- The Linux production build passed using the existing production environment.
- Staged and public checks returned three 1080 by 1350 JPEGs, with three approved
  events and three venue tags each, for 15, 16 and 17 October.
- Each image passed GET and HEAD. Stale versions returned 409; an unauthorized
  generator request returned 401. The main and n8n health endpoints passed.
- An actual n8n CLI dry run returned `dry_run`, publish date 2026-10-14, nine
  events and three slides. The temporary CLI container used dry-run mode and
  empty Meta credentials. No Instagram media was created or published by it.
- A subsequent audit confirmed the publication state was unchanged, the new
  version was active, and the main container and other active workflows matched
  the pre-deployment snapshot.

Temporary verification logs, preview JPEGs and private preview receipts were
removed after these checks. The live n8n database retains the actual publication
receipt and active workflow definition.

## First scheduled publication

Execution 143 started automatically at 00:15:00 on 2026-10-14 Belgrade time and
completed successfully at 00:16:02. Its decoded result was `published`, with
nine events, three slides and no tag fallback. The successful daily receipt
advanced to 2026-10-14, with no pending publish marker.

Read-only Instagram verification confirmed media `18079091330387866` is a
three-image `CAROUSEL_ALBUM`, published at 00:15:56 Belgrade time, with the
Serbian date labels for 15, 16 and 17 October in its caption:

[First live agenda carousel](https://www.instagram.com/p/Dec2_otjuhV/).

The decoded execution result was checked without exposing raw execution data.
Execution 143 and the latest successful receipt are retained in the live n8n
database; the temporary filesystem copies were removed. The 14 October 16:30
run will skip under the once-per-day guard. The first new post at the current
time is due on 15 October 2026 at 16:30 Belgrade, covering 16 through 18 October.

## Updates and repair

Keep successful and pending publication receipts throughout recovery. First
unpublish the daily workflow and reload its scheduler before changing the
social API contract. Do not run a manual publication to test a rollback.

There is no retained v7 container or filesystem backup to switch back to.
Build and verify any repair from the retained production sources, keeping the
social API and publisher contracts compatible. Leave the main application,
Convex data and ingestion schedule in place.

Read the latest live workflow definition and complete static data before an
update, merging into the same workflow identity. Reconcile any pending Meta
attempt first. Preserve the current successful receipt, then publish and reload
the daily scheduler only when no execution is in flight. Remove temporary
exports, logs and preview files after verification instead of retaining another
backup set.
