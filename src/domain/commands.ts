import type { CancelCommand, MigrationCommand } from './types.js'

/**
 * Reads a required string field off a raw RabbitMQ payload. Shared by
 * the request and cancel parsers so error messages stay consistent and
 * a single change point covers both.
 *
 * @param msg - Raw message payload
 * @param key - Field name to read
 * @param kind - Human-readable message kind, interpolated into the
 *   error message (e.g. `'migration'`, `'cancel'`)
 * @throws If the field is missing, empty, or not a string
 */
function requireString(msg: Record<string, unknown>, key: string, kind: string): string {
  const value = msg[key]
  if (typeof value !== 'string' || !value) {
    throw new Error(`Invalid ${kind} message: missing or empty ${key}`)
  }
  return value
}

/**
 * Reads the `timestamp` field off a raw payload, defaulting to the
 * current time when the field is missing or malformed. Mirrors the
 * original request parser's tolerant behaviour.
 *
 * @param msg - Raw message payload
 * @returns The payload timestamp in ms, or `Date.now()` as a fallback
 */
function coerceTimestamp(msg: Record<string, unknown>): number {
  return typeof msg.timestamp === 'number' ? msg.timestamp : Date.now()
}

/**
 * Validates and extracts a CancelCommand from a raw RabbitMQ message.
 * @throws If migrationId or workplaceFqdn are missing
 */
export function parseCancelCommand(msg: Record<string, unknown>): CancelCommand {
  return {
    migrationId: requireString(msg, 'migrationId', 'cancel'),
    workplaceFqdn: requireString(msg, 'workplaceFqdn', 'cancel'),
    timestamp: coerceTimestamp(msg),
  }
}

/**
 * Validates and extracts a MigrationCommand from a raw RabbitMQ message.
 * @throws If migrationId, workplaceFqdn, or accountId are missing
 */
export function parseMigrationCommand(msg: Record<string, unknown>): MigrationCommand {
  return {
    migrationId: requireString(msg, 'migrationId', 'migration'),
    workplaceFqdn: requireString(msg, 'workplaceFqdn', 'migration'),
    accountId: requireString(msg, 'accountId', 'migration'),
    sourcePath: typeof msg.sourcePath === 'string' ? msg.sourcePath : '/',
    timestamp: coerceTimestamp(msg),
  }
}
