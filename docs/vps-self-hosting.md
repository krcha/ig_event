# Cheapest VPS Self-Hosting Path

This path self-hosts only the Next.js web app on a small VPS. Keep Convex, Clerk,
OpenAI, and Apify hosted for the first migration. That gives the project a cheap
fixed app-hosting bill without taking on database, auth, scraping, or model
infrastructure operations.

Checked against this repo on 2026-06-05:

- The app is a standard Next.js 14 app with `npm run build` and `npm run start`.
- The in-repo deployment path is intentionally one web container using
  `next start`. A smaller image using Next standalone output is deferred because
  it requires a `next.config.mjs` change and more production verification.
- `vercel.json` configures Vercel Cron for `/api/cron/ingest-venues`; on a VPS,
  replace that with host cron or a systemd timer.
- Runtime configuration comes from `.env.example`. Do not bake secrets into the
  image.
- `NEXT_PUBLIC_CONVEX_URL` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` are public
  build-time values for the browser bundle. Build the image with the same public
  values you intend to run in production.
- Set both OpenAI model env vars explicitly. The low-cost template uses
  `gpt-4.1-mini`; leaving them blank falls back to code defaults that may cost
  more.

## Recommended Shape

Use the existing VPS, Docker Compose for the Next app, Caddy or nginx for TLS,
and host cron for ingestion. Do not self-host Convex, Clerk, OpenAI, or Apify in
this phase.

```text
internet
  -> Caddy/nginx on VPS :443
  -> Docker container on 127.0.0.1:3000
  -> hosted Convex, Clerk, OpenAI, and Apify over HTTPS
```

## Financial Tradeoffs

The fixed cost you are moving is the Next app host. The variable costs for
OpenAI and Apify, plus any hosted Convex or Clerk plan costs, remain unchanged.

| Option | Fixed app-host cost | Why pick it | Tradeoff |
| --- | ---: | --- | --- |
| Hetzner CX23 in EU | About EUR 3.99/mo after the 2026 price adjustment | Lowest simple x86 VPS shape that is still comfortable for one small Next app | You own OS patching, Docker updates, TLS, cron, and recovery |
| DigitalOcean smallest Droplet | Starts at USD 4/mo | Easier UI and broader docs | Very small tiers can be tight for Next builds; a larger tier may erase the savings |
| Stay fully hosted on Vercel | Potentially zero or low fixed cost at small scale | Lowest operational burden | Less control, Vercel-specific cron, and possible plan limits |
| Self-host more services now | Could reduce some vendor bills later | More control over the full stack | Not cheapest in engineer time; database/auth/scraper/model operations add real failure modes |

Sources to re-check before buying:

- [Hetzner cost-optimized cloud](https://www.hetzner.com/cloud/cost-optimized)
- [Hetzner 2026 cloud price adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)
- [DigitalOcean Droplet pricing](https://www.digitalocean.com/pricing/droplets)

## Cheapest Monthly Cost Model

At current small scale, optimize for low fixed cost and controlled usage:

| Cost center | Cheapest practical choice | Financial note |
| --- | --- | --- |
| Web hosting | Existing VPS | Incremental cost is $0 if the VPS already has spare RAM/CPU. |
| Convex | Hosted Free/Starter | Free tier covers early usage; self-hosting adds backup and database operations before it saves meaningful money. |
| Clerk | Hobby | Free up to the current Hobby limits; keep admin-only usage tiny. |
| OpenAI | Explicitly set `OPENAI_VISION_MODEL=gpt-4.1-mini` and `OPENAI_REVIEW_MODEL=gpt-4.1-mini` | Usage-based; cap spend in the OpenAI dashboard and avoid reprocessing old posts. |
| Apify | Free plan first | The first real cost pressure is scraping volume. Keep cron daily or manual until you see demand. |
| Backups/monitoring | Provider snapshot plus one external uptime check | Enough for launch; do not add a paid observability stack yet. |

Current vendor pages to re-check before a production launch:

- [Convex pricing](https://www.convex.dev/pricing)
- [Clerk pricing](https://clerk.com/pricing)
- [OpenAI API pricing](https://openai.com/api/pricing/)
- [Apify pricing](https://apify.com/pricing)

Practical monthly target:

- If you already own the VPS: $0 fixed app-hosting cost, with variable OpenAI and
  Apify usage.
- If you buy a new VPS: roughly the smallest reliable VPS bill plus variable
  OpenAI and Apify usage.
- Do not migrate Convex or Clerk off managed services until their bill is larger
  than the time cost of operating replacements.

Recommendation: if you already have a VPS with spare RAM, use it first and make
the app's incremental hosting cost $0. For a new VPS, start with 2 vCPU / 4 GB
if builds happen on the server. A 1 GB VPS may run the container, but building
Next.js inside it is more likely to fail or swap. If the only goal is the
absolute minimum bill, build the image elsewhere and run the smaller VPS only as
a container host.

## Hosted Services to Keep

Keep these outside the VPS:

- Convex: hosted database/functions. The Next app only needs
  `NEXT_PUBLIC_CONVEX_URL` at runtime.
- Clerk: hosted auth. Configure the production domain and redirect URLs in
  Clerk, then provide the publishable and secret keys to the VPS runtime.
- OpenAI: hosted model API. The app calls it during extraction/review flows.
- Apify: hosted Instagram scraping actor. The app calls Apify from API routes.

Do not put `CONVEX_DEPLOY_KEYS` in the VPS runtime env unless a deploy process
on that server truly needs it. A running Next app should not need Convex deploy
keys.

## VPS Bootstrap

Use Ubuntu LTS or Debian stable. Keep the host minimal:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git ufw
```

