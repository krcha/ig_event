# Events App Done Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Define the remaining work needed to call the Belgrade Instagram events app "done" for a first production release.

**Architecture:** The app is a self-hosted Next.js 14 Docker service at `https://events.ineedtofeedmyrabbit.com`, using Convex for data, Clerk for admin auth, Apify for Instagram scraping, and OpenAI for extraction/review. Production readiness depends less on new feature work now and more on scheduler reliability, admin/operator verification, monitoring, data-quality acceptance, and a clean deploy/release path.

**Tech Stack:** Next.js, TypeScript, Docker Compose, Traefik, Convex, Clerk, Apify, OpenAI.

---

## Current Verified State

Checked on 2026-06-06 UTC:

- Public app is live:
  - `https://events.ineedtofeedmyrabbit.com/api/health` -> HTTP 200
  - `/events` -> HTTP 200 and renders event feed
  - `/calendar` -> HTTP 200 and renders June 2026 calendar
  - `/events/[eventId]` -> renders event detail page
  - `/events?q=akademija` -> search filters by venue/name/artist scope
- Docker service:
  - Container `ig-event-web` is `healthy`
  - Traefik labels route `events.ineedtofeedmyrabbit.com` to the container
- Release gate:
  - `npm run qa:release` passed
  - `git diff --check` passed
- Data snapshot:
  - Venues: 505 total, 503 active, 503 active unique Instagram handles
  - Events: 382 approved, 4 pending, 0 rejected
  - Upcoming approved events from today: 368
- Latest full ingestion job:
  - Job `jn761wg6mwm55k49j6v6fb0k458844fd`
  - Status: `completed`
  - Source: `manual_all_active_venues`
  - Handles: 394
  - Results limit: 3
  - Days back: 10
  - Fetched posts: 631
  - Inserted events: 82 total, 72 approved, 10 pending
  - Skipped duplicates: 155
  - Failed downloads/conversions/extractions: 0/0/0
  - Recorded errors: 1
- Apify connectivity:
  - Recent Actor runs are succeeding at roughly `$0.0015` each.
- Cron/security:
  - `/api/cron/ingest-venues` without auth -> 401
  - `/api/cron/discover-following` without auth -> 401
- Current gap found:
  - Repo has `vercel.json` cron config, but host cron/systemd timers are not installed on this VPS.
  - Hermes cron has an Apify usage watchdog, but not the app ingestion/discovery schedule.
  - Working tree has untracked temporary scripts and test output.

---

## Done Criteria

Call the app "done" when all of this is true:

1. **Public product works:** event feed, calendar, detail pages, and search load with no application error.
2. **Admin workflow works:** signed-out users cannot access admin; the real admin can sign in, review pending events, run manual scrape, and see job summaries.
3. **Scheduled ingestion is real:** daily venue ingestion and weekly curator-following discovery run on the VPS, not only in `vercel.json`.
4. **Ingestion covers current scale:** a scheduled or manual all-active run processes the current 503 active handles with cap 600 and records a completed job summary.
5. **Data quality is acceptable:** pending queue is small and understandable; spot-checked approved listings are accurate enough for public browsing.
6. **Monitoring exists:** uptime, scheduler failure, stale-ingestion, Apify/OpenAI spend, and Convex error checks have an owner or alert path.
7. **Release path is clean:** repo has no accidental temp artifacts, code is committed/pushed, release gate is green, and the running deploy matches the intended production compose/env path.
8. **Runbook is sufficient:** restart, rollback, cron, and common failure recovery are documented and verified against the actual VPS layout.

---

## Remaining Work Plan

### Task 1: Clean the repository handoff state

**Objective:** Remove ambiguity from local artifacts before declaring release-ready.

**Files:**
- Review/delete or promote:
  - `scripts/tmp-patch-ingestion-job.ts`
  - `scripts/tmp-resume-ingestion-job.ts`
  - `scripts/tmp-run-all-active-venues.ts`
  - `scripts/tmp-verify-ingestion-job.ts`
  - `test-results/.last-run.json`

