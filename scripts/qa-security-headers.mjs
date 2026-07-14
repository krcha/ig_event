import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildApplicationSecurityHeaders,
  buildContentSecurityPolicy,
  SECURITY_HEADER_OWNERSHIP,
} from "../lib/security/headers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextConfigSource = fs.readFileSync(path.join(root, "next.config.mjs"), "utf8");
const runtimeComposeSource = fs.readFileSync(
  path.join(root, "docker-compose.runtime.yml"),
  "utf8",
);
const imageComposeSource = fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8");
const dockerfileSource = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const healthRouteSource = fs.readFileSync(path.join(root, "app/api/health/route.ts"), "utf8");
const readyRouteSource = fs.readFileSync(path.join(root, "app/api/ready/route.ts"), "utf8");
const httpQaSource = fs.readFileSync(
  path.join(root, "scripts/qa-security-headers-http.mjs"),
  "utf8",
);

const productionCsp = buildContentSecurityPolicy({
  clerkOrigin: "https://clerk.events.ineedtofeedmyrabbit.com",
  convexOrigin: "https://convex-events.ineedtofeedmyrabbit.com",
  production: true,
});
const developmentCsp = buildContentSecurityPolicy({
  clerkOrigin: "http://localhost:3001",
  convexOrigin: "http://localhost:3210",
  production: false,
});

for (const directive of [
  "default-src 'self';",
  "base-uri 'self';",
  "object-src 'none';",
  "frame-ancestors 'none';",
  "form-action 'self';",
  "script-src",
  "connect-src",
  "img-src",
  "worker-src 'self' blob:;",
  "style-src 'self' 'unsafe-inline';",
  "frame-src 'self' https://challenges.cloudflare.com;",
  "upgrade-insecure-requests;",
]) {
  assert.ok(productionCsp.includes(directive), `Production CSP must include ${directive}`);
}
assert.ok(!productionCsp.includes("'unsafe-eval'"), "Production CSP must not allow unsafe-eval.");
assert.ok(
  !productionCsp.includes("media-src 'self' blob: https:"),
  "Production media-src must not allow every HTTPS origin.",
);
for (const source of [
  "https://clerk.events.ineedtofeedmyrabbit.com",
  "https://convex-events.ineedtofeedmyrabbit.com",
  "wss://convex-events.ineedtofeedmyrabbit.com",
  "https://challenges.cloudflare.com",
  "https://img.clerk.com",
  "https://images.apifyusercontent.com",
  "https://cdninstagram.com",
  "https://*.cdninstagram.com",
  "https://fbcdn.net",
  "https://*.fbcdn.net",
]) {
  assert.ok(productionCsp.includes(source), `Production CSP must allow ${source}`);
}
assert.ok(developmentCsp.includes("'unsafe-eval'"), "Local Next development requires unsafe-eval.");
assert.ok(
  !developmentCsp.includes("upgrade-insecure-requests"),
  "Local HTTP development must not be upgraded to HTTPS.",
);
assert.ok(developmentCsp.includes("http://localhost:3210"));
assert.ok(developmentCsp.includes("ws://localhost:3210"));

const headers = buildApplicationSecurityHeaders({ production: true });
const headerMap = new Map(headers.map(({ key, value }) => [key.toLowerCase(), value]));
assert.equal(headerMap.get("x-content-type-options"), "nosniff");
assert.equal(headerMap.get("x-frame-options"), "DENY");
assert.equal(headerMap.get("referrer-policy"), "strict-origin-when-cross-origin");
assert.equal(
  headerMap.get("permissions-policy"),
  "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
);
assert.ok(headerMap.has("content-security-policy"));
assert.ok(!headerMap.has("strict-transport-security"));

assert.deepEqual(SECURITY_HEADER_OWNERSHIP.canonicalHttpsProxy, ["Strict-Transport-Security"]);
assert.match(nextConfigSource, /source:\s*["']\/:path\*["']/);
for (const route of ["/", "/sign-in", "/api/health", "/does-not-exist"]) {
  assert.ok(httpQaSource.includes(`["${route}"`), `HTTP QA must request ${route}`);
}
assert.match(healthRouteSource, /Cache-Control["']:\s*["']no-store, max-age=0/);
assert.match(readyRouteSource, /Cache-Control["']:\s*["']no-store, max-age=0/);
assert.match(dockerfileSource, /\/app\/lib\/security \.\/lib\/security/);
assert.match(
  runtimeComposeSource,
  /traefik\.http\.routers\.ig-event\.rule=Host\(`events\.ineedtofeedmyrabbit\.com`\)/,
);
assert.match(runtimeComposeSource, /traefik\.http\.routers\.ig-event\.middlewares=ig-event-hsts@docker/);
assert.match(runtimeComposeSource, /ig-event-hsts\.headers\.stsSeconds=31536000/);
assert.match(runtimeComposeSource, /ig-event-hsts\.headers\.stsIncludeSubdomains=true/);
assert.match(runtimeComposeSource, /ig-event-hsts\.headers\.stsPreload=false/);
assert.match(imageComposeSource, /traefik\.http\.routers\.ig-event\.middlewares=ig-event-hsts@docker/);
assert.match(imageComposeSource, /ig-event-hsts\.headers\.stsSeconds=31536000/);
assert.match(imageComposeSource, /ig-event-hsts\.headers\.stsIncludeSubdomains=true/);
assert.match(imageComposeSource, /ig-event-hsts\.headers\.stsPreload=false/);

console.log(
  "Security-header QA passed for production CSP, local development, global routes, and canonical HTTPS HSTS ownership.",
);
