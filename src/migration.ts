import type { Logger } from 'pino'
import type { StackClient } from './stack-client.js'
import type { MigrationCommand, NextcloudEntry, TrackingDoc } from './types.js'
import {
  setRunning,
  setCompleted,
  setFailed,
  incrementProgress,
  addError,
} from './tracking.js'

const COZY_ROOT_DIR_ID = 'io.cozy.files.root-dir'
const TARGET_DIR_NAME = 'Nextcloud'

interface MigrationContext {
  command: MigrationCommand
  stackClient: StackClient
  migrationId: string
  logger: Logger
}

function isConflictError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('(409)')
}

/** Calculate total bytes by recursively listing all files. */
async function calculateTotalBytes(
  stackClient: StackClient,
  accountId: string,
  path: string
): Promise<{ totalBytes: number; entries: NextcloudEntry[] }> {
  const entries = await stackClient.listNextcloudDir(accountId, path)
  let totalBytes = 0

  for (const entry of entries) {
    if (entry.type === 'file') {
      totalBytes += entry.size
    } else if (entry.type === 'directory') {
      const sub = await calculateTotalBytes(stackClient, accountId, entry.path)
      totalBytes += sub.totalBytes
    }
  }

  return { totalBytes, entries }
}

async function traverseDir(
  accountId: string,
  ncPath: string,
  cozyDirId: string,
  entries: NextcloudEntry[],
  ctx: MigrationContext
): Promise<void> {
  for (const entry of entries) {
    if (entry.type === 'directory') {
      const subDirId = await ctx.stackClient.createDir(cozyDirId, entry.name)
      const subEntries = await ctx.stackClient.listNextcloudDir(accountId, entry.path)
      await traverseDir(accountId, entry.path, subDirId, subEntries, ctx)
    } else {
      try {
        const file = await ctx.stackClient.transferFile(accountId, entry.path, cozyDirId)
        await incrementProgress(ctx.stackClient, ctx.migrationId, file.size)
      } catch (error) {
        if (isConflictError(error)) {
          ctx.logger.info({ path: entry.path }, 'File already exists, skipping')
          continue
        }
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.error({ path: entry.path, error: message }, 'File transfer failed')
        await addError(ctx.stackClient, ctx.migrationId, entry.path, message)
      }
    }
  }
}

export async function runMigration(
  command: MigrationCommand,
  stackClient: StackClient,
  logger: Logger
): Promise<void> {
  const migrationLogger = logger.child({
    migration_id: command.migrationId,
    instance: command.workplaceFqdn,
  })
  const ctx: MigrationContext = {
    command,
    stackClient,
    migrationId: command.migrationId,
    logger: migrationLogger,
  }

  try {
    migrationLogger.info('Starting migration')

    // Calculate total size from source listing
    const sourcePath = command.sourcePath || '/'
    const { totalBytes, entries } = await calculateTotalBytes(
      stackClient,
      command.accountId,
      sourcePath
    )

    // Set running status with total bytes
    await setRunning(stackClient, command.migrationId, totalBytes)

    // Create target directory in Cozy
    const targetDirId = await stackClient.createDir(COZY_ROOT_DIR_ID, TARGET_DIR_NAME)

    // Traverse and transfer
    await traverseDir(command.accountId, sourcePath, targetDirId, entries, ctx)

    // Mark completed
    await setCompleted(stackClient, command.migrationId)
    migrationLogger.info('Migration completed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    migrationLogger.error({ error: message }, 'Migration failed')
    try {
      await setFailed(stackClient, command.migrationId, message)
    } catch (trackingError) {
      migrationLogger.error({ error: trackingError }, 'Failed to update tracking doc to failed status')
    }
  }
}
