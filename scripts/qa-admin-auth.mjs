import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import strictAssert from "node:assert/strict";
import { ConvexHttpClient } from "convex/browser";
import ts from "typescript";

const rootDir = process.cwd();
const adminApiDir = path.join(rootDir, "app/api/admin");
const adminLayoutPath = path.join(rootDir, "app/(dashboard)/admin/layout.tsx");
const adminApiHelperPath = path.join(rootDir, "lib/auth/admin-api.ts");

function walkFiles(dir) {
  const entries = readdirSync(dir);
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      return walkFiles(fullPath);
    }
    return [fullPath];
  });
}

function readSource(filePath) {
  return readFileSync(filePath, "utf8");
}

function relative(filePath) {
  return path.relative(rootDir, filePath);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const adminApiHelperSource = readSource(adminApiHelperPath);
assert(
  adminApiHelperSource.includes("isAdminClerkUserId"),
  "lib/auth/admin-api.ts must enforce ADMIN_CLERK_USER_IDS.",
);
assert(
  adminApiHelperSource.includes("hasConfiguredAdminClerkUserIds"),
  "lib/auth/admin-api.ts must fail closed when the admin allowlist is missing.",
);

const adminRouteFiles = walkFiles(adminApiDir).filter((filePath) =>
  filePath.endsWith("/route.ts"),
);

for (const routeFile of adminRouteFiles) {
  const source = readSource(routeFile);
  const routeName = relative(routeFile);

  assert(
    source.includes("@/lib/auth/admin-api"),
    `${routeName} must import the shared admin API guard.`,
  );
  assert(
    source.includes("await requireAdminApiAccess("),
    `${routeName} must call requireAdminApiAccess before admin work.`,
  );
  assert(
    !source.includes("@clerk/nextjs/server"),
    `${routeName} must not implement route-local Clerk-only admin auth.`,
  );
  assert(
    !source.includes("hasClerkEnv("),
    `${routeName} must not bypass the shared admin allowlist guard.`,
  );
}

const adminLayoutSource = readSource(adminLayoutPath);
assert(
  adminLayoutSource.includes("canAccessAdminSurface"),
  "app/(dashboard)/admin/layout.tsx must enforce the admin page allowlist.",
);
assert(
  /export const dynamic = ["']force-dynamic["'];/.test(adminLayoutSource),
  "Admin pages must evaluate authentication per request, even when build-time auth configuration is absent.",
);

const prerenderManifestPath = path.join(rootDir, ".next/prerender-manifest.json");
if (existsSync(prerenderManifestPath)) {
  const manifest = JSON.parse(readSource(prerenderManifestPath));
  const appPaths = JSON.parse(
    readSource(path.join(rootDir, ".next/server/app-paths-manifest.json")),
  );
  for (const route of ["/admin", "/admin/scraper", "/admin/venues"]) {
    assert(
      `/(dashboard)${route}/page` in appPaths,
      `The build must contain the ${route} page.`,
    );
    assert(
      !(route in manifest.routes) && !manifest.notFoundRoutes.includes(route),
      `${route} must not ship a prerendered page or cached build-time 404.`,
    );
    assert(
      !existsSync(path.join(rootDir, `.next/server/app${route}.html`)),
      `${route} must render its auth guard at request time.`,
    );
  }
}

// Exercise the actual helper and SDK transport; only Clerk, time and HTTP are mocked.
const serverModule = { exports: {} };
const serverSource = ts.transpileModule(readSource(path.join(rootDir, "lib/convex/server.ts")), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let now = Date.parse("2035-01-01T12:00:00Z");
let signedIn = true;
let tokenMode = "fresh";
let renewalGate;
let transportGate;
let transportMode = "success";
const tokenRequests = [];
const transports = [];
const issueToken = (exp) => `qa.${Buffer.from(JSON.stringify({ sub: "qa-admin", exp })).toString("base64url")}.signature`;
const getToken = async (options) => {
  strictAssert.deepEqual(options, { template: "convex" });
  tokenRequests.push(options);
  if (renewalGate) await renewalGate;
  if (tokenMode === "null") return null;
  if (tokenMode === "throws") throw new Error("Clerk unavailable");
  if (tokenMode === "invalid") return "invalid-qa-token";
  return issueToken(Math.floor(now / 1_000) + (tokenMode === "expired" ? -1 : 60));
};
const imports = {
  "server-only": {},
  "@clerk/nextjs/server": { auth: async () => ({ userId: signedIn ? "qa-admin" : null, getToken }) },
  "convex/browser": { ConvexHttpClient },
  "@/lib/utils/env": { getRequiredEnv: () => "https://qa-admin.convex.cloud" },
};
new Function("require", "module", "exports", serverSource)(
  (name) => {
    strictAssert.ok(Object.hasOwn(imports, name), `Unexpected helper import: ${name}`);
    return imports[name];
  },
  serverModule,
  serverModule.exports,
);
try {
  Date.now = () => now;
  globalThis.fetch = async (input, init) => {
    const authorization = new Headers(init.headers).get("Authorization");
    strictAssert.ok(authorization?.startsWith("Bearer "), "Use the current user's JWT, never service/admin credentials.");
    const claims = JSON.parse(Buffer.from(authorization.split(".")[1], "base64url").toString());
    strictAssert.equal(claims.sub, "qa-admin");
    strictAssert.ok(claims.exp * 1_000 > now, "Every RPC must reach transport before its token expires.");
    const body = JSON.parse(init.body);
    transports.push({ path: body.path, authorization, args: body.args, url: String(input) });
    strictAssert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
    if (transportGate) await transportGate;
    if (transportMode === "lost_ack") throw new Error("Connection closed after send");
    if (transportMode === "unauthenticated") return new Response("Unauthenticated", { status: 401 });
    return new Response(JSON.stringify({ status: "success", value: null }), { status: 200 });
  };
  const createClient = serverModule.exports.createAuthenticatedConvexHttpClient;
  const client = await createClient();
  // The moderation queue performs 49 sequential reads and can outlive several JWTs.
  for (let index = 0; index < 49; index += 1) {
    now += 3_000;
    await client.query("events:classifyPendingModerationUniqueness", { index });
  }
  strictAssert.equal(transports.length, 49);
  strictAssert.equal(tokenRequests.length, 3, "Reuse a live token and renew before the 60-second expiry.");
  strictAssert.notEqual(transports[0].authorization, transports.at(-1).authorization);

  now += 51_000;
  let releaseRenewal;
  renewalGate = new Promise((resolve) => { releaseRenewal = resolve; });
  const renewalCount = tokenRequests.length;
  const concurrent = Promise.all(Array.from({ length: 4 }, () => client.query("events:get", {})));
  await Promise.resolve();
  strictAssert.equal(tokenRequests.length, renewalCount + 1, "Concurrent RPCs share one renewal.");
  releaseRenewal();
  await concurrent;
  renewalGate = undefined;

  // The second mutation must renew at actual dequeue time, not when it was enqueued.
  let releaseTransport;
  transportGate = new Promise((resolve) => { releaseTransport = resolve; });
  const first = client.mutation("events:moderateEvent", { id: "qa-first", expectedUpdatedAt: 1 });
  await Promise.resolve();
  await Promise.resolve();
  const second = client.mutation("events:moderateEvent", { id: "qa-second", expectedUpdatedAt: 2 });
  const beforeQueuedRenewal = tokenRequests.length;
  now += 61_000;
  transportGate = undefined;
  releaseTransport();
  await Promise.all([first, second]);
  strictAssert.equal(tokenRequests.length, beforeQueuedRenewal + 1);
  strictAssert.deepEqual(transports.at(-1).args, [{ id: "qa-second", expectedUpdatedAt: 2 }]);

  for (const mode of ["null", "throws", "invalid", "expired"]) {
    now += 61_000;
    tokenMode = mode;
    const count = transports.length;
    await strictAssert.rejects(client.mutation("events:moderateEvent", { id: "qa-denied" }));
    strictAssert.equal(transports.length, count, "Failed renewal must stop before mutation transport.");
  }
  tokenMode = "fresh";
  await client.query("events:get", {});
  for (const mode of ["lost_ack", "unauthenticated"]) {
    transportMode = mode;
    const count = transports.length;
    await strictAssert.rejects(client.mutation("events:moderateEvent", { id: "qa-once" }));
    strictAssert.equal(transports.length, count + 1, "A failed mutation must never be replayed.");
  }
  transportMode = "success";
  signedIn = false;
  const beforeSignedOut = tokenRequests.length;
  await strictAssert.rejects(createClient(), /Authentication required/);
  strictAssert.equal(tokenRequests.length, beforeSignedOut);
} finally {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
}

console.log(`Admin auth QA passed for ${adminRouteFiles.length} routes, dynamic pages, long requests and mutation-safe JWT renewal.`);
