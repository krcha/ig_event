# Dedicated Event Zeka VPS migration

Production moved from `109.199.117.114` to `207.180.251.201` on October 31,
2026. The public site, self-hosted Convex database/functions/storage, social
renderer and four Event Zeka n8n workflows run on the new VPS. Other projects
and the other nine active n8n workflows remain on the old VPS.

## Host and runtime

- Ubuntu 22.04.5 LTS, six vCPUs, 12 GB RAM, approximately 97 GB root disk.
- All available package updates applied; rebooted into `5.15.0-202-generic`.
- Docker Engine `29.9.2`, Compose `5.6.1`, 2 GB persistent swap.
- UFW allows SSH and public HTTP/HTTPS. Application, backend, dashboard and
  automation administration ports bind to loopback only.
- The provider boot hook now reloads only the SSH master through systemd and
  tolerates SSH not being started yet. Its original unconditional `pkill -HUP
  sshd` failed during boot; running it also interrupted the migration SSH
  sessions. The corrected hook passed its module check; no failed units remain.

The production manifest is **private**, outside Git:

```sh
docker compose -f /opt/eventzeka/compose.json ps
docker compose -f /opt/eventzeka/compose.json logs --tail 100 web
docker compose -f /opt/eventzeka/compose.json up -d
```

Do not run the repository's historical shared-Traefik Compose configuration on
this host. The production stack has its own `eventzeka` network and Traefik
file provider, with no Docker socket mounted into the proxy. Its dynamic
configuration is `/opt/eventzeka/proxy/routes.yml`; certificates and ACME
account state are private beside it. Container logs rotate at 10 MB, three files.

| Service | Container | Host listener |
| --- | --- | --- |
| Website/API/ingestion | `eventzeka-web` | `127.0.0.1:3000` |
| Social renderer | `eventzeka-social` | `127.0.0.1:3001` |
| Convex backend | `eventzeka-convex-backend` | `127.0.0.1:3210`, `127.0.0.1:3211` |
| Convex dashboard | `eventzeka-convex-dashboard` | `127.0.0.1:6791` |
| Event Zeka n8n | `eventzeka-automation` | `127.0.0.1:5678` |
| HTTPS proxy | `eventzeka-proxy` | public `80`, `443` |

Persistent application data is under `/opt/eventzeka/data/`. The website and
social renderer now use **one `eventzeka/app` image from the same main release**.
They remain separate process roles to isolate video rendering from public
requests. Production social code, assets, fonts and matching QA were recovered
from the October 20 renderer and committed here; the rest of that historical
application tree was not copied over main. The image includes FFmpeg, native
Canvas, Linux dependencies and built assets, without source or `node_modules`
bind mounts. Only the renderer cache is a writable application mount.

The current source checkout is `/opt/eventzeka/source`. Runtime credentials
remain in the private Compose manifest, outside source/image layers. The
country lookup database is staged separately into `runtime/geodata` before
building. No Convex functions/schema were redeployed.

Clerk, OpenAI and Apify remain the existing external services. The active
scraper remains Apify. The previously stopped optional Instaloader collector
was not activated; its session/configuration and state were copied.

## DNS and transport

These A records now target `207.180.251.201` with a 600-second TTL:

- `eventzeka.com`
- `events.ineedtofeedmyrabbit.com`
- `convex-events.ineedtofeedmyrabbit.com`

`www.eventzeka.com` retains its CNAME to `eventzeka.com` and its existing HTTPS
redirect to the canonical apex. Clerk DNS, nameservers, email and other project
records were preserved. Valid certificates were transferred; the new proxy
uses TLS-ALPN for future automatic renewal.
Both authoritative nameservers and Google/Cloudflare public resolvers returned
the new apex address by 12:10 Europe/Belgrade.

The public Convex URL is unchanged. Server calendar reads use the new private
backend network alias. App/backend hostnames inside the web, renderer, backend
and automation containers resolve to the new host gateway, so DNS propagation
cannot send their requests to the retired origin. Public app responses carry
`X-EventZeka-Server: 207.180.251.201`.

## Schedulers

Only the four Event Zeka workflows were imported into the dedicated n8n
instance. Published nodes, connections, settings and static state matched the
original published versions. The old copies were unpublished and the shared
n8n instance was restarted to apply that change; its other workflows remain.
New n8n readiness returned HTTP 200 and indexed four published workflows.

Host scheduling retains `Europe/Belgrade`:

- `ig-event-durable-daily.timer`: daily at 09:00.
- `ig-event-following-discovery.timer`: Mondays at 04:00.

Their previous trigger timestamps were copied before enabling them, avoiding
an unintended weekly catch-up scrape. The interrupted daily run was explicitly
resumed through the existing six-worker durable runner. The private
`/etc/ig_event/cron.env` targets `http://127.0.0.1:3000`, including the executor
origin. Do not enable legacy ingestion timers alongside the durable timer.

```sh
systemctl list-timers 'ig-event-*' --all
systemctl status ig-event-durable-daily.service
journalctl -u ig-event-durable-daily.service --since today
```

