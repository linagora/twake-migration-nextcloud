/**
 * @param error - Caught error value
 * @returns The error message string, or String(error) for non-Error values
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param error - Caught error value
 * @returns true if the error represents an HTTP 404 (Stack or CouchDB)
 */
export function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if ((error as { status?: number }).status === 404) return true
  return error.message.includes('(404)')
}

/** Signals a cooperative cancellation request from the user. */
export class CancellationRequestedError extends Error {
  constructor() {
    super('migration canceled by user')
    this.name = 'CancellationRequestedError'
  }
}
