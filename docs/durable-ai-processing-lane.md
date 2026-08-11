# Durable AI processing lane

The durable ingestion controller separates paid Instagram acquisition from AI
processing. Six fixed fetch lanes may select and persist posts concurrently,
while Convex grants at most one `processing` receipt lease per run. Every route
request offers to consume that AI lease before claiming more fetch work, so the
existing host runner remains the consumer and does not need a seventh process.

## Receipt lifecycle

```text
queued -> running (Apify) -> processing_pending -> processing (OpenAI)
                                              -> fetched | failed
queued -> running (Apify) -> no_post | deferred | failed
```

- `providerAttemptCount` is written immediately before Apify transport.
- A selected post is persisted, verified, and linked by `scrapedPostId` plus
  its immutable `scrapedPostSourceRevision` before the fetch lease becomes
  `processing_pending`.
- `executeNext` never returns a persisted receipt to a fetch lane.
- The AI consumer loads only the linked post ID and carries that exact ID and
  expected revision through every claim, event/media fence, analysis marker,
  and terminal result write. It reuses the existing prompt, model, cached
  analysis, and global OpenAI lease.
- Busy/deferred OpenAI leases release the receipt back to
  `processing_pending` and return HTTP 202. They do not consume the AI retry
  limit or cause the host runner to restart.
- `completeProcessingReceipt` verifies that the linked saved post has an
  explicit terminal outcome before terminalizing the original receipt.
  `receipt_complete` and `terminal_no_event` (a processed non-event skip) map
  to `fetched`; `terminal_permanent_failure` maps to `failed` and contributes
  to failed-receipt accounting.
- Expired and duplicate AI workers are fenced by receipt owner/expiry; cached
  saved-post analysis prevents a second model request after a committed result.
- Receipt expiry, retry exhaustion, and operator abort atomically revoke the
  matching exact scraped-post owner/revision before changing receipt state, so
  stale event, media, analysis, and terminal-result writes cannot outlive it.

## Additive rollout

Deploy the Convex schema/functions before the web build. The persistence
mutation keeps the preceding web protocol compatible: an old worker omits
`processingProtocolVersion`, records persistence, and retains its `running`
lease so its existing completion/release call remains valid. The new web build
supplies `processingProtocolVersion: 1`, the exact ID returned by the upsert,
and the selected post ID/URL, then enters the processing queue atomically.

Already-live paid receipts are handled without another Apify request:

- queued/running receipts with `providerResultStatus: "persisted"` migrate to
  `processing_pending`;
- an unlinked legacy receipt remains no-refetch and nonterminal; it is never
  matched by handle or timestamp;
- `linkPersistedReceiptPostForRecovery` lets an authenticated admin/service
  attest the exact saved-post ID. It verifies handle, provider boundary,
  fetch-window timing, and current source revision before making work eligible.
  Reopening a completed run also transactionally refuses to overlap any other
  building, queued, or running durable run.
- a `provider_attempt_persistence_unconfirmed` receipt can use the same exact-ID
  attestation when post persistence committed but its marker did not;
- legacy terminal `deferred` AI-contention receipts remain unchanged until the
  exact-ID recovery mutation reopens them. Processing claims never reopen a
  completed run implicitly, even when an older receipt already carries a link.

No data backfill or runner restart is required for active nonterminal runs with
new or already-linked work. Linked or unlinked deferred work in a completed run
requires the guarded authenticated exact-ID recovery call; this is deliberately
operator-attested because no immutable mapping exists in older unlinked
receipts. After that call reopens a completed run, the operator must invoke
`scripts/ig-event-durable-runner <runId>` for that run ID; the mutation queues
the work durably but does not launch a host process.

## Host transport

Production starts Next with a 120-second HTTP keep-alive timeout. This must stay
above Traefik's 90-second upstream idle-connection pool so the proxy cannot
reuse a five-second Next socket while it is closing and turn an internal POST
into a synthetic 502.

The durable runner classifies transient curl/network failures and HTTP
408/425/429/5xx responses per worker. It retries the same durable run and fixed
slot with exponential backoff capped at 60 seconds; the receipt's atomic
provider marker prevents a lost response from issuing another Apify request.
Permanent HTTP failures still fail the supervised runner. Each worker writes
its bearer header to a mode-0600 temporary curl config, removes the secret from
curl's inherited environment, and cleans the config on exit.

The new indexes must be ready before switching the web build:

- `ingestionRunHandleReceipts.by_run_status_providerResultStatus`

Rollback must keep the additive schema/functions in place until all
`processing_pending` and `processing` receipts have drained; an older web build
does not understand those statuses.
