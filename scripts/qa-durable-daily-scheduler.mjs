import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { getBelgradeDayKey } from "../lib/pipeline/belgrade-day-key.ts";

process.env.CRON_SECRET = "qa-durable-daily-secret";

const { queueDailyRun, queueRun } = await import("../convex/durableIngestionRuns.ts");

class MemoryDb {
  #tables = new Map();
  #sequence = 0;

  table(name) {
    if (!this.#tables.has(name)) this.#tables.set(name, new Map());
    return this.#tables.get(name);
  }

  async insert(table, value) {
    const id = `${table}:${++this.#sequence}`;
    this.table(table).set(id, { _id: id, ...structuredClone(value) });
    return id;
  }

  async get(id) {
    for (const table of this.#tables.values()) {
      const row = table.get(id);
      if (row) return structuredClone(row);
    }
    return null;
  }

  async patch(id, value) {
    for (const table of this.#tables.values()) {
      const row = table.get(id);
      if (row) {
        table.set(id, { ...row, ...structuredClone(value) });
        return;
      }
    }
    throw new Error(`Unknown row ${id}`);
  }

  query(tableName) {
    const tables = this.#tables;
    const conditions = [];
    const query = {
      withIndex(_name, callback) {
        const builder = {
          eq(field, value) {
            conditions.push((row) => row[field] === value);
            return builder;
          },
        };
        callback(builder);
        return query;
      },
      order(direction) {
        query.direction = direction;
        return query;
      },
      rows() {
        const rows = [...(tables.get(tableName) ?? new Map()).values()].filter((row) =>
          conditions.every((test) => test(row)),
        );
        const sortField = tableName === "ingestionDailySnapshots" ? "dayKey" : "createdAt";
        rows.sort((left, right) => {
          const comparison = String(left[sortField] ?? left._id).localeCompare(
            String(right[sortField] ?? right._id),
          );
          return comparison * (query.direction === "desc" ? -1 : 1);
        });
        return rows.map((row) => structuredClone(row));
      },
      async take(limit) {
        return query.rows().slice(0, limit);
      },
      async first() {
        return query.rows()[0] ?? null;
      },
      async unique() {
        const rows = query.rows();
        if (rows.length > 1) {
          throw new Error(`Expected one ${tableName} row, received ${rows.length}.`);
        }
        return rows[0] ?? null;
      },
    };
    return query;
  }

  rows(table) {
    return [...this.table(table).values()].map((row) => structuredClone(row));
  }
}

function ctx(db) {
  return { db, auth: { getUserIdentity: async () => null } };
}

async function queueGeneric(db, mode, handles, sourceSnapshotKey) {
  return queueRun._handler(ctx(db), {
    mode,
    sourceSnapshotKey,
    handles,
    serviceSecret: process.env.CRON_SECRET,
  });
}

async function queueDaily(db, handles, sourceSnapshotKey) {
  return queueDailyRun._handler(ctx(db), {
    sourceSnapshotKey,
    handles,
    serviceSecret: process.env.CRON_SECRET,
  });
}

assert.equal(getBelgradeDayKey(Date.parse("2026-08-11T21:59:59.999Z")), "2026-08-11");
assert.equal(getBelgradeDayKey(Date.parse("2026-08-11T22:00:00.000Z")), "2026-08-12");
assert.equal(getBelgradeDayKey(Date.parse("2026-01-11T22:59:59.999Z")), "2026-01-11");
assert.equal(getBelgradeDayKey(Date.parse("2026-01-11T23:00:00.000Z")), "2026-01-12");

const originalDateNow = Date.now;
let currentNowMs = Date.parse("2026-08-11T07:00:00.000Z");
Date.now = () => currentNowMs;
try {
  // The generic/admin admission path shares the same day fence. Even after a
  // run is terminal, a changed snapshot cannot create a second daily run.
  {
    const db = new MemoryDb();
    const firstRunId = await queueGeneric(db, "daily", ["venue_a"], "snapshot:first");
    await db.patch(firstRunId, { status: "completed", finishedAt: Date.now() });
    const retriedRunId = await queueGeneric(db, "daily", ["venue_b"], "snapshot:changed");
    assert.equal(retriedRunId, firstRunId);
    assert.equal(db.rows("ingestionRuns").length, 1, "one Belgrade day may own only one daily run");
    assert.equal((await db.get(firstRunId)).dailyDayKey, "2026-08-11");

    const schedulerAdmission = await queueDaily(db, ["venue_c"], "snapshot:scheduler");
    assert.equal(schedulerAdmission.runId, firstRunId);
    assert.equal(schedulerAdmission.currentDayQueued, true);
    assert.equal(schedulerAdmission.executeRequired, false);
    assert.equal(db.rows("ingestionDailySnapshots").length, 1);
    assert.equal(db.rows("ingestionDailySnapshots")[0].runId, firstRunId);
  }

  // Today's source set is frozen before an older run is returned. Once that
  // run finishes, the next admission consumes the persisted snapshot rather
  // than the caller's newer/changing list.
  {
    const db = new MemoryDb();
    const priorRunId = await queueGeneric(db, "catch_up", ["old_work"], "snapshot:prior");
    const resume = await queueDaily(db, ["today_a", "today_b"], "snapshot:today-frozen");
    assert.equal(resume.runId, priorRunId);
    assert.equal(resume.runMode, "catch_up");
    assert.equal(resume.currentDayQueued, false);
    assert.equal(resume.followUpRequired, true);
    assert.equal(resume.executeRequired, true);
    assert.equal(db.rows("ingestionDailySnapshots")[0].status, "pending");

    await db.patch(priorRunId, { status: "completed", finishedAt: Date.now() });
    const today = await queueDaily(db, ["changed_after_resume"], "snapshot:must-not-replace");
    assert.notEqual(today.runId, priorRunId);
    assert.equal(today.runMode, "daily");
    assert.equal(today.runDayKey, "2026-08-11");
    assert.equal(today.currentDayQueued, true);
    assert.equal(today.followUpRequired, false);
    const todayRun = await db.get(today.runId);
    assert.equal(todayRun.sourceSnapshotKey, "snapshot:today-frozen");
    assert.deepEqual(todayRun.selectedHandles, ["today_a", "today_b"]);

    const duplicate = await queueDaily(db, ["third_snapshot"], "snapshot:third");
    assert.equal(duplicate.runId, today.runId);
    assert.equal(db.rows("ingestionRuns").length, 2);
    assert.equal(db.rows("ingestionDailySnapshots").length, 1);
  }

  // A daily run created immediately before rollout has no day key. Its
  // creation timestamp is adopted once, avoiding a second run on deploy day.
  {
    const db = new MemoryDb();
    const legacyRunId = await queueGeneric(db, "daily", ["legacy_today"], "snapshot:legacy");
    await db.patch(legacyRunId, { dailyDayKey: undefined });
    const admission = await queueDaily(db, ["must_not_duplicate"], "snapshot:new");
    assert.equal(admission.runId, legacyRunId);
    assert.equal(admission.currentDayQueued, true);
    assert.equal(admission.followUpRequired, false);
    assert.equal(db.rows("ingestionRuns").length, 1);
    assert.equal((await db.get(legacyRunId)).dailyDayKey, "2026-08-11");
  }

  // If an older run spans another timer occurrence, both daily snapshots stay
  // ordered and the launcher-facing follow-up bit drains them oldest first.
  {
    const db = new MemoryDb();
    const priorRunId = await queueGeneric(db, "catch_up", ["long_running"], "snapshot:long");
    const dayOne = await queueDaily(db, ["day_one"], "snapshot:day-one");
    assert.equal(dayOne.runId, priorRunId);
    currentNowMs = Date.parse("2026-08-12T07:00:00.000Z");
    const dayTwoWaiting = await queueDaily(db, ["day_two"], "snapshot:day-two");
    assert.equal(dayTwoWaiting.runId, priorRunId);
    assert.equal(db.rows("ingestionDailySnapshots").length, 2);

    await db.patch(priorRunId, { status: "completed", finishedAt: Date.now() });
    const admittedDayOne = await queueDaily(db, ["ignored"], "snapshot:ignored");
    assert.equal(admittedDayOne.runDayKey, "2026-08-11");
    assert.equal(admittedDayOne.followUpRequired, true);
    await db.patch(admittedDayOne.runId, { status: "completed", finishedAt: Date.now() });
    const admittedDayTwo = await queueDaily(db, ["ignored_again"], "snapshot:ignored-again");
    assert.equal(admittedDayTwo.runDayKey, "2026-08-12");
    assert.equal(admittedDayTwo.followUpRequired, false);
    assert.equal(db.rows("ingestionRuns").length, 3);
  }
} finally {
  Date.now = originalDateNow;
}

function runLauncherFixture(mode) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "ig-event-daily-scheduler-"));
  const fakeBin = join(fixtureRoot, "bin");
  const runtimeDir = join(fixtureRoot, "runtime");
  const envFile = join(fixtureRoot, "cron.env");
  const lockFile = join(fixtureRoot, "daily.lock");
  const requestCountFile = join(fixtureRoot, "request-count");
  const runnerLog = join(fixtureRoot, "runner.log");
  const secretLeakLog = join(fixtureRoot, "secret-leak.log");
  mkdirSync(fakeBin);
  mkdirSync(runtimeDir);
  writeFileSync(
    envFile,
    ["APP_ORIGIN=https://scheduler.invalid", "CRON_SECRET=fixture-secret", ""].join("\n"),
    { mode: 0o600 },
  );
  writeFileSync(requestCountFile, "0", { mode: 0o600 });
  writeFileSync(runnerLog, "", { mode: 0o600 });
  writeFileSync(secretLeakLog, "", { mode: 0o600 });

  const fakeFlock = join(fakeBin, "flock");
  writeFileSync(fakeFlock, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  chmodSync(fakeFlock, 0o755);

  const fakeCurl = join(fakeBin, "curl");
  writeFileSync(
    fakeCurl,
    [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      'config_file=""',
      'while [[ "$#" -gt 0 ]]; do',
      '  if [[ "$1" == "--config" ]]; then config_file="$2"; shift 2; else shift; fi',
      "done",
      '[[ -n "$config_file" && -r "$config_file" ]]',
      '[[ -z "${CRON_SECRET:-}" ]] || printf "leaked\\n" >> "$FAKE_SECRET_LEAK_LOG"',
      'grep -Fq "Authorization: Bearer fixture-secret" "$config_file"',
      'grep -Fq "url = \\"https://scheduler.invalid/api/cron/durable-ingestion/daily\\"" "$config_file"',
      'body_file="$(sed -nE \'s/^output = "(.*)"$/\\1/p\' "$config_file")"',
      'count="$(<"$FAKE_REQUEST_COUNT_FILE")"',
      'count=$((count + 1))',
      'printf "%s" "$count" > "$FAKE_REQUEST_COUNT_FILE"',
      'if [[ "$FAKE_DAILY_MODE" == "drain" && "$count" == "1" ]]; then',
      '  printf \'{"runId":"prior_run","executeRequired":true,"followUpRequired":true}\' > "$body_file"',
      "else",
      '  if [[ "$FAKE_DAILY_MODE" == "satisfied" ]]; then execute=false; else execute=true; fi',
      '  printf \'{"runId":"today_run","executeRequired":%s,"followUpRequired":false}\' "$execute" > "$body_file"',
      "fi",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(fakeCurl, 0o755);

  const fakeRunner = join(fakeBin, "durable-runner");
  writeFileSync(
    fakeRunner,
    "#!/usr/bin/env bash\nset -Eeuo pipefail\nprintf '%s\\n' \"$1\" >> \"$FAKE_RUNNER_LOG\"\n",
    { mode: 0o755 },
  );
  chmodSync(fakeRunner, 0o755);

  try {
    const result = spawnSync("bash", ["scripts/ig-event-durable-daily-runner"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CRON_SECRET: "must-be-replaced",
        FAKE_DAILY_MODE: mode,
        FAKE_REQUEST_COUNT_FILE: requestCountFile,
        FAKE_RUNNER_LOG: runnerLog,
        FAKE_SECRET_LEAK_LOG: secretLeakLog,
        IG_EVENT_CRON_ENV: envFile,
        IG_EVENT_DURABLE_DAILY_LOCK_FILE: lockFile,
        IG_EVENT_DURABLE_RUNNER: fakeRunner,
        IG_EVENT_DURABLE_RUNTIME_DIR: runtimeDir,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
      timeout: 10_000,
    });
    assert.equal(result.status, 0, `${mode}: stdout=${result.stdout}; stderr=${result.stderr}`);
    assert.equal(readFileSync(secretLeakLog, "utf8"), "", "curl must not inherit the secret");
    assert.deepEqual(readdirSync(runtimeDir), [], "sensitive curl files must be cleaned");
    return {
      requests: Number(readFileSync(requestCountFile, "utf8")),
      runs: readFileSync(runnerLog, "utf8").trim().split("\n").filter(Boolean),
    };
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

assert.deepEqual(runLauncherFixture("drain"), {
  requests: 2,
  runs: ["prior_run", "today_run"],
});
assert.deepEqual(runLauncherFixture("satisfied"), {
  requests: 1,
  runs: [],
});

console.log("Durable daily scheduler QA passed.");
