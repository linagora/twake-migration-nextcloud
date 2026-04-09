# @linagora/rabbitmq-client

An opinionated RabbitMQ client for Node.js that handles the boilerplate you'd otherwise copy-paste between services: confirm channels, dead letter queues, exponential backoff on publish, and automatic reconnection that restores your subscriptions.

## Install

```bash
npm install @linagora/rabbitmq-client
```

## Quick start

```typescript
import { RabbitMQClient } from '@linagora/rabbitmq-client'

const client = new RabbitMQClient({ url: 'amqp://localhost' })
await client.init()

await client.publish('auth', 'user.created', { userId: '123' })

await client.subscribe('auth', 'user.created', 'my-service.user-created', async (msg) => {
  // your logic here
})

await client.close()
```

## Configuration

Only `url` is required. Everything else has defaults.

| Option | Default | Description |
|--------|---------|-------------|
| `url` | -- | AMQP connection string |
| `maxRetries` | `3` | How many times to retry a failed handler before sending the message to DLQ |
| `retryDelay` | `1000` | Milliseconds between handler retries |
| `connectionRetryDelay` | `5000` | Milliseconds between reconnection attempts |
| `initMaxAttempts` | `5` | Connection attempts on startup before giving up |
| `publishMaxAttempts` | `5` | Publish retries (exponential backoff, capped at 60s) |
| `prefetch` | `10` | Channel prefetch count |
| `closeTimeout` | `5000` | Milliseconds to wait for in-flight messages when closing |
| `logger` | -- | Parent [pino](https://github.com/pinojs/pino) instance (the library creates its own if omitted) |
| `hooks` | -- | Observability callbacks (see [Hooks](#hooks)) |

## How it works

### Publishing

Publishes go through a confirm channel, so you know the broker accepted the message. If something goes wrong, the client retries with exponential backoff and forces a new channel on each attempt to avoid retrying on a silently dead connection. Exchange assertions are cached per connection to avoid unnecessary AMQP round-trips on the hot path.

You can pass headers, correlation IDs, and other AMQP properties:

```typescript
await client.publish('auth', 'user.created', { userId: '123' }, {
  headers: { 'x-trace-id': traceId },
  correlationId: requestId,
  messageId: uuid(),
  expiration: '60000', // TTL in ms
})
```

### Subscribing

Each call to `subscribe` wires up the DLQ plumbing for you:

- A dead letter exchange (`<exchange>.dlx`)
- A dead letter queue (`<queue>.dlq`)
- A dead letter routing key (`<routingKey>.dead`)

The main queue is created as a quorum queue with `at-least-once` delivery and `reject-publish` overflow. Messages are manually acknowledged.

You can override the default queue arguments by passing a fifth argument:

```typescript
await client.subscribe('events', 'order.placed', 'order-queue', handler, {
  queueArguments: { 'x-queue-type': 'classic', 'x-max-length': 10_000 },
})
```

Custom arguments are merged with the DLQ wiring defaults, so you can swap the queue type or add a max-length without losing dead-letter routing.

### Unsubscribing

Cancel a consumer and remove it from the auto-restoration list:

```typescript
await client.unsubscribe('order-queue')
```

After unsubscribing, the queue will not be re-subscribed on reconnection.

### Message handling

Incoming messages are JSON-parsed first. If that fails, the message goes straight to the DLQ (no point retrying garbage). Otherwise, your handler runs up to `maxRetries` times. Success means ack, final failure means nack to the DLQ.

### Reconnection

If the connection or channel drops, the client reconnects and re-subscribes to everything automatically. Multiple reconnection triggers (e.g. connection close + channel close firing at the same time) are collapsed into a single attempt.

### Graceful shutdown

`close()` waits for in-flight message handlers to finish before tearing down the channel, up to `closeTimeout` milliseconds. If handlers don't drain in time, the client closes anyway and logs a warning.

```typescript
// wait for handlers to finish, then close
await client.close()

// close but keep subscriptions for a later init()
await client.close(false)
```

### Health check

`checkHealth()` creates and immediately deletes a temporary queue. Useful for Kubernetes readiness probes.

```typescript
const healthy = await client.checkHealth()
```

## Hooks

Optional callbacks for wiring metrics, tracing, or alerting. Hook errors are swallowed so they never break message flow.

```typescript
const client = new RabbitMQClient({
  url: 'amqp://localhost',
  hooks: {
    onPublish({ exchange, routingKey, attempts }) {
      metrics.increment('rabbitmq.publish', { exchange })
    },
    onMessageProcessed({ exchange, routingKey, duration, attempts }) {
      metrics.histogram('rabbitmq.handler.duration', duration)
    },
    onMessageDlq({ exchange, routingKey, duration, reason }) {
      alerting.warn(`Message sent to DLQ: ${reason}`)
    },
    onReconnect({ subscriptionsRestored, subscriptionsFailed }) {
      metrics.increment('rabbitmq.reconnect')
    },
  },
})
```

| Hook | Fires when |
|------|-----------|
| `onPublish` | A message is confirmed by the broker |
| `onMessageProcessed` | A handler completes successfully (includes duration and retry count) |
| `onMessageDlq` | A message is nacked to the DLQ — reason is `'invalid_json'` or `'max_retries_exhausted'` |
| `onReconnect` | The client reconnects and re-establishes subscriptions |

## Test helpers

The `@linagora/rabbitmq-client/testing` entrypoint provides mocks that don't depend on any test framework.

```typescript
import { createMockAmqplib } from '@linagora/rabbitmq-client/testing'

const { mockConnection, amqpMock } = createMockAmqplib()

// check what was published
mockConnection.channel.getPublishedMessages()

// feed a message into a consumer
mockConnection.channel.simulateMessage({ userId: '123' })

// simulate a broker going down
mockConnection.simulateClose()
```

## License

MIT
