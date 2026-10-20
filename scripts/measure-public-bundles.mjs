// Measure the union of initial route/layout JS from a production Next build.
// Gzip sizes are reproducible estimates, not browser wire or parse timings.
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const manifest = JSON.parse(readFileSync(".next/app-build-manifest.json", "utf8"));
const layout = manifest.pages["/layout"];
function measure(paths) {
  const files = [...new Set(paths)].filter((path) => path.endsWith(".js")).map((path) => {
    const bytes = readFileSync(`.next/${path}`);
    return { path, bytes: bytes.length, gzipBytes: gzipSync(bytes).length };
  });
  return {
    files,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    gzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0),
    jsRequests: files.length,
  };
}
const result = {
  timestamp: new Date().toISOString(),
  layout: measure(layout),
  home: measure([...manifest.pages["/page"], ...layout]),
  map: measure([...manifest.pages["/(main)/map/page"], ...layout]),
};
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
