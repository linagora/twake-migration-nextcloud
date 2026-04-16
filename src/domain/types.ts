export interface MigrationCommand {
  migrationId: string
  workplaceFqdn: string
  accountId: string
  sourcePath: string
  timestamp: number
}

/** Doctype: io.cozy.nextcloud.migrations */
export interface TrackingDoc {
  _id: string
  _rev?: string
  /**
   * Schema version stamped on every write, so future consumers can
   * evolve the shape without guessing which fields exist. Bump when
   * the shape changes incompatibly.
   */
  schema_version?: number
  status: 'pending' | 'running' | 'completed' | 'failed'
  target_dir: string
  progress: TrackingProgress
  /** Per-file errors, capped at {@link MAX_ERRORS_CAP}. */
  errors: TrackingError[]
  /**
   * Number of per-file errors that were dropped to stay within the
   * cap. Added rather than resizing the doc unbounded: a wide
   * migration with many failures would otherwise grow the doc past
   * CouchDB's per-document limit.
   */
  errors_truncated_count?: number
  /** Files skipped (typically via 409 on resume), capped at {@link MAX_SKIPPED_CAP}. */
  skipped: TrackingSkipped[]
  /** Number of skipped entries dropped to stay within the cap. */
  skipped_truncated_count?: number
  started_at: string | null
  finished_at: string | null
  /**
   * ISO timestamp stamped on every progress flush. Distinguishes an
   * actively-running migration from a zombie left behind by a crashed
   * consumer: a `running` doc whose heartbeat is older than the stale
   * threshold is resumable. Optional for backward compatibility with
   * docs written before the field existed.
   */
  last_heartbeat_at?: string | null
  /**
   * Human-readable reason a migration is in `failed` status. Distinct
   * from the per-file `errors` array, which is only meant to list
   * individual files that could not be transferred. Dual-written
   * alongside the legacy `{ path: '', message, at }` sentinel in
   * `errors` for back-compat with frontends still reading the old
   * shape; new consumers should prefer this field.
   */
  failure_reason?: string | null
}

export interface TrackingProgress {
  files_imported: number
  files_total: number
  bytes_imported: number
  bytes_total: number
}

export interface TrackingError {
  path: string
  message: string
  at: string
}

export interface TrackingSkipped {
  path: string
  reason: string
  size: number
}

/**
 * Validates and extracts a MigrationCommand from a raw RabbitMQ message.
 * @param msg - Raw message payload from RabbitMQ
 * @returns Validated MigrationCommand with defaults for optional fields
 * @throws If migrationId, workplaceFqdn, or accountId are missing
 */
export function parseMigrationCommand(msg: Record<string, unknown>): MigrationCommand {
  const { migrationId, workplaceFqdn, accountId, sourcePath, timestamp } = msg
  if (typeof migrationId !== 'string' || !migrationId) {
    throw new Error(`Invalid migration message: missing or empty migrationId`)
  }
  if (typeof workplaceFqdn !== 'string' || !workplaceFqdn) {
    throw new Error(`Invalid migration message: missing or empty workplaceFqdn`)
  }
  if (typeof accountId !== 'string' || !accountId) {
    throw new Error(`Invalid migration message: missing or empty accountId`)
  }
  return {
    migrationId,
    workplaceFqdn,
    accountId,
    sourcePath: typeof sourcePath === 'string' ? sourcePath : '/',
    timestamp: typeof timestamp === 'number' ? timestamp : Date.now(),
  }
}
