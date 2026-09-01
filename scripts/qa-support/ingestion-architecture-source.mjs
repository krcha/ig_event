import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Read the facade and its authoritative responsibility modules for source-level QA. */
export function readIngestionArchitectureSource() {
  const moduleDirectory = "lib/pipeline/ingestion";
  const modules = readdirSync(moduleDirectory)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => readFileSync(join(moduleDirectory, name), "utf8"));
  return [
    readFileSync("lib/pipeline/run-instagram-ingestion.ts", "utf8"),
    ...modules,
  ].join("\n");
}
