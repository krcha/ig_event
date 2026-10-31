import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// PID 1's start time changes on container restart even though /tmp survives.
// Warm only the public calendar once per boot; other routes remain lazy.
try {
  const stat = await readFile("/proc/1/stat", "utf8");
  const boot = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
  if (!boot) throw new Error("Missing container boot identity.");
  const state = join(tmpdir(), "eventzeka-web-ready");
  const previous = await readFile(state, "utf8").catch(() => "");
  const options = { cache: "no-store", headers: { host: "eventzeka.com", "x-forwarded-proto": "https", "user-agent": "eventzeka-readiness" } };
  const warmedCalendar = previous !== boot;
  if (warmedCalendar) {
    const page = await fetch("http://127.0.0.1:3000/", { ...options, signal: AbortSignal.timeout(15_000) });
    if (!page.ok) throw new Error("Calendar not ready.");
    await page.arrayBuffer(); // Do not mark a streamed skeleton as ready.
    await writeFile(state, boot, { mode: 0o600 });
  }
  const health = await fetch("http://127.0.0.1:3000/api/health", { ...options, signal: AbortSignal.timeout(3_000) });
  if (!health.ok) throw new Error("Web health check failed.");
  console.log(JSON.stringify({ ready: true, warmedCalendar }));
} catch {
  console.error("Web readiness failed.");
  process.exitCode = 1;
}
