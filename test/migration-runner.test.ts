import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMigrationRunner } from '../src/runtime/migration-runner.js'
import type { Logger } from 'pino'

const logger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as Logger

describe('MigrationRunner', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects maxConcurrent < 1 at construction', () => {
    expect(() => createMigrationRunner(0, logger)).toThrow(/maxConcurrent/)
  })

  it('launches each submitted task without awaiting completion', async () => {
    const runner = createMigrationRunner(2, logger)
    let resolveA: () => void = () => {}
    let started = false
    await runner.run('mig-a', () => new Promise<void>((resolve) => {
      started = true
      resolveA = resolve
    }))

    // `run` returns after the task starts, not after it finishes.
    expect(started).toBe(true)
    expect(runner.active).toBe(1)
    resolveA()
  })

  it('caps concurrent tasks at maxConcurrent', async () => {
    const runner = createMigrationRunner(2, logger)
    const resolvers: Array<() => void> = []
    const makeTask = () => () => new Promise<void>((resolve) => {
      resolvers.push(resolve)
    })

    await runner.run('mig-1', makeTask())
    await runner.run('mig-2', makeTask())
    expect(runner.active).toBe(2)

    // Third submission should not start until a slot frees.
    let thirdStarted = false
    const thirdRun = runner.run('mig-3', () => {
      thirdStarted = true
      return Promise.resolve()
    })
    await Promise.resolve()
    expect(thirdStarted).toBe(false)

    // Free one slot; third task starts.
    resolvers[0]()
    await thirdRun
    expect(thirdStarted).toBe(true)

    resolvers[1]()
  })

  it('releases the slot when a task rejects', async () => {
    const runner = createMigrationRunner(1, logger)
    await runner.run('mig-fail', () => Promise.reject(new Error('boom')))
    // Give the microtask queue a tick to settle the finally handler.
    await Promise.resolve()
    await Promise.resolve()
    expect(runner.active).toBe(0)
  })

  it('drain resolves immediately when no tasks are in flight', async () => {
    const runner = createMigrationRunner(2, logger)
    expect(await runner.drain(1000)).toBe(true)
  })

  it('drain waits for every in-flight task to settle', async () => {
    const runner = createMigrationRunner(2, logger)
    let resolveA: () => void = () => {}
    let resolveB: () => void = () => {}
    await runner.run('mig-a', () => new Promise<void>((resolve) => { resolveA = resolve }))
    await runner.run('mig-b', () => new Promise<void>((resolve) => { resolveB = resolve }))

    const drained = runner.drain(5_000)
    resolveA()
    resolveB()
    expect(await drained).toBe(true)
    expect(runner.active).toBe(0)
  })

  it('drain returns false on timeout and leaves tasks running', async () => {
    vi.useFakeTimers()
    const runner = createMigrationRunner(1, logger)
    await runner.run('mig-stuck', () => new Promise<void>(() => { /* never resolves */ }))

    const drained = runner.drain(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await drained).toBe(false)
    expect(runner.active).toBe(1)
  })

  it('cancel returns false when the migration is not in flight', () => {
    const runner = createMigrationRunner(1, logger)
    expect(runner.cancel('unknown')).toBe(false)
  })

  it('cancel aborts the registered signal and returns true', async () => {
    const runner = createMigrationRunner(1, logger)
    let capturedSignal: AbortSignal | undefined
    await runner.run('mig-cancel', (signal) => {
      capturedSignal = signal
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    })

    expect(runner.cancel('mig-cancel')).toBe(true)
    expect(capturedSignal?.aborted).toBe(true)
    // After the task settles the registry is cleaned up, so a second
    // cancel for the same id no longer finds a controller.
    await Promise.resolve()
    await Promise.resolve()
    expect(runner.cancel('mig-cancel')).toBe(false)
  })

  it('removes the controller from the registry on task settle', async () => {
    const runner = createMigrationRunner(1, logger)
    await runner.run('mig-settle', () => Promise.resolve())
    await Promise.resolve()
    await Promise.resolve()
    expect(runner.cancel('mig-settle')).toBe(false)
  })

  it('releases slot and controller when the factory throws synchronously', async () => {
    // Without the sync-throw guard, a factory that throws before
    // returning a promise would leak both the concurrency slot and
    // the registered AbortController.
    const runner = createMigrationRunner(1, logger)

    await expect(
      runner.run('mig-sync-throw', () => { throw new Error('bad factory') }),
    ).rejects.toThrow('bad factory')

    expect(runner.active).toBe(0)
    expect(runner.cancel('mig-sync-throw')).toBe(false)
    // Slot was released, so a follow-up submission runs immediately.
    await runner.run('mig-next', () => Promise.resolve())
    expect(runner.active).toBe(1)
  })
})
