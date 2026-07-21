import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import process from "node:process";

const port = 33_000 + (process.pid % 1_000);
const origin = `http://127.0.0.1:${port}`;
const output = [];
const child = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)],
  {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.on("data", (chunk) => output.push(chunk.toString()));
child.stderr.on("data", (chunk) => output.push(chunk.toString()));

async function fetchWithTimeout(path, options = {}) {
  return fetch(`${origin}${path}`, {
    ...options,
    signal: AbortSignal.timeout(30_000),
  });
}

function requestWithHost(path, host) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: { host },
        hostname: "127.0.0.1",
        path,
        port,
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response));
      },
    );
    request.setTimeout(30_000, () =>
      request.destroy(new Error("Host redirect request timed out.")),
    );
    request.once("error", reject);
    request.end();
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Next server exited before readiness:\n${output.join("")}`);
    }
    try {
      const response = await fetchWithTimeout("/api/health");
      if (response.ok) return;
    } catch {
      // Retry while Next starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for Next server:\n${output.join("")}`);
}

async function stopServer() {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

try {
  await waitForServer();

  for (const [route, expectedStatus] of [
    ["/", 200],
    ["/sign-in", 200],
    ["/api/ready", null],
    ["/does-not-exist", 404],
    ["/events/not-an-id", 404],
    ["/venues/not-an-id", 404],
  ]) {
    const response = await fetchWithTimeout(route, { redirect: "manual" });
    if (route === "/api/ready") {
      const readiness = await response.clone().json();
      assert.equal(typeof readiness.ok, "boolean", "/api/ready body must expose boolean ok");
      assert.equal(
        response.status,
        readiness.ok ? 200 : 503,
        "/api/ready status must reflect configured readiness",
      );
    } else {
      assert.equal(response.status, expectedStatus, `${route} status`);
    }
    for (const header of [
      "content-security-policy",
      "permissions-policy",
      "referrer-policy",
      "x-content-type-options",
      "x-frame-options",
    ]) {
      assert.ok(response.headers.get(header), `${route} must return ${header}`);
    }
    const csp = response.headers.get("content-security-policy");
    assert.ok(!csp.includes("'unsafe-eval'"), `${route} production CSP must exclude unsafe-eval`);
    assert.equal(
      response.headers.get("strict-transport-security"),
      null,
      `${route} local HTTP must not emit HSTS`,
    );
  }

  for (const route of ["/api/health", "/api/ready"]) {
    const response = await fetchWithTimeout(route);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }

  const redirect = await fetchWithTimeout("/map?source=security-qa", { redirect: "manual" });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "/venues?source=security-qa");

  const wwwRedirect = await requestWithHost(
    "/saved?source=security-qa",
    "www.eventzeka.com",
  );
  assert.equal(wwwRedirect.statusCode, 308);
  assert.equal(
    wwwRedirect.headers.location,
    "https://eventzeka.com/saved?source=security-qa",
  );

  console.log(
    "Security-header HTTP QA passed for home, sign-in, health, readiness, 404, local HSTS ownership, and canonical redirects.",
  );
} catch (error) {
  console.error(output.join(""));
  throw error;
} finally {
  await stopServer();
}
