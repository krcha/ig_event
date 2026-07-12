import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nextConfig from "../next.config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");
const packageJson = JSON.parse(read("package.json"));
const packageLock = JSON.parse(read("package-lock.json"));

const expectedDependencies = {
  next: "15.5.20",
  react: "19.2.7",
  "react-dom": "19.2.7",
};
const expectedDevDependencies = {
  "@types/react": "19.2.17",
  "@types/react-dom": "19.2.3",
  "eslint-config-next": "15.5.20",
};

for (const [name, expected] of Object.entries(expectedDependencies)) {
  assert.equal(packageJson.dependencies[name], expected, `${name} must stay pinned to ${expected}.`);
  assert.equal(
    packageLock.packages[""].dependencies[name],
    expected,
    `package-lock root must pin ${name} to ${expected}.`,
  );
  assert.equal(
    packageLock.packages[`node_modules/${name}`].version,
    expected,
    `package-lock must resolve ${name} to ${expected}.`,
  );
}

for (const [name, expected] of Object.entries(expectedDevDependencies)) {
  assert.equal(packageJson.devDependencies[name], expected, `${name} must stay pinned to ${expected}.`);
  assert.equal(
    packageLock.packages[""].devDependencies[name],
    expected,
    `package-lock root must pin ${name} to ${expected}.`,
  );
  assert.equal(
    packageLock.packages[`node_modules/${name}`].version,
    expected,
    `package-lock must resolve ${name} to ${expected}.`,
  );
}

assert.match(
  packageJson.devDependencies.eslint,
  /^\^8\./,
  "The Next 15 migration should keep ESLint on the existing 8.x line.",
);
assert.equal(
  packageJson.dependencies["@clerk/nextjs"],
  "6.39.5",
  "The tested Clerk compatibility pin must not drift during the framework migration.",
);
assert.equal(
  packageLock.packages[""].dependencies["@clerk/nextjs"],
  "6.39.5",
  "The package-lock root must keep the tested Clerk compatibility pin.",
);
assert.equal(
  packageLock.packages["node_modules/@clerk/nextjs"].version,
  "6.39.5",
  "The package-lock must resolve the tested Clerk compatibility pin.",
);
assert.equal(packageLock.lockfileVersion, 3, "The npm lockfile must stay on lockfileVersion 3.");

const asyncSearchParamFiles = [
  "app/(main)/events-browse-page.tsx",
  "app/(main)/venues/page.tsx",
  "app/(main)/discover/page.tsx",
  "app/(main)/events/page.tsx",
  "app/(main)/calendar/page.tsx",
];
for (const relativePath of asyncSearchParamFiles) {
  const source = read(relativePath);
  assert.match(source, /searchParams\?: Promise</, `${relativePath} must use Next 15 async searchParams.`);
  assert.match(source, /await searchParams/, `${relativePath} must await Next 15 searchParams.`);
}

const asyncParamFiles = [
  "app/(main)/events/[eventId]/page.tsx",
  "app/(main)/venues/[venueId]/page.tsx",
  "app/api/admin/scrape/jobs/[jobId]/route.ts",
  "app/api/discover/images/[eventId]/route.ts",
];
for (const relativePath of asyncParamFiles) {
  const source = read(relativePath);
  assert.match(source, /params: Promise</, `${relativePath} must use Next 15 async params.`);
  assert.match(source, /await (?:context\.)?params/, `${relativePath} must await Next 15 params.`);
}

function collectAppEntryFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectAppEntryFiles(absolutePath);
    }
    return /(?:page|route)\.tsx?$/.test(entry.name) ? [absolutePath] : [];
  });
}

for (const absolutePath of collectAppEntryFiles(path.join(root, "app"))) {
  const relativePath = path.relative(root, absolutePath);
  const source = readFileSync(absolutePath, "utf8");
  assert.doesNotMatch(
    source,
    /\bparams\s*:\s*\{/,
    `${relativePath} must not declare synchronous Next 15 params.`,
  );
  assert.doesNotMatch(
    source,
    /\bsearchParams\??\s*:\s*\{/,
    `${relativePath} must not declare synchronous Next 15 searchParams.`,
  );
}

assert.equal(nextConfig.images?.domains, undefined, "Next image hosts must use remotePatterns, not domains.");
assert.deepEqual(
  nextConfig.images?.remotePatterns,
  [{ protocol: "https", hostname: "images.apifyusercontent.com" }],
  "Next image configuration must retain the approved HTTPS Apify image host.",
);

const redirects = await nextConfig.redirects();
for (const source of ["/map", "/calendar", "/events"]) {
  assert.ok(redirects.some((redirect) => redirect.source === source), `${source} redirect must remain configured.`);
}

const middlewareSource = read("middleware.ts");
assert.match(
  middlewareSource,
  /clerkMiddleware\([\s\S]*authorizedParties/,
  "Clerk middleware must retain authorized-party verification on the tested SDK line.",
);
assert.match(
  middlewareSource,
  /return await clerkAdminMiddleware\(req, event\)/,
  "The middleware wrapper must forward the Next request and fetch event to Clerk.",
);

console.log("Next 15 / React 19 compatibility QA passed.");
