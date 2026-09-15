import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

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

console.log(
  `Admin auth QA passed for ${adminRouteFiles.length} admin API routes and the admin layout.`,
);