**Steps:**
1. Decide whether each `scripts/tmp-*` file is a reusable ops script or just a one-off rescue script.
2. If reusable, rename to a stable name under `scripts/ops/` and document usage.
3. If not reusable, delete it.
4. Keep Playwright/test output ignored; do not commit `test-results`.
5. Run:
   ```bash
   git status --short --untracked-files=all
   npm run qa:release
   git diff --check
   ```
6. Expected: only intentional tracked changes remain; release gates pass.

### Task 2: Standardize the production deployment path

**Objective:** Make the running container reproducible and not dependent on ad-hoc local state.

**Files:**
- `docker-compose.runtime.yml`
- `docker-compose.yml`
- `docs/operations-runbook.md`
- `/root/ig_event/.env.local` or better `/opt/ig_event/.env.production` on the VPS

**Steps:**
1. Decide whether current runtime compose is the production path or only a temporary bind-mount path.
2. Prefer the documented production path:
   - env file outside repo: `/opt/ig_event/.env.production`, chmod 600
   - build with production public env values
   - run via Docker Compose with restart policy and healthcheck
3. Verify config without printing secrets:
   ```bash
   docker compose --env-file /opt/ig_event/.env.production config
   ```
4. Deploy/restart:
   ```bash
   docker compose --env-file /opt/ig_event/.env.production up -d --build
   ```
5. Verify:
   ```bash
   docker ps --filter name=ig-event-web
   curl -fsS https://events.ineedtofeedmyrabbit.com/api/health
   curl -fsS -I https://events.ineedtofeedmyrabbit.com/events
   curl -fsS -I https://events.ineedtofeedmyrabbit.com/calendar
   ```

### Task 3: Install real VPS scheduled jobs

**Objective:** Replace inert Vercel cron config with actual host scheduling for the self-hosted deployment.

**Files:**
- Create: `/etc/ig_event/cron.env`
- Create either:
  - `/etc/cron.d/ig_event`, or
  - systemd service/timer units for better logs
- Update: `docs/operations-runbook.md`

**Required schedules:**
- Daily active-venue ingestion: `0 7 * * *` UTC -> `/api/cron/ingest-venues`
- Weekly following discovery: `0 10 * * 1` UTC -> `/api/cron/discover-following`

**Steps:**
1. Put only non-git runtime values in `/etc/ig_event/cron.env`:
   ```env
   APP_ORIGIN=https://events.ineedtofeedmyrabbit.com
   CRON_SECRET=<same value as app runtime CRON_SECRET>
   ```
2. Install cron or systemd timer calls using:
   ```bash
   . /etc/ig_event/cron.env
   curl -fsS -H "Authorization: Bearer ${CRON_SECRET}" "${APP_ORIGIN}/api/cron/ingest-venues"
   curl -fsS -H "Authorization: Bearer ${CRON_SECRET}" "${APP_ORIGIN}/api/cron/discover-following"
   ```
3. Do not manually trigger full ingestion unless the user accepts the expected Apify/OpenAI spend.
4. Verify unauthorized requests still return 401.
5. After the first scheduled run, verify a new `ingestionJobs` row exists and has `status=completed`.

### Task 4: Prove the new 600-handle cap with a real run

**Objective:** Confirm current active scale is actually covered.

**Context:** Latest completed full run processed 394 handles, while current active unique Instagram handles are 503. The app now has a 600 cap, but it still needs a completed run showing that the current active set is handled.

**Steps:**
1. Wait for the 23-hour cooldown to expire or explicitly authorize a bounded manual run.
2. Trigger daily cron or manual all-active ingestion with:
   - results limit: 1 for daily run, or 3 only if doing a deeper manual refresh
   - days back: 10
   - max handles: 600
   - per-run Apify cap: `$0.02`
