import { spawnSync } from "node:child_process";

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
const forbiddenRules = [
  {
    description: "generated build output",
    pattern: /(?:^|\/)(?:\.next|out|build)(?: \d+)?(?:\/|$)/u,
  },
  {
    description: "generated test output",
    pattern:
      /(?:^|\/)(?:test-results|playwright-report|blob-report|coverage)(?: \d+)?(?:\/|$)/u,
  },
  {
    description: "generated trace or screenshot directory",
    pattern: /(?:^|\/)(?:traces?|screenshots?)(?: \d+)?(?:\/|$)/iu,
  },
  {
    description: "generated trace or screenshot file",
    pattern:
      /(?:^|\/)(?:trace(?: \d+)?\.(?:json|trace|zip)|screenshot(?:[-_ ][^/]*)?\.(?:jpe?g|png|webp))$/iu,
  },
  {
    description: "temporary script",
    pattern: /^scripts\/tmp-/u,
  },
  {
    description: "copy-style numeric filename suffix",
    pattern: /(?:^|\/)[^/]+ \d+\.[^/]+$/u,
  },
];

const violations = trackedFiles.flatMap((file) =>
  forbiddenRules
    .filter((rule) => rule.pattern.test(file))
    .map((rule) => ({ description: rule.description, file })),
);

if (violations.length > 0) {
  console.error("Repository hygiene check failed. Forbidden artifacts are tracked:");
  for (const violation of violations) {
    console.error(`- ${violation.file} (${violation.description})`);
  }
  process.exit(1);
}

console.log(`Repository hygiene check passed (${trackedFiles.length} tracked files inspected).`);
