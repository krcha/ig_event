import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  listByHandle,
  listByHandlePaginated,
  listAllHandlesPaginated,
  listPublicRecentPostsByHandle,
  getBacklogStateByHandle,
  getManyByIds as getManyScrapedPostsByIds,
  backfillPaidFetchFlags,
  deleteOlderThan as deleteOldScrapedPosts,
  listPaidFetchMigrationPage,
  reconcilePaidFetchFlags,
} from "../convex/scrapedPosts.ts";
import {
  getByInstagramPostId,
  getByInstagramPostUrl,
  listByInstagramPostId,
  listByInstagramPostUrl,
  listByStatus,
  listByStatusDateWindow,
  listByStatusDateWindowPaginated,
  listByStatusPaginated,
  listEvents,
  mergeApprovedEvents,
} from "../convex/events.ts";
import {
  backfillFromVenues,
  listActiveSourceHandlesPage,
  listActiveSourcesPage,
  listFreshFetchAttemptMetadataPage,
  listLegacyVenueHandlesPage,
  listLegacyVenueSourcesPage,
  syncFollowingSnapshot,
} from "../convex/instagramSources.ts";
import {
  deleteTerminalOlderThan,
  listJobsForRepairPage,
} from "../convex/ingestionJobs.ts";
import {
  listActiveVenueIngestionFieldsPaginated,
  listInstagramHandleNormalizationPage,
  listVenueIngestionFieldsPaginated,
  previewVenueLifecycleMigration,
} from "../convex/venues.ts";
import { deleteOrphanedPage } from "../convex/mediaAssets.ts";
import { listExistingEventsBySourceIdentityForTesting } from "../lib/pipeline/run-instagram-ingestion.ts";

function serviceCtx(db) {
  return {
    auth: { getUserIdentity: async () => null },
    db,
  };
}

function adminCtx(db) {
  return {
    auth: {
      getUserIdentity: async () => ({ subject: "qa-request-bounds-admin" }),
    },
    db,
  };
}

function queryDb(options = {}) {
  const observations = {
    paginate: [],
    take: [],
  };
  return {
    observations,
    db: {
      query: () => {
        const builder = {
          order: () => builder,
          withIndex: (_indexName, apply) => {
            const q = {
              eq: () => q,
              gte: () => q,
              lt: () => q,
            };
            apply?.(q);
            return builder;
          },
          take: async (limit) => {
            observations.take.push(limit);
            return options.takeRows?.(limit) ?? [];
          },
          paginate: async (paginationOpts) => {
            observations.paginate.push(paginationOpts);
            return {
              continueCursor: "",
              isDone: true,
              page: [],
            };
          },
        };
        return builder;
      },
      get: async () => {
        throw new Error("Bounded admission should reject before document reads.");
      },
    },
  };
}

async function assertRejectsBeforeDatabaseOperation(handler, args, expected) {
  let operationCount = 0;
  const unexpectedOperation = () => {
    operationCount += 1;
    throw new Error("Database operation occurred before bounded admission.");
  };
  const db = {
    delete: unexpectedOperation,
    get: unexpectedOperation,
    insert: unexpectedOperation,
    patch: unexpectedOperation,
    query: unexpectedOperation,
  };
  await assert.rejects(handler(serviceCtx(db), args), expected);
  assert.equal(operationCount, 0, "oversized operations must fail before database access");
}

const previousCronSecret = process.env.CRON_SECRET;
const previousAdminIds = process.env.ADMIN_CLERK_USER_IDS;
process.env.CRON_SECRET = "qa-request-bounds-secret";
process.env.ADMIN_CLERK_USER_IDS = "qa-request-bounds-admin";

