# RabbitMQ Contract

## Topology

The service consumes from two queues, both bound to the same topic exchange.

| Purpose | Routing key | Queue |
|---|---|---|
| Migration request | `nextcloud.migration.requested` | `migration.nextcloud.commands` |
| Migration cancel | `nextcloud.migration.canceled` | `migration.nextcloud.cancels` |

| Component | Value |
|---|---|
| Exchange | `migration` (topic, durable) |
| Dead-letter exchange | `migration.dlx` |
| Dead-letter queues | `migration.nextcloud.commands.dlq`, `migration.nextcloud.cancels.dlq` |

Both queues are quorum, durable, and created automatically by `@linagora/rabbitmq-client` on startup.

## Migration request

### Message format

Published by the Cozy Stack when a user starts a migration.

```json
{
  "migrationId": "d4e5f6a7-b8c9-4d0e-a1b2-c3d4e5f6a7b8",
  "workplaceFqdn": "alice.cozy.example.com",
  "accountId": "a1b2c3d4e5f6",
  "sourcePath": "/",
  "timestamp": 1712563200
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `migrationId` | string (UUID) | yes | Matches the tracking document `_id` |
| `workplaceFqdn` | string | yes | Target Cozy instance FQDN |
| `accountId` | string | yes | `io.cozy.accounts` document ID for the Nextcloud connection |
| `sourcePath` | string | no | Nextcloud directory to migrate (defaults to `/`) |
| `timestamp` | number | yes | Unix timestamp of the request |

Nextcloud credentials (URL, login, app password) are stored in the `io.cozy.accounts` document, not in the message. The service references the account by ID when calling the Stack's Nextcloud routes.

### Acknowledgment

Messages are ACKed **early** — after validation passes and a concurrency slot has been reserved, but before the migration itself starts. This avoids holding the message unacked for hours during a large migration, while still applying backpressure: if the concurrency cap is reached, the handler blocks before ACK and the message stays with the broker.

After ACK, the tracking document in CouchDB is the sole source of truth for migration state. A crashed consumer is recovered by the heartbeat logic, not by re-delivery of the original message.

## Migration cancel

Published by the Cozy Stack when the user hits the "Cancel migration" button in the UI.

```json
{
  "migrationId": "d4e5f6a7-b8c9-4d0e-a1b2-c3d4e5f6a7b8",
  "workplaceFqdn": "alice.cozy.example.com",
  "timestamp": 1712563260
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `migrationId` | string (UUID) | yes | The migration to stop; matches the tracking document `_id`. |
| `workplaceFqdn` | string | yes | Target Cozy instance FQDN; the handler needs it to fetch a token and write the cancel flag on the tracking doc. |
| `timestamp` | number | yes | Unix timestamp of the cancel request. |

### Semantics

Cancellation is **cooperative** and **between files**. The handler writes `cancel_requested: true` on the tracking doc and signals the in-process `AbortController` for the migration. The running walker checks the signal at directory and file boundaries, finishes the file currently in flight (never aborted mid-transfer), and transitions the doc to `canceled`. Worst-case wait for a stop is roughly one file transfer — up to 15 minutes for a large file on a slow network.

Cancels arriving in non-obvious windows are all handled:

| When the cancel arrives | Outcome |
|---|---|
| Before the request message is picked up | Request handler sees `cancel_requested: true`, transitions the doc to `canceled`, ACKs without launching. |
| While the migration is running on this pod | `AbortController` fires, next checkpoint throws, doc goes to `canceled` with the progress up to the last completed file. |
| While the migration is running on another pod | The durable flag is read at the next `flushProgress` — worst-case one flush interval away. |
| After the migration already reached a terminal state | No-op; handler logs `cancel.ignored_terminal` and ACKs. |
| For an unknown `migrationId` | Tracking doc 404; handler logs `cancel.tracking_doc_not_found` and ACKs. |

### Acknowledgment

Cancel handlers ACK after both the durable flag write and the local runner signal complete. Transient failures (Cloudery 5xx, Stack 5xx, CouchDB conflict exhaustion) throw so the library retries up to 3× and eventually DLQs — a lost cancel is a real UX regression, so the retry budget is worth spending.

## Retries and dead-lettering

Pre-ACK failures are classified rather than uniformly retried — the library's 3× retry budget is precious and shouldn't be spent on messages that will never succeed.

**Transient, worth retrying** (Stack 5xx, network blip, CouchDB conflict exhaustion): the handler throws, the library retries up to 3 times with a 1-second delay, then the message dead-letters.

**Permanent, retry won't help** (malformed payload, missing tracking document, source path not found in Nextcloud): the handler logs, marks the tracking doc failed where that's applicable, and ACKs. No retry, no DLQ pollution.

Post-ACK failures (per-file transfer errors, file already exists, migration-level faults) are handled by the migration itself and recorded in the tracking document. They never involve RabbitMQ.

## Idempotency

Before starting, the service reads the tracking document:

| Tracking doc status | Action |
|---|---|
| `completed` | ACK and skip |
| `canceled` | ACK and skip — the migration was already canceled |
| `running`, fresh heartbeat | ACK and skip — another consumer is on it |
| `running`, stale heartbeat | Resume — the previous consumer crashed; see [Tracking document](tracking.md#heartbeat-and-stale-running-recovery) |
| `pending` | Proceed normally |
| `failed` | Proceed (retry scenario) |
| any non-terminal + `cancel_requested: true` | Transition straight to `canceled` and ACK without launching |

A heartbeat is considered stale after 30 minutes with no progress write.

## Concurrency

The RabbitMQ prefetch is 10, but that only governs how many messages can be in the hands of handlers concurrently. The actual cap on in-flight migrations is controlled by `MAX_CONCURRENT_MIGRATIONS` (default 10). When every slot is full, new handlers block waiting for one to free, which applies natural backpressure through the unacked message count.

Graceful shutdown (SIGTERM/SIGINT) waits up to 60 s for in-flight migrations to finish before the process exits. Anything still running past the deadline is reclaimed by the heartbeat recovery on the next consumer that picks the message up.