3. Verify job summary:
   - `status=completed`
   - handles close to 503, unless cooldown intentionally skipped some
   - `skippedDueToRunLimit=0`
   - failed downloads/conversions/extractions near zero
   - errors reviewed and either fixed or accepted
4. Verify public data changed or stayed stable for a sensible reason.

### Task 5: Add stale-ingestion and failure monitoring

**Objective:** Make failures visible without manual checking.

**Files:**
- Add a script under `~/.hermes/scripts/` or repo `scripts/ops/`
- Add a Hermes cron or systemd timer
- Update `docs/operations-runbook.md`

**Checks:**
1. Public health is 200.
2. Docker container is healthy and not restarting.
3. Latest successful `cron_active_venues` ingestion is not older than 26 hours.
4. Latest weekly discovery is not older than 8 days.
5. Recent ingestion errors are below threshold.
6. Apify/OpenAI usage is below budget thresholds.
7. Convex insights show no recent failing functions/resource limit issues.

**Verification:**
- Force the script into a dry-run/report mode and confirm it prints the exact alert text it would send.
- Keep normal mode silent unless thresholds are crossed.

### Task 6: Admin workflow smoke test with the real admin user

**Objective:** Verify the protected human operator flow that cannot be proven from signed-out checks alone.

**Requires:** User/admin signs in through Clerk.

**Steps:**
1. Open `/admin` and confirm only the admin can view it.
2. Open `/admin/scraper` and confirm:
   - latest jobs are visible
   - counts make sense
   - errors are readable
3. Open `/admin/venues` and confirm active venue count and handles are visible.
4. Review the 4 current pending events and either approve/reject/fix them.
5. Run a tiny manual scrape for one known handle if acceptable, then verify job summary.

### Task 7: Data-quality acceptance pass

**Objective:** Decide if the public calendar is trustworthy enough for launch.

**Steps:**
1. Spot-check 20 approved events across:
   - today/tomorrow
   - weekend
   - different venue categories
   - events from the latest ingestion job
2. For each, compare title/date/time/venue against source Instagram link.
3. Review pending queue reasons and ensure they are expected conservative false negatives.
4. Check duplicate groups on the public list/calendar.
5. Define an acceptable launch threshold, for example:
   - 0 critical wrong-date/wrong-venue errors in the spot-check
   - pending queue under 25 items or reviewed daily
   - no visible duplicate clusters in top 2 pages/calendar current week

### Task 8: Commit, push, and tag the release state

**Objective:** Make the deploy state recoverable.

**Current blocker:** Earlier push attempts failed because GitHub auth was missing. Resolve token/SSH key before this task.

**Steps:**
1. Confirm final status:
   ```bash
   git status --short
   npm run qa:release
   git diff --check
   ```
2. Commit final cleanup/docs/ops changes.
3. Push branch to GitHub.
4. Merge or fast-forward the production branch.
5. Tag a known-good release, e.g. `events-v0.1-production`.
6. Record rollback SHA in the runbook or deployment notes.

---

## Suggested Priority Order

1. Install scheduler/timers and monitoring.
2. Prove one current-scale run after cooldown.
3. Admin login/manual workflow smoke test.
4. Review pending queue and spot-check approved events.
5. Clean temp artifacts and push/tag release state.
6. Standardize production compose/env if not already done.

---

## What Can Wait Until After "Done"

These are useful but should not block the first production-done call:

- Full visual redesign.
- Replacing Convex, Clerk, Apify, or OpenAI.
- Perfect venue taxonomy cleanup.
- Bulk moderation UX beyond what is needed for the current small pending queue.
- Advanced analytics beyond basic uptime/spend/failure alerts.

---

## One-Sentence Status

The app is functionally live and release gates pass, but I would not call it fully "done" until real VPS scheduling/monitoring is installed, one current-scale 503-handle run is verified, the admin workflow is smoke-tested by the real admin, pending events are reviewed, and the repo/deploy state is cleaned and pushed.