try {
  {
    const { db, observations } = queryDb();
    await listJobsForRepairPage._handler(serviceCtx(db), {
      minCreatedAt: 0,
      paginationOpts: {
        cursor: "jobs-cursor",
        endCursor: "jobs-end",
        id: 7,
        maximumRowsRead: 100_000,
        numItems: 100_000,
      },
      serviceSecret: "qa-request-bounds-secret",
    });
    assert.deepEqual(observations.paginate, [
      {
        cursor: "jobs-cursor",
        endCursor: "jobs-end",
        id: 7,
        maximumRowsRead: 100,
        numItems: 100,
      },
    ]);
  }

  for (const [label, handler, extraArgs = {}] of [
    ["active source records", listActiveSourcesPage._handler],
    ["active source handles", listActiveSourceHandlesPage._handler],
    ["legacy venue source records", listLegacyVenueSourcesPage._handler],
    ["legacy venue source handles", listLegacyVenueHandlesPage._handler],
    [
      "fresh fetch-attempt metadata",
      listFreshFetchAttemptMetadataPage._handler,
      { minAttemptAt: 0 },
    ],
  ]) {
    const { db, observations } = queryDb();
    await handler(serviceCtx(db), {
      ...extraArgs,
      paginationOpts: { cursor: null, numItems: 100_000 },
      serviceSecret: "qa-request-bounds-secret",
    });
    assert.deepEqual(
      observations.paginate,
      [{ cursor: null, maximumRowsRead: 200, numItems: 200 }],
      `${label} must clamp its page read`,
    );
  }

  for (const [label, handler] of [
    ["venue ingestion fields", listVenueIngestionFieldsPaginated._handler],
    [
      "active venue ingestion fields",
      listActiveVenueIngestionFieldsPaginated._handler,
    ],
  ]) {
    const { db, observations } = queryDb();
    await handler(serviceCtx(db), {
      paginationOpts: { cursor: null, numItems: 100_000 },
      serviceSecret: "qa-request-bounds-secret",
    });
    assert.deepEqual(
      observations.paginate,
      [{ cursor: null, maximumRowsRead: 100, numItems: 100 }],
      `${label} must clamp its page read`,
    );
  }

  {
    const { db, observations } = queryDb();
    await listByHandlePaginated._handler(serviceCtx(db), {
      handle: "bounded.handle",
      paginationOpts: { cursor: null, numItems: 100_000 },
      serviceSecret: "qa-request-bounds-secret",
    });
    assert.deepEqual(observations.paginate, [
      { cursor: null, maximumRowsRead: 100, numItems: 100 },
    ]);

    await listAllHandlesPaginated._handler(serviceCtx(db), {
      paginationOpts: { cursor: "all-handles", numItems: 100_000 },
      serviceSecret: "qa-request-bounds-secret",
    });
    assert.deepEqual(observations.paginate, [
      { cursor: null, maximumRowsRead: 100, numItems: 100 },
      { cursor: "all-handles", maximumRowsRead: 100, numItems: 100 },
    ]);
  }

  await assertRejectsBeforeDatabaseOperation(
    backfillFromVenues._handler,
    {
      dryRun: true,
      paginationOpts: { cursor: null, numItems: 101 },
      serviceSecret: "qa-request-bounds-secret",
    },
    /Instagram-source backfill page must contain 1 to 100 rows/iu,
  );

  await assertRejectsBeforeDatabaseOperation(
    listInstagramHandleNormalizationPage._handler,
    {
      paginationOpts: { cursor: null, numItems: 201 },
      serviceSecret: "qa-request-bounds-secret",
    },
    /Venue handle normalization pages must contain 1 to 200 rows/iu,
  );

  await assertRejectsBeforeDatabaseOperation(
    previewVenueLifecycleMigration._handler,
    {
      paginationOpts: { cursor: null, numItems: 101 },
      serviceSecret: "qa-request-bounds-secret",
    },
    /Venue lifecycle preview page must contain 1 to 100 rows/iu,
  );

  await assertRejectsBeforeDatabaseOperation(
    listPaidFetchMigrationPage._handler,
    {
      paginationOpts: { cursor: null, numItems: 101 },
      serviceSecret: "qa-request-bounds-secret",
    },
    /Paid-fetch migration page must contain 1 to 100 rows/iu,
  );

  for (const [expectedLabel, handler, args] of [
    [
      "Paid-fetch flag backfill",
      backfillPaidFetchFlags._handler,
      {
        ids: Array.from({ length: 101 }, (_, index) => `post-${index}`),
        serviceSecret: "qa-request-bounds-secret",
      },
    ],
    [
      "Paid-fetch flag reconciliation",
      reconcilePaidFetchFlags._handler,
      {
        horizonCutoffMs: 0,
        ids: Array.from({ length: 101 }, (_, index) => `post-${index}`),
        serviceSecret: "qa-request-bounds-secret",
      },
    ],
  ]) {
    await assertRejectsBeforeDatabaseOperation(
      handler,
      args,
      new RegExp(`${expectedLabel} batch must contain 0 to 100 rows`, "iu"),
    );
  }

  await assertRejectsBeforeDatabaseOperation(
    deleteTerminalOlderThan._handler,
    { cutoffUpdatedAt: 1, limit: 501 },
    /Ingestion-job retention batch size must be between 1 and 500/iu,
  );

  await assertRejectsBeforeDatabaseOperation(
    deleteOldScrapedPosts._handler,
    { cutoffUpdatedAt: 1, cursor: null, limit: 501 },
    /Scraped-post retention batch size must be between 1 and 500/iu,
  );

  await assertRejectsBeforeDatabaseOperation(
    deleteOrphanedPage._handler,
    {
      cutoffUpdatedAt: 1,
      paginationOpts: { cursor: null, numItems: 501 },
    },
    /Orphaned-media cleanup page must contain 1 to 500 rows/iu,
  );

  await assertRejectsBeforeDatabaseOperation(
    deleteOrphanedPage._handler,
    {
      cutoffUpdatedAt: 1,
      paginationOpts: {
        cursor: null,
        maximumRowsRead: 501,
        numItems: 1,
      },
    },
    /Orphaned-media cleanup page row-read budget must be between 1 and 500/iu,
  );

  {
    const { db, observations } = queryDb();
    await listPublicRecentPostsByHandle._handler(serviceCtx(db), {
      handle: "bounded.handle",
      limit: 100_000,
    });
    assert.deepEqual(observations.take, [12]);
  }

  {
    const { db } = queryDb({
      takeRows: (limit) => Array.from({ length: limit }, (_, index) => ({ _id: `post-${index}` })),
    });
    await assert.rejects(
      listByHandle._handler(serviceCtx(db), {
        handle: "overflow.handle",
        serviceSecret: "qa-request-bounds-secret",
      }),
      /compatibility list exceeds its safe bound/iu,
    );
  }

  {
    const { db } = queryDb({
      takeRows: (limit) => Array.from({ length: limit }, (_, index) => ({ _id: `post-${index}` })),
    });
    await assert.rejects(
      getBacklogStateByHandle._handler(serviceCtx(db), {
        handle: "overflow.handle",
        serviceSecret: "qa-request-bounds-secret",
      }),
      /backlog exceeds its safe exact-count bound/iu,
    );
  }

  {
    const { db } = queryDb();
    await assert.rejects(
      getManyScrapedPostsByIds._handler(serviceCtx(db), {
        ids: Array.from({ length: 101 }, (_, index) => `post-${index}`),
        serviceSecret: "qa-request-bounds-secret",
      }),
      /at most 100 IDs/iu,
    );
    await assert.rejects(
      getManyScrapedPostsByIds._handler(serviceCtx(db), {
        ids: ["post-1", "post-1"],
        serviceSecret: "qa-request-bounds-secret",
      }),
      /require unique IDs/iu,
    );
  }

  {
    const { db, observations } = queryDb();
    await listEvents._handler(adminCtx(db), { limit: 100_000 });
    assert.deepEqual(observations.take, [200]);
  }

  {
    const { db, observations } = queryDb();
    await listByStatus._handler(serviceCtx(db), {
      status: "approved",
      limit: 100_000,
      serviceSecret: "qa-request-bounds-secret",
    });
    assert.deepEqual(observations.take, [1_000]);

    await listByStatusPaginated._handler(serviceCtx(db), {
      status: "approved",
      paginationOpts: { cursor: "next", numItems: 100_000 },
      serviceSecret: "qa-request-bounds-secret",
    });
    assert.deepEqual(observations.paginate, [{ cursor: "next", numItems: 100 }]);
  }

  {
    const { db } = queryDb({
      takeRows: (limit) => Array.from({ length: limit }, (_, index) => ({ _id: `event-${index}` })),
    });
    await assert.rejects(
      listByInstagramPostId._handler(serviceCtx(db), {
        instagramPostId: "overloaded-post",
        serviceSecret: "qa-request-bounds-secret",
      }),
      /E_EVENT_SOURCE_MATCH_LIMIT/,
    );
    await assert.rejects(
      listByInstagramPostUrl._handler(serviceCtx(db), {
        instagramPostUrl: "https://www.instagram.com/p/overloaded-post/",
        serviceSecret: "qa-request-bounds-secret",
      }),
      /E_EVENT_SOURCE_MATCH_LIMIT/,
    );
    await assert.rejects(
      listByStatusDateWindow._handler(serviceCtx(db), {
        status: "approved",
        fromDate: "2026-08-01",
        beforeDate: "2026-09-01",
        serviceSecret: "qa-request-bounds-secret",
      }),
      /status\/date compatibility window exceeds its safe bound/iu,
    );
  }

  {
    const { db, observations } = queryDb({
      takeRows: (limit) =>
        Array.from({ length: limit }, (_, index) => ({ _id: `ambiguous-event-${index}` })),
    });
    await assert.rejects(
      getByInstagramPostId._handler(serviceCtx(db), {
        instagramPostId: "ambiguous-post-id",
        serviceSecret: "qa-request-bounds-secret",
      }),
      /Multiple events share this Instagram post ID/iu,
    );
    assert.deepEqual(observations.take, [2]);

    await assert.rejects(
      getByInstagramPostUrl._handler(serviceCtx(db), {
        instagramPostUrl: "https://www.instagram.com/reel/ambiguous-post-url/?igsh=qa",
        serviceSecret: "qa-request-bounds-secret",
      }),
      /Multiple events share this Instagram post URL/iu,
    );
  }

  {
    const postIdFallbackError = new Error("post ID compatibility lookup failed");
    const postIdCalls = [];
    await assert.rejects(
      listExistingEventsBySourceIdentityForTesting(
        {
          async query(reference) {
            postIdCalls.push(reference);
            if (reference === "events:listByInstagramPostId") {
              throw new Error("bounded post ID lookup failed");
            }
            if (reference === "events:getByInstagramPostId") {
              throw postIdFallbackError;
            }
            throw new Error(`Unexpected query ${String(reference)}.`);
          },
        },
        {
          instagramPostUrl: "https://www.instagram.com/p/FAIL-CLOSED-ID/",
          postId: "FAIL-CLOSED-ID",
          username: "qa.venue",
        },
        "qa-request-bounds-secret",
      ),
      (error) => error === postIdFallbackError,
    );
    assert.deepEqual(postIdCalls, [
      "events:listByInstagramPostId",
      "events:getByInstagramPostId",
    ]);

    const postUrlFallbackError = new Error("post URL compatibility lookup failed");
    const postUrlCalls = [];
    await assert.rejects(
      listExistingEventsBySourceIdentityForTesting(
        {
          async query(reference) {
            postUrlCalls.push(reference);
            if (reference === "events:listByInstagramPostId") return [];
            if (reference === "events:listByInstagramPostUrl") {
              throw new Error("bounded post URL lookup failed");
            }
            if (reference === "events:getByInstagramPostUrl") {
              throw postUrlFallbackError;
            }
            throw new Error(`Unexpected query ${String(reference)}.`);
          },
        },
        {
          instagramPostUrl: "https://www.instagram.com/p/FAIL-CLOSED-URL/",
          postId: "FAIL-CLOSED-URL",
          username: "qa.venue",
        },
        "qa-request-bounds-secret",
      ),
      (error) => error === postUrlFallbackError,
    );
    assert.deepEqual(postUrlCalls, [
      "events:listByInstagramPostId",
      "events:listByInstagramPostUrl",
      "events:getByInstagramPostUrl",
    ]);
  }

  {
    const { db, observations } = queryDb();
    await listByStatusDateWindowPaginated._handler(serviceCtx(db), {
      status: "approved",
      fromDate: "2026-08-01",
      beforeDate: "2026-09-01",
      paginationOpts: { cursor: null, numItems: 100_000 },
      serviceSecret: "qa-request-bounds-secret",
    });
    assert.deepEqual(observations.paginate, [{ cursor: null, numItems: 100 }]);
  }

  {
    const { db } = queryDb();
    await assert.rejects(
      mergeApprovedEvents._handler(serviceCtx(db), {
        primaryId: "primary",
        duplicateIds: Array.from({ length: 17 }, (_, index) => `duplicate-${index}`),
        patch: {},
        serviceSecret: "qa-request-bounds-secret",
      }),
      /at most 16 duplicates/iu,
    );
  }

  {
    const { db } = queryDb({
      takeRows: (limit) => Array.from({ length: limit }, (_, index) => ({
        _id: `source-${index}`,
        active: true,
        handle: `source.${index}`,
      })),
    });
    await assert.rejects(
      syncFollowingSnapshot._handler(serviceCtx(db), {
        sourceHandle: "eventzeka",
        accounts: [{ handle: "source.present" }],
        providerSucceeded: true,
        snapshotComplete: true,
        rawItemCount: 1,
        malformedItemCount: 0,
        maxItems: 10,
        startedAt: 1,
        serviceSecret: "qa-request-bounds-secret",
      }),
      /active-source sweep exceeds its safe bound/iu,
    );
  }

  const venuesSource = readFileSync(new URL("../convex/venues.ts", import.meta.url), "utf8");
  const compatibilitySection = venuesSource.slice(
    venuesSource.indexOf("async function collectScrapeActiveVenues"),
    venuesSource.indexOf("export const listVenueIngestionFieldsPaginated"),
  );
  assert.doesNotMatch(compatibilitySection, /\.collect\(\)/);
  assert.match(compatibilitySection, /MAX_PUBLIC_VENUE_DIRECTORY_LIMIT \+ 1/);
} finally {
  if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousCronSecret;
  if (previousAdminIds === undefined) delete process.env.ADMIN_CLERK_USER_IDS;
  else process.env.ADMIN_CLERK_USER_IDS = previousAdminIds;
}

console.log("Request-path bounds QA passed.");
