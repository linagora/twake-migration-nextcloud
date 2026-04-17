import type { Logger } from 'pino'
import type { ClouderyClient } from '../clients/cloudery-client.js'
import { createStackClient } from '../clients/stack-client.js'
import { getErrorMessage, isNotFoundError } from '../domain/errors.js'
import { setCancelRequested } from '../domain/tracking.js'
import type { CancelCommand } from '../domain/types.js'
import { cancelsReceived } from './metrics.js'
import type { Config } from './config.js'
import type { MigrationRunner } from './migration-runner.js'

/**
 * Handles a single cancel message: fetches a token, records
 * `cancel_requested: true` on the tracking doc (durable signal for
 * cross-pod and pre-start cases), and signals the local runner's
 * AbortController (fast same-pod signal).
 *
 * Returns normally when the outcome is terminal-by-design — tracking
 * doc missing, migration already in a terminal state — so the library
 * ACKs instead of spinning its retry budget. Transient failures (token
 * fetch 5xx, Stack 5xx, CouchDB conflict exhaustion) throw and rely
 * on the library's 3× retry budget plus DLQ.
 *
 * @param command - Validated cancel command
 * @param clouderyClient - Client for obtaining Stack tokens
 * @param logger - Pino logger instance
 * @param config - Service configuration
 * @param runner - Local migration runner (signalled if it owns the id)
 */
export async function handleCancelMessage(
  command: CancelCommand,
  clouderyClient: ClouderyClient,
  logger: Logger,
  config: Config,
  runner: MigrationRunner,
): Promise<void> {
  const cancelLogger = logger.child({
    migration_id: command.migrationId,
    instance: command.workplaceFqdn,
  })

  cancelLogger.info({ event: 'cancel.received' }, 'Cancel message received')

  const token = await clouderyClient.getToken(command.workplaceFqdn)
  const stackClient = createStackClient(
    command.workplaceFqdn,
    config.stackUrlScheme,
    token,
    clouderyClient,
    cancelLogger,
  )

  const outcome = await setCancelRequested(stackClient, command.migrationId)
    .catch((error) => {
      if (isNotFoundError(error)) {
        cancelLogger.warn({
          event: 'cancel.tracking_doc_not_found',
          error: getErrorMessage(error),
        }, 'Tracking document not found, ignoring cancel')
        return 'not_found' as const
      }
      throw error
    })

  if (outcome === 'not_found') {
    cancelsReceived.inc({ outcome })
    return
  }
  if (outcome === 'ignored_terminal') {
    cancelLogger.info({ event: 'cancel.ignored_terminal' }, 'Migration already terminal, cancel ignored')
    cancelsReceived.inc({ outcome })
    return
  }

  if (runner.cancel(command.migrationId)) {
    cancelLogger.info({ event: 'cancel.signalled_runner' }, 'Signalled local runner')
  }
  cancelsReceived.inc({ outcome })
}
