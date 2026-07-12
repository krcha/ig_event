import { spawnSync } from "node:child_process";

const forbiddenRules = [
  {
    description: "generated build output",
    pattern: /^(?:\.next|out|build)(?: [0-9]{1,3})?\//u,
  },
  {
    description: "generated test output",
    pattern:
      /^(?:test-results|playwright-report|blob-report|coverage)(?: [0-9]{1,3})?\//u,
  },
  {
    description: "generated trace or screenshot directory",
    pattern: /^(?:traces?|screenshots?)(?: [0-9]{1,3})?\//u,
  },
  {
    description: "generated trace or screenshot file",
    pattern:
      /^(?:[^/]+\.trace|trace(?: [0-9]{1,3})?\.(?:json|zip)|screenshot(?:[-_ ][^/]*)?\.(?:jpe?g|png|webp))$/u,
  },
  {
    description: "temporary script",
    pattern: /^scripts\/tmp-/u,
  },
  {
    description: "copy-style numeric source filename suffix",
    pattern:
      /^(?:app|components|convex|lib|scripts)\/(?:[^/]+\/)*[^/]+ [0-9]{1,3}\.(?:[jt]sx?|[cm][jt]s)$/u,
  },
];

function findViolations(files) {
  return files.flatMap((file) =>
    forbiddenRules
      .filter((rule) => rule.pattern.test(file))
      .map((rule) => ({ description: rule.description, file })),
  );
}

const matcherFixtures = {
  accepted: [
    "docs/Chapter 2.md",
    "docs/reference/screenshot-admin.png",
    "docs/screenshots/calendar-reference.webp",
    "packages/calendar/build/index.ts",
    "lib/build/manifest.ts",
    "scripts/Chapter 2.md",
    "components/season 2/card.tsx",
    "build notes/readme.md",
    "lib/parser 2 draft.ts",
    "build 1234/server.js",
    "coverage 1234/lcov.info",
    "screenshots 1234/failing-test.png",
    "trace 1234.zip",
    "lib/parser 1234.mts",
  ],
  rejected: [
    { file: ".next/cache/index.pack", description: "generated build output" },
    { file: ".next 2/server/app/page.js", description: "generated build output" },
    { file: "out/index.html", description: "generated build output" },
    { file: "build 3/server.js", description: "generated build output" },
    { file: "build 123/server.js", description: "generated build output" },
    { file: "test-results/results.json", description: "generated test output" },
    {
      file: "playwright-report 2/index.html",
      description: "generated test output",
    },
    { file: "blob-report/report.zip", description: "generated test output" },
    { file: "coverage/lcov.info", description: "generated test output" },
    { file: "coverage 2/lcov.info", description: "generated test output" },
    {
      file: "screenshots/failing-test.png",
      description: "generated trace or screenshot directory",
    },
    {
      file: "screenshots 2/failing-test.png",
      description: "generated trace or screenshot directory",
    },
    {
      file: "screenshot-failing-test.png",
      description: "generated trace or screenshot file",
    },
    { file: "trace.json", description: "generated trace or screenshot file" },
    { file: "trace.zip", description: "generated trace or screenshot file" },
    { file: "trace 2.zip", description: "generated trace or screenshot file" },
    { file: "scripts/tmp-debug.ts", description: "temporary script" },
    {
      file: "lib/venues/venue-hours-cache 2.ts",
      description: "copy-style numeric source filename suffix",
    },
    {
      file: "app/parser 1.js",
      description: "copy-style numeric source filename suffix",
    },
    {
      file: "components/parser 2.jsx",
      description: "copy-style numeric source filename suffix",
    },
    {
      file: "convex/parser 3.ts",
      description: "copy-style numeric source filename suffix",
    },
    {
      file: "lib/parser 4.tsx",
      description: "copy-style numeric source filename suffix",
    },
    {
      file: "scripts/parser 5.mjs",
      description: "copy-style numeric source filename suffix",
    },
    {
      file: "lib/parser 2.mts",
      description: "copy-style numeric source filename suffix",
    },
    {
      file: "app/parser 7.cjs",
      description: "copy-style numeric source filename suffix",
    },
    {
      file: "scripts/parser 8.cts",
      description: "copy-style numeric source filename suffix",
    },
  ],
};

function runMatcherFixtureTests() {
  const failures = [];

  for (const file of matcherFixtures.accepted) {
    const matches = findViolations([file]);
    if (matches.length > 0) {
      failures.push(
        `${file} should be accepted but matched ${matches
          .map((match) => match.description)
          .join(", ")}`,
      );
    }
  }

  for (const fixture of matcherFixtures.rejected) {
    const descriptions = findViolations([fixture.file]).map(
      (match) => match.description,
    );
    if (
      descriptions.length !== 1 ||
      descriptions[0] !== fixture.description
    ) {
      failures.push(
        `${fixture.file} should match ${fixture.description} exactly, got ${
          descriptions.join(", ") || "no matches"
        }`,
      );
    }
  }

  if (failures.length > 0) {
    console.error("Repository hygiene matcher fixtures failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  const fixtureCount =
    matcherFixtures.accepted.length + matcherFixtures.rejected.length;
  console.log(
    `Repository hygiene matcher fixtures passed (${fixtureCount} accepted/rejected paths).`,
  );
}

function runGitIgnoreFixtureTests() {
  const fixtures = [
    ...matcherFixtures.accepted.map((file) => ({ file, ignored: false })),
    ...matcherFixtures.rejected.map(({ file }) => ({ file, ignored: true })),
  ];
  const result = spawnSync(
    "git",
    ["check-ignore", "--no-index", "-z", "--stdin"],
    {
      encoding: "utf8",
      input: `${fixtures.map(({ file }) => file).join("\0")}\0`,
    },
  );

  if (result.error) {
    console.error(
      `Repository .gitignore fixtures could not run git: ${result.error.message}`,
    );
    process.exit(1);
  }

  if (result.status !== 0 && result.status !== 1) {
    console.error("Repository .gitignore fixtures could not check paths.");
    if (result.stderr) {
      console.error(result.stderr.trim());
    }
    process.exit(result.status ?? 1);
  }

  const ignoredFiles = new Set(result.stdout.split("\0").filter(Boolean));
  const failures = fixtures.flatMap(({ file, ignored }) => {
    const actual = ignoredFiles.has(file);
    if (actual === ignored) {
      return [];
    }
    return [
      `${file} should be ${ignored ? "ignored" : "accepted"} but was ${
        actual ? "ignored" : "accepted"
      }`,
    ];
  });

  if (failures.length > 0) {
    console.error("Repository .gitignore fixtures failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log(
    `Repository .gitignore fixtures passed (${fixtures.length} accepted/rejected paths).`,
  );
}

runMatcherFixtureTests();
runGitIgnoreFixtureTests();

const result = spawnSync("git", ["ls-files", "--cached", "-z"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});

if (result.error) {
  console.error(`Repository hygiene check could not run git: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error("Repository hygiene check could not list tracked files.");
  if (result.stderr) {
    console.error(result.stderr.trim());
  }
  process.exit(result.status ?? 1);
}

const trackedFiles = result.stdout.split("\0").filter(Boolean);
const violations = findViolations(trackedFiles);

if (violations.length > 0) {
  console.error("Repository hygiene check failed. Forbidden artifacts are tracked:");
  for (const violation of violations) {
    console.error(`- ${violation.file} (${violation.description})`);
  }
  process.exit(1);
}

console.log(`Repository hygiene check passed (${trackedFiles.length} tracked files inspected).`);
