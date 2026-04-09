# Nextcloud Migration Service

Migrates a user's entire Nextcloud file tree into their Cozy instance. Runs as a standalone RabbitMQ consumer — no web server, no database.

## How it works

When a user triggers a migration from the Settings UI, the Cozy Stack creates a tracking document and publishes a message to RabbitMQ. This service picks it up and:

1. Gets a short-lived token from the Cloudery
2. Checks idempotency (skip if already running or completed)
3. Validates there's enough disk quota on the Cozy side
4. ACKs the message early (the tracking document takes over as source of truth)
5. Walks the Nextcloud tree directory by directory, transferring each file through the Stack's `/remote/nextcloud/` proxy routes
6. Updates the tracking document after each file so the user sees live progress

The service never talks to Nextcloud directly. All file operations go through the Cozy Stack, which handles WebDAV internally. The migration service is purely an orchestrator.

### Error handling

- A single file failure doesn't abort the migration — the error is logged in the tracking document and the service moves on.
- If a file already exists in Cozy (409 from the Stack), it's skipped. This makes migrations resumable: retry after a crash and already-transferred files are silently skipped.
- Token expiration mid-migration triggers an automatic refresh from the Cloudery.
- If the entire Stack becomes unreachable, the migration is marked as failed.

### Architecture

```
RabbitMQ ──message──▶ This Service ──HTTP──▶ Cozy Stack ──WebDAV──▶ Nextcloud
                           │
                           ├──▶ Cloudery (token acquisition)
                           └──▶ CouchDB via Stack (tracking document)
```

## Configuration

Copy `.env.example` to `.env` and fill in the values:

| Variable | Required | Description |
|---|---|---|
| `RABBITMQ_URL` | yes | AMQP connection URL (e.g. `amqp://user:pass@rabbitmq:5672`) |
| `CLOUDERY_URL` | yes | Cloudery base URL (e.g. `https://manager.cozycloud.cc`) |
| `CLOUDERY_TOKEN` | yes | API bearer token for the Cloudery's public endpoint |
| `LOG_LEVEL` | no | `trace`, `debug`, `info`, `warn`, `error`, `fatal` (default: `info`) |

## Development

```bash
npm install
npm test          # run tests
npm run lint      # type check
npm run build     # compile to dist/
```

## Docker

```bash
docker build -t twake-migration-nextcloud .
docker run --env-file .env twake-migration-nextcloud
```

The image is published to `ghcr.io/linagora/twake-migration-nextcloud`:
- `latest` — built from every push to `main`
- `v1.0.0` (semver) — built from version tags

## RabbitMQ contract

| Setting | Value |
|---|---|
| Exchange | `migration` (topic, durable) |
| Routing key | `nextcloud.migration.requested` |
| Queue | `migration.nextcloud.commands` (quorum) |
| DLX | `migration.dlx` |
| DLQ | `migration.nextcloud.commands.dlq` |
| Ack | Manual — ACKed after validation, before migration starts |
| Delivery limit | 3 retries before DLQ |

## Tracking document

Doctype: `io.cozy.nextcloud.migrations`

Created by the Stack when the user starts a migration. Updated by this service throughout:

```json
{
  "status": "running",
  "target_dir": "/Nextcloud",
  "progress": {
    "files_imported": 142,
    "files_total": 1500,
    "bytes_imported": 1073741824,
    "bytes_total": 5368709120
  },
  "errors": [],
  "skipped": [],
  "started_at": "2026-04-08T10:00:00Z",
  "finished_at": null
}
```

Status transitions: `pending` → `running` → `completed` or `failed`.

## Related

- [ADR 038](docs/superpowers/specs/2026-04-09-nextcloud-migration-service-design.md) — design decisions
- Cozy Stack — `/remote/nextcloud/` proxy routes, `/nextcloud/migration` trigger endpoint
- Cloudery — `/api/public/instances/{fqdn}/nextcloud_migration_token` token endpoint
