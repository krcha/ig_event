# Visitor analytics

The owner dashboard is at `/admin/analytics`, linked from the admin navigation.
It provides date presets and custom ranges, hourly/daily/monthly charts, live
last-hour activity, countries and a world map, devices, browsers, operating
systems, sources/campaigns, pages, links/buttons, and aggregate CSV export.
All calendar dates and buckets use `Europe/Belgrade`, including daylight-saving
changes. The dashboard refreshes every minute while its tab is visible.

## Deployment and access

1. Deploy the updated Convex schema/functions, then the Next.js application.
2. Keep Clerk and the existing `ADMIN_CLERK_USER_IDS` allowlist configured in
   both Next.js and Convex. Configure the existing Clerk `convex` JWT template.
3. Set `ANALYTICS_OWNER_CLERK_USER_ID` to the owner's single Clerk user ID in
   **both** Next.js and Convex. That ID must also appear in the admin allowlist.
   When the allowlist contains exactly one account, that account is automatically
   the owner. With multiple admins and no explicit owner, analytics fails closed.
4. Set the existing `CRON_SECRET` to the same nonempty secret in Next.js and
   Convex. Collection uses it for the server-to-server write and HMAC identifiers;
   it is never sent to the visitor. Rotating it also rotates analytics identities.

The page, Next.js read API, and Convex report action each enforce owner access.
Other signed-in users, including other administrators, cannot read analytics.
The raw event query and retention cleanup are internal Convex functions. The
public write mutation requires the server secret. No development auth bypass is
provided for the analytics page or API. Reports use `private, no-store` caching.

## Countries on Vercel and on a VPS

Vercel automatically supplies `x-vercel-ip-country`. On a VPS, location remains
`Unknown` unless a trusted proxy supplies a country or a local MMDB country
database is configured.

For the existing direct Traefik path, mount the country database read-only,
set `ANALYTICS_COUNTRY_DB_PATH` to its container path, and set
`ANALYTICS_TRUST_PROXY=true`. Keep the application listener private. The resolver
uses only the rightmost `X-Forwarded-For` address appended by Traefik, performs
an in-memory lookup, and stores only the country code. It supports both
`country_code` datasets and GeoIP2 country records. An additional proxy/CDN
requires reviewing the IP trust boundary before enabling this setting.
Missing/invalid data returns `Unknown` without losing a page view.

The production snapshot reused from the user's frame.baby deployment is
[sapics/ip-location-db user-country](https://github.com/sapics/ip-location-db),
under PDDL. Keep the database and its provenance outside Git; the existing
snapshot is 7,717,259 bytes, SHA-256
`78fc4023da74d2fb8c5e26a60938bd9ecc0de07982fe74a271a033e1c84fb213`.

For example, a site already proxied through Cloudflare can set
`ANALYTICS_COUNTRY_HEADER=CF-IPCountry` in Next.js. Only enable this when the
edge overwrites that header **and** direct access to the origin is blocked to
untrusted clients. The application does not trust arbitrary geolocation headers
by default and does not infer countries from the browser language. This setting
is included in the Docker Compose runtime environment. No visitor IP lookup is
sent to an external geolocation service.

The world outlines are public-domain Natural Earth 1:110m data:
[dataset](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_admin_0_countries.geojson),
[terms](https://www.naturalearthdata.com/about/terms-of-use/).
Regenerate the compact outlines with
`node scripts/build-analytics-world-map.mjs /path/to/ne_110m_admin_0_countries.geojson`.

## Tracking and metric definitions

| Event / metric | Meaning |
| --- | --- |
| Page view | One public pathname navigation, including returning to a page. Query/filter changes on the same pathname do not count again. React Strict Mode does not duplicate the initial view. |
| Click | A public link or button activation. Internal account/admin links and elements inside `data-analytics-ignore` are excluded. |
| Unique visitors | Distinct pseudonymous browser identifiers with a page view anywhere in the selected range. Daily uniques are not added together to obtain monthly uniques. |
| Sessions | Distinct tab session identifiers with page views. A session expires after 30 minutes without a tracked interaction. Separate tabs can count as separate sessions. |
| Visitor click rate | Visitors with a page view and at least one click in the selected range, divided by unique visitors. |
| Sources | Session-entry `utm_source`, `utm_medium`, and `utm_campaign`; otherwise the external referrer hostname, or `Direct`. Internal navigation preserves the session source. |
| Active visitors | Distinct browsers with a tracked interaction in the last five minutes. This is activity, not an exact count of open tabs. No heartbeat is sent. |
| Previous period | Immediately preceding range with the same number of civil dates; a range ending today compares the elapsed portion of its last date. |

The public routes `/`, `/events`, `/events/[id]`, `/calendar`, `/discover`, `/map`,
and `/venues` paths are eligible. Admin, auth, saved events, and profile pages
are excluded. First-party collection starts after deployment; earlier traffic
cannot be reconstructed from this feature. No demonstration data is shipped.

## Data handling and limits

- The browser stores a random visitor UUID in localStorage for 365 days and a
  tab session in sessionStorage. With unavailable storage, identifiers live only
  in memory. Clearing storage and starting a fresh page load, or switching
  browser/device, creates a new visitor.
- Convex stores HMAC-derived visitor/session IDs, event UUIDs, paths without
  query strings, bounded source/target labels, approximate country, browser,
  device, OS, and server timestamps. It does not store IP addresses, Clerk IDs,
  full referrer URLs, or browser fingerprints in analytics events. These are
  pseudonymous statistics, not person-level records in the owner dashboard.
- Do Not Track and Global Privacy Control disable collection. Detected bots are
  excluded. Analytics failure never blocks navigation and is not retried by the
  tracker, so blocked/offline requests can reduce measured traffic.
- The collector accepts same-origin JSON only, bounds streamed payloads to 4 KB,
  validates public paths/UUIDs, and strips URL parameters. Convex enforces event
  deduplication and a 60-event-per-visitor-per-minute write limit transactionally.
  This is basic noise control, not bot-proof fraud detection.
- Raw events expire after 400 days. A daily internal cron deletes indexed batches
  of 500 and schedules continuation while more expired events remain.
- Queries use indexed pagination of 500 rows, never an unbounded table collect.
  Reports cover at most 366 dates (14 for hourly detail) and 100,000 events
  including comparison/live windows. Larger requests return an explicit request
  for a shorter range rather than silently truncating counts. For sustained
  higher traffic, introduce aggregate tables before raising these limits.
- Previous-period data is only as complete as the deployed collection history
  and retention window. Missing previous data is labeled accordingly.
- CSV export contains aggregate counts only, with quoted cells and spreadsheet
  formula protection. No visitor identifiers are returned to the dashboard.

## Verification

`npm run qa:analytics` exercises the actual collector route and Convex handlers
with isolated storage: owner/other-admin/anonymous access, storage write failures
and session expiry, DST days (23/25 hours),
distinct visitors, page/click totals, privacy signals, bot filtering, trusted
country headers, body limits, duplicate IDs, rate limits, live activity during
historical queries, and batched retention. It is included in `qa:release`.

For a configured deployment, open a public page in a separate non-DNT browser,
follow a link, and check the owner dashboard. Confirm that another account
receives no analytics page/report and that `/api/admin/analytics` responses are
private and uncached. On a VPS verify the country header at the trusted ingress.
