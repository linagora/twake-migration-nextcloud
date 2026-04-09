# Nextcloud Migration Service — Design Spec

## Purpose

A standalone RabbitMQ consumer that migrates a user's Nextcloud files into their Cozy instance via the Stack's `/remote/nextcloud/` proxy routes. No database, no web server — just a message consumer that reads from a queue and orchestrates file transfers.

## Architecture

```
RabbitMQ                    This Service                 Cozy Stack           Nextcloud
  |                              |                           |                    |
  |-- migration.requested ------>|                           |                    |
  |                              |-- GET token ------------->| (Cloudery)         |
  |                              |-- GET tracking doc ------>|                    |
  |                              |-- validate quota -------->|                    |
  |<---- ACK -------------------|                           |                    |
  |                              |-- set status: running --->|                    |
  |                              |-- list dir --------------->|--- WebDAV -------->|
  |                              |-- transfer file ---------->|--- GET file ------>|
  |                              |-- update progress -------->|                    |
  |                              |-- set status: completed -->|                    |
```

The service:
1. Consumes `nextcloud.migration.requested` messages from RabbitMQ.
2. Obtains a short-lived token from the Cloudery.
3. Validates idempotency (skip if already running/completed) and quota.
4. ACKs the message early (validation passed).
5. Recursively traverses the Nextcloud directory tree, transferring each file via the Stack's `downstream` route.
6. Updates a tracking document (`io.cozy.nextcloud.migrations`) throughout the process.

## Concurrency

Multiple migrations run concurrently, bounded by `prefetch: 10`. Each migration is independent — its own token, its own tracking doc, its own instance. No shared mutable state between migrations.

## Message Schema

```typescript
interface MigrationCommand {
  migrationId: string
  workplaceFqdn: string
  accountId: string
  sourcePath: string    // defaults to "/"
  timestamp: number
}
```

## Tracking Document (`io.cozy.nextcloud.migrations`)

Created by the Stack before publishing the message. Updated by this service throughout the migration.

Fields: `status` (pending | running | completed | failed), `started_at`, `finished_at`, `bytes_total`, `bytes_imported`, `files_imported`, `errors[]`, `skipped[]`.

Updates use optimistic concurrency (CouchDB `_rev`) with 409 retry (read-apply-put, max 5 retries).

## Components

### `config.ts` — Environment variables
- `RABBITMQ_URL`, `CLOUDERY_URL`, `CLOUDERY_TOKEN`, `LOG_LEVEL` (default: info)

### `consumer.ts` — RabbitMQ consumer
- Uses `@linagora/rabbitmq-client` for connection, exchange/queue declaration, DLX/DLQ, consumer lifecycle.
- Exchange: `migration` (topic, durable). Queue: `migration.nextcloud.commands` (quorum). Routing key: `nextcloud.migration.requested`.
- Handler validates, then fires and forgets `runMigration()` (early ACK). Failures in validation throw to trigger retry/DLQ.

### `cloudery-client.ts` — Token acquisition
- `POST {CLOUDERY_URL}/api/public/instances/{fqdn}/nextcloud_migration_token` with bearer auth.
- Returns the `token` field.

### `stack-client.ts` — Cozy Stack HTTP client
- Base URL: `https://{workplaceFqdn}`. Bearer token from Cloudery.
- Methods: `listNextcloudDir`, `transferFile`, `createDir`, `getDiskUsage`, `getTrackingDoc`, `updateTrackingDoc`.
- Token refresh on 401: call Cloudery for a fresh token (exponential backoff, 3 retries), retry the original request once.

### `tracking.ts` — Tracking document helpers
- `updateTracking(stackClient, docId, updater)`: read-apply-put with 409 retry.
- Helpers: `setRunning`, `setCompleted`, `setFailed`, `incrementProgress`, `addError`, `addSkipped`.

### `migration.ts` — Core orchestration
- `runMigration(command, stackClient)`: sets running, ensures target dir (`/Nextcloud`), recursively traverses and transfers.
- Per-file error handling: log + add to tracking doc, never abort the whole migration.
- 409 on `downstream` (file exists): skip (resume scenario).
- 401: trigger token refresh, retry.
- 5xx/network: exponential backoff (5 retries, max 2min). Multiple consecutive failures → mark migration failed.

### `index.ts` — Entry point
- Connects RabbitMQ, starts consuming.
- Graceful shutdown on SIGTERM/SIGINT: stop consuming, wait for in-flight migrations, close connection, exit.

## Error Handling

| Scenario | Behavior |
|---|---|
| Invalid message / Cloudery unreachable | Handler throws → retry/DLQ (pre-ACK) |
| Insufficient quota | Update tracking to failed, ACK, return |
| Already running/completed | ACK, skip |
| Single file transfer failure | Log, add to tracking errors, continue |
| Stack 409 on file transfer | Skip file (already exists), continue |
| Stack 401 | Refresh token, retry once |
| Stack 5xx / network error | Exponential backoff (5 retries). Persistent → mark migration failed |
| Service shutdown during migration | Wait for in-flight migrations to finish; if urgent, mark failed |

## Testing

- **Unit**: tracking 409 retry, traversal logic with mocked Stack client, message parsing + idempotency.
- **Integration**: real RabbitMQ (docker-compose) + mocked Stack HTTP. Publish message, verify consumer processes it.
- **Mock tooling**: `@linagora/rabbitmq-client/testing` (`createMockAmqplib`, `simulateMessage`).

## Dependencies

- `@linagora/rabbitmq-client` — RabbitMQ connection, exchange/queue, consumer, DLX/DLQ
- `pino` — structured JSON logging with `migration_id` and `instance` context
- Native `fetch` (Node 20) — HTTP calls to Stack and Cloudery

## External Prerequisites (other teams)

- Stack: `POST /nextcloud/migration` endpoint, `ExchangeMigration` constant, `io.cozy.nextcloud.migrations` doctype
- Cloudery: `POST /api/public/instances/{fqdn}/nextcloud_migration_token` endpoint