Install Docker Engine and the Compose plugin from Docker's official docs for the
chosen distro, then verify:

```bash
docker version
docker compose version
```

Lock down the firewall:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## Runtime Environment

Create the runtime env file on the VPS, outside the git checkout. Start from
[.env.production.example](../.env.production.example):

```bash
sudo mkdir -p /opt/ig_event
sudo cp .env.production.example /opt/ig_event/.env.production
sudo chmod 600 /opt/ig_event/.env.production
```

Use the `.env.example` contract:

```env
NODE_ENV=production
PORT=3000
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
NEXT_PUBLIC_CONVEX_URL=
CONVEX_DEPLOYMENT=
ADMIN_CLERK_USER_IDS=
OPENAI_API_KEY=
APIFY_API_TOKEN=
APIFY_INSTAGRAM_ACTOR_ID=apify/instagram-post-scraper
OPENAI_VISION_MODEL=gpt-4.1-mini
OPENAI_REVIEW_MODEL=gpt-4.1-mini
CRON_SECRET=
EVENTS_TIMEZONE=Europe/Belgrade
APP_BIND=127.0.0.1
APP_PORT=3000
```

`OPENAI_REVIEW_MODEL` is optional in code today, but set it explicitly for cost
control.

Set `CRON_SECRET` in production. If it is blank, the cron endpoint intentionally
allows unauthenticated calls for local convenience.

## Container Deployment

The repo includes a production [Dockerfile](../Dockerfile), [.dockerignore](../.dockerignore),
[docker-compose.yml](../docker-compose.yml), and a health endpoint at
`/api/health`.

Because Compose uses the shell environment or an explicit env file for
interpolation, pass `.env.production` when building:

```bash
docker compose --env-file .env.production up -d --build
```

If you keep the env file outside the checkout at `/opt/ig_event/.env.production`,
either copy it into the checkout before deploying or run Compose with that
absolute path:

```bash
docker compose --env-file /opt/ig_event/.env.production up -d --build
```

The default compose binding is `127.0.0.1:3000`, so expose the app through a
reverse proxy rather than directly to the internet.

Deploy or update:

```bash
cd /opt/ig_event/app
git fetch origin
git checkout main
git pull --ff-only
docker compose --env-file /opt/ig_event/.env.production up -d --build
```

## Reverse Proxy

With Caddy, the site block can stay this small:

```caddyfile
events.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Point DNS `A` and/or `AAAA` records at the VPS, then reload the proxy. Caddy
will handle Let's Encrypt certificates automatically when ports 80 and 443 are
reachable.

## Cron Replacement

`vercel.json` will no longer schedule ingestion once the app is off Vercel. Use
host cron first because it is cheap and understandable.

Create `/etc/ig_event/cron.env` with:

```env
APP_ORIGIN=https://events.example.com
CRON_SECRET=
```

Install a cron entry:

```cron
TZ=Europe/Belgrade
0 8 * * * . /etc/ig_event/cron.env; curl -fsS -H "Authorization: Bearer ${CRON_SECRET}" "${APP_ORIGIN}/api/cron/ingest-venues" >/dev/null
```

If cron reliability becomes important, promote this to a systemd timer so logs
and failures are easier to inspect.

## Verification

After each deploy:

```bash
docker compose --env-file /opt/ig_event/.env.production ps
docker compose --env-file /opt/ig_event/.env.production logs --tail 100 web
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS -I http://127.0.0.1:3000/events
curl -fsS -I https://events.example.com/events
```

Then verify the app behavior:

- Public pages load at `/events` and `/calendar`.
- Clerk sign-in works against the production domain.
- Admin pages are visible only to `ADMIN_CLERK_USER_IDS`.
- Manual admin scrape still reaches Apify and writes to hosted Convex.
- The cron endpoint returns success when called with
  `Authorization: Bearer <CRON_SECRET>`.

## Operations Checklist

- Patch the VPS monthly: `sudo apt update && sudo apt upgrade`.
- Enable provider snapshots or backups before major changes.
- Keep `.env.production` off git and out of Docker images.
- Rotate `CRON_SECRET`, Clerk, Apify, and OpenAI keys if the server is rebuilt
  from an untrusted state.
- Add a basic uptime check for `https://events.example.com/events`.
- Keep one rollback path: previous git commit plus
  `docker compose --env-file /opt/ig_event/.env.production up -d --build`.

## Future Complexity to Defer

Avoid these until the single-container VPS path is stable:

- Self-hosting Convex or replacing it with another database.
- Moving Clerk auth into the app.
- Running Apify alternatives on the VPS.
- Running local LLM or vision inference.
- Adding Kubernetes, load balancers, or multi-node deployment.

The first worthwhile optimization after this guide is reviewing
`output: "standalone"` in `next.config.mjs`. That can reduce image size and
runtime dependencies, but it is a code/config change that needs a clean
production build verification first.
