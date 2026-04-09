import type { Logger } from 'pino'
import type { StackClient } from './stack-client.js'
import type { MigrationCommand } from './types.js'
import {
  setRunning,
  setCompleted,
  setFailed,
  incrementProgress,
  updateBytesTotal,
  addError,
  addSkipped,
  isConflictError,
} from './tracking.js'

const COZY_ROOT_DIR_ID = 'io.cozy.files.root-dir'
const TARGET_DIR_NAME = 'Nextcloud'

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface MigrationContext {
  command: MigrationCommand
  stackClient: StackClient
  logger: Logger
  discovered: { bytesTotal: number; filesTotal: number }
  transferred: { bytes: number; files: number }
  errors: number
  skipped: number
  startedAt: number
}

async function traverseDir(
  accountId: string,
  ncPath: string,
  cozyDirId: string,
  ctx: MigrationContext
): Promise<void> {
  const { migrationId } = ctx.command
  const entries = await ctx.stackClient.listNextcloudDir(accountId, ncPath)

  for (const entry of entries) {
    if (entry.type === 'directory') {
      try {
        const subDirId = await ctx.stackClient.createDir(cozyDirId, entry.name)
        await traverseDir(accountId, entry.path, subDirId, ctx)
      } catch (error) {
        ctx.errors += 1
        const message = getErrorMessage(error)
        ctx.logger.error({
          event: 'migration.dir_failed',
          nc_path: entry.path,
          error: message,
          total_errors: ctx.errors,
          elapsed_ms: Date.now() - ctx.startedAt,
        }, 'Directory traversal failed')
        await addError(ctx.stackClient, migrationId, entry.path, message)
      }
    } else {
      ctx.discovered.bytesTotal += entry.size
      ctx.discovered.filesTotal += 1

      try {
        const fileStart = Date.now()
        const file = await ctx.stackClient.transferFile(accountId, entry.path, cozyDirId)
        await incrementProgress(ctx.stackClient, migrationId, file.size)
        ctx.transferred.bytes += file.size
        ctx.transferred.files += 1

        ctx.logger.info({
          event: 'migration.file_transferred',
          nc_path: entry.path,
          size: file.size,
          duration_ms: Date.now() - fileStart,
          transferred_bytes: ctx.transferred.bytes,
          transferred_files: ctx.transferred.files,
          discovered_bytes: ctx.discovered.bytesTotal,
          discovered_files: ctx.discovered.filesTotal,
          total_errors: ctx.errors,
          total_skipped: ctx.skipped,
          elapsed_ms: Date.now() - ctx.startedAt,
        }, 'File transferred')
      } catch (error) {
        if (isConflictError(error)) {
          ctx.skipped += 1
          ctx.logger.info({
            event: 'migration.file_skipped',
            nc_path: entry.path,
            size: entry.size,
            reason: 'already_exists',
            total_skipped: ctx.skipped,
            elapsed_ms: Date.now() - ctx.startedAt,
          }, 'File already exists, skipping')
          await addSkipped(ctx.stackClient, migrationId, entry.path, 'already exists', entry.size)
          continue
        }
        ctx.errors += 1
        const message = getErrorMessage(error)
        ctx.logger.error({
          event: 'migration.file_failed',
          nc_path: entry.path,
          size: entry.size,
          error: message,
          total_errors: ctx.errors,
          elapsed_ms: Date.now() - ctx.startedAt,
        }, 'File transfer failed')
        await addError(ctx.stackClient, migrationId, entry.path, message)
      }
    }
  }
}

/**
 * Runs the full migration: sets status to running, creates target directory,
 * lazily traverses the Nextcloud tree transferring files, and updates the
 * tracking document throughout. On failure, marks the migration as failed.
 * @param command - Migration command from RabbitMQ
 * @param stackClient - Authenticated Stack API client
 * @param logger - Pino logger instance
 */
export async function runMigration(
  command: MigrationCommand,
  stackClient: StackClient,
  logger: Logger
): Promise<void> {
  const migrationLogger = logger.child({
    migration_id: command.migrationId,
    instance: command.workplaceFqdn,
    account_id: command.accountId,
    source_path: command.sourcePath,
  })
  const ctx: MigrationContext = {
    command,
    stackClient,
    logger: migrationLogger,
    discovered: { bytesTotal: 0, filesTotal: 0 },
    transferred: { bytes: 0, files: 0 },
    errors: 0,
    skipped: 0,
    startedAt: Date.now(),
  }

  try {
    migrationLogger.info({ event: 'migration.started' }, 'Migration started')

    await setRunning(stackClient, command.migrationId, 0)
    const targetDirId = await stackClient.createDir(COZY_ROOT_DIR_ID, TARGET_DIR_NAME)
    await traverseDir(command.accountId, command.sourcePath || '/', targetDirId, ctx)
    await updateBytesTotal(stackClient, command.migrationId, ctx.discovered.bytesTotal, ctx.discovered.filesTotal)
    await setCompleted(stackClient, command.migrationId)

    migrationLogger.info({
      event: 'migration.completed',
      duration_ms: Date.now() - ctx.startedAt,
      discovered_bytes: ctx.discovered.bytesTotal,
      discovered_files: ctx.discovered.filesTotal,
      transferred_bytes: ctx.transferred.bytes,
      transferred_files: ctx.transferred.files,
      total_errors: ctx.errors,
      total_skipped: ctx.skipped,
    }, 'Migration completed')
  } catch (error) {
    const message = getErrorMessage(error)
    migrationLogger.error({
      event: 'migration.failed',
      duration_ms: Date.now() - ctx.startedAt,
      discovered_bytes: ctx.discovered.bytesTotal,
      discovered_files: ctx.discovered.filesTotal,
      transferred_bytes: ctx.transferred.bytes,
      transferred_files: ctx.transferred.files,
      total_errors: ctx.errors,
      total_skipped: ctx.skipped,
      error: message,
    }, 'Migration failed')
    try {
      await setFailed(stackClient, command.migrationId, message)
    } catch (trackingError) {
      migrationLogger.error({
        event: 'migration.tracking_update_failed',
        error: getErrorMessage(trackingError),
      }, 'Failed to update tracking doc to failed status')
    }
  }
}