The old Event Zeka schedules and workflows are disabled. Obsolete containers,
application releases and their dependency trees are removed after verifying the
new image. Other projects and their shared n8n instance are outside this cleanup.
An offline migration checkpoint remains on the new host; it is recovery data,
not another running application. The new runtime has no dependency on the old VPS.

## Data and recovery evidence

The old backend stopped at **11:50:38 Europe/Belgrade**. Its final database,
credentials, immutable file objects and deployed modules were copied while it
remained stopped. The final copy completed at 11:53:21; the new backend start
was requested at 11:54:03. DNS cutover followed the HTTP and TLS checks.

All **13,377 files** passed SHA-256 comparison and SQLite
`PRAGMA integrity_check` returned `ok` before startup. Both manifest copies have
SHA-256:

```text
95ba37edfeca0d77b3a59e3323e90e2343e477309c9dac8079e3b2a5f214a36c
```

An offline checkpoint is retained at
`/opt/eventzeka/private/migration-checkpoint-20261031`. Its database is a separate
copy; immutable media/modules are hardlinked to retain objects even if normal
retention later unlinks live files. This is a migration recovery point, not a
claim that provider or recurring off-server backups have been configured.
See [the backup runbook](server-backups.md).

All five original runtime images matched the source layer identities,
architecture, startup commands and image environment. Local image mappings are
in `/opt/eventzeka/private/image-identity.json`. On this host, loading the
unnamed multi-image archive exposed only its first image. Individual image
restores succeeded. Future image backups must verify that every recorded image
can actually be restored, not merely that the archive checksum matches.
The renderer's additional 33 reel-cache files were separately copied, passed
SHA-256 comparison, and were included in the migration checkpoint.

## Verification

- Initial migration: `npm run qa:release` passed all 134 checks, including build.
- `git diff --check`: passed.
- Public HTTPS and the canonical `www` redirect verified on the new origin.
- Calendar, map, Discover, venue directory, sign-in and sign-up returned 200.
- Calendar overview returned 398 groups and 172 venues at the smoke-test time.
- Browser loaded the calendar and an enabled Clerk registration form.
- Unauthenticated cron requests returned 401; protected admin API failed closed.
- Clerk, Apify and OpenAI API authentication returned 200 from the new VPS.
- Social agenda metadata and a generated JPEG returned 200; the JPEG was
  283,374 bytes. No social post was manually published during verification.
- Backend admin/function access worked, and its five environment variables
  contained no reference to the old IP.
- The resumed run advanced from 703 to 707 completed receipts out of 760 in
  two observations. It remains an ongoing scheduled job. New-container logs
  confirmed 21 Apify requests, four successful durable image writes and six
  inserted events by 12:06 Europe/Belgrade. These are observations from the
  continued production run, not a synthetic paid test or a claim that the
  entire daily run has finished.

The checks did not create a real user account or impersonate an existing admin.
Private smoke receipts, migration logs and recovery credentials stay under
`/opt/eventzeka/private/`, outside Git. The temporary inter-server transfer key
was revoked after copying.

## Unified release and public UI

Guest saves use one versioned localStorage key per event, containing only public
card fields. They persist across reloads and appear in Saved without Clerk.
After login, an additive import uses the existing authenticated save endpoint,
with three concurrent requests, explicit `saved: true`, account-switch fencing
and revision checks. Failed imports retain device copies bound to their intended
account. Existing account saves are preserved; logout does not copy an account's
library into guest storage. Storage failures report an error without claiming a
successful save. No data model or private API authentication was changed.

Long agenda groups use measured window virtualization with overscan, retained
focus/preview rows and full-data category counts. Small groups stay ordinary
lists. Busy venue contents mount when expanded. Time groups retain their
existing date semantics, with After midnight displayed last.

`qa:guest-saves-and-virtualization` exercises the actual provider with controlled
authentication/transport ordering and the TanStack virtualizer with 1,000 rows.
`qa:social-runtime` checks publishing state machines with mocked transports and
actually encodes/decodes Story and Reel videos. These tests never publish a post.

Unified release verification on October 31:

- Full `qa:release`: 136 gates passed, including production build; diff check clean.
- The Linux Docker build separately passed lint, typecheck and build.
- Candidate container returned 200 for calendar, Saved, Discover, map, sign-in
  and sign-up. Guest Save and reload persistence passed with auth enabled.
- Authorized carousel, Story and Reel payloads returned 200; unauthorized
  requests returned 401. Generated JPEGs and an 18-second Reel MP4 passed.
- Browser checked desktop/mobile scrolling, category counts, open preview
  retention and a 390 px viewport without horizontal overflow. For the same
  142-event day, initial DOM elements decreased from 4,717 to about 2,100.
- Authenticated sync was verified through the actual provider with controlled
  auth and HTTP responses, without creating or impersonating a Clerk account.
- The resumed daily run reached `completed`: 760/760 terminal receipts, zero
  in flight, 19 individual failed receipts. The systemd service exited 0 and
  the next daily/weekly triggers remain scheduled. Individual source failures
  remain visible through the existing ingestion reporting.
