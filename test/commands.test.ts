import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseCancelCommand, parseMigrationCommand } from '../src/domain/commands.js'

describe('parseMigrationCommand', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the validated command for a well-formed message', () => {
    const cmd = parseMigrationCommand({
      migrationId: 'mig-1',
      workplaceFqdn: 'alice.cozy.example',
      accountId: 'acc-123',
      sourcePath: '/Photos',
      timestamp: 1_700_000_000,
    })

    expect(cmd).toEqual({
      migrationId: 'mig-1',
      workplaceFqdn: 'alice.cozy.example',
      accountId: 'acc-123',
      sourcePath: '/Photos',
      timestamp: 1_700_000_000,
    })
  })

  it('throws when migrationId is missing, empty, or not a string', () => {
    const base = { workplaceFqdn: 'a.example', accountId: 'acc', timestamp: 0 }
    expect(() => parseMigrationCommand({ ...base })).toThrow(/migrationId/)
    expect(() => parseMigrationCommand({ ...base, migrationId: '' })).toThrow(/migrationId/)
    expect(() => parseMigrationCommand({ ...base, migrationId: 42 })).toThrow(/migrationId/)
  })

  it('throws when workplaceFqdn is missing, empty, or not a string', () => {
    const base = { migrationId: 'mig-1', accountId: 'acc', timestamp: 0 }
    expect(() => parseMigrationCommand({ ...base })).toThrow(/workplaceFqdn/)
    expect(() => parseMigrationCommand({ ...base, workplaceFqdn: '' })).toThrow(/workplaceFqdn/)
    expect(() => parseMigrationCommand({ ...base, workplaceFqdn: null })).toThrow(/workplaceFqdn/)
  })

  it('throws when accountId is missing, empty, or not a string', () => {
    const base = { migrationId: 'mig-1', workplaceFqdn: 'a.example', timestamp: 0 }
    expect(() => parseMigrationCommand({ ...base })).toThrow(/accountId/)
    expect(() => parseMigrationCommand({ ...base, accountId: '' })).toThrow(/accountId/)
    expect(() => parseMigrationCommand({ ...base, accountId: {} })).toThrow(/accountId/)
  })

  it('defaults sourcePath to `/` when missing or the wrong type', () => {
    const base = { migrationId: 'mig-1', workplaceFqdn: 'a.example', accountId: 'acc', timestamp: 0 }
    expect(parseMigrationCommand({ ...base }).sourcePath).toBe('/')
    expect(parseMigrationCommand({ ...base, sourcePath: 42 }).sourcePath).toBe('/')
  })

  it('defaults timestamp to the current time when missing or the wrong type', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-16T12:00:00Z'))
    const expected = new Date('2026-04-16T12:00:00Z').getTime()
    const base = { migrationId: 'mig-1', workplaceFqdn: 'a.example', accountId: 'acc' }

    expect(parseMigrationCommand({ ...base }).timestamp).toBe(expected)
    expect(parseMigrationCommand({ ...base, timestamp: 'nope' }).timestamp).toBe(expected)
  })
})

describe('parseCancelCommand', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the validated command for a well-formed message', () => {
    const cmd = parseCancelCommand({
      migrationId: 'mig-1',
      workplaceFqdn: 'alice.cozy.example',
      timestamp: 1_700_000_000,
    })

    expect(cmd).toEqual({
      migrationId: 'mig-1',
      workplaceFqdn: 'alice.cozy.example',
      timestamp: 1_700_000_000,
    })
  })

  it('throws when migrationId is missing, empty, or not a string', () => {
    const base = { workplaceFqdn: 'a.example', timestamp: 0 }
    expect(() => parseCancelCommand({ ...base })).toThrow(/migrationId/)
    expect(() => parseCancelCommand({ ...base, migrationId: '' })).toThrow(/migrationId/)
    expect(() => parseCancelCommand({ ...base, migrationId: 42 })).toThrow(/migrationId/)
  })

  it('throws when workplaceFqdn is missing, empty, or not a string', () => {
    const base = { migrationId: 'mig-1', timestamp: 0 }
    expect(() => parseCancelCommand({ ...base })).toThrow(/workplaceFqdn/)
    expect(() => parseCancelCommand({ ...base, workplaceFqdn: '' })).toThrow(/workplaceFqdn/)
    expect(() => parseCancelCommand({ ...base, workplaceFqdn: null })).toThrow(/workplaceFqdn/)
  })

  it('defaults timestamp to the current time when missing or the wrong type', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-16T12:00:00Z'))
    const expected = new Date('2026-04-16T12:00:00Z').getTime()
    const base = { migrationId: 'mig-1', workplaceFqdn: 'a.example' }

    expect(parseCancelCommand({ ...base }).timestamp).toBe(expected)
    expect(parseCancelCommand({ ...base, timestamp: 'nope' }).timestamp).toBe(expected)
  })
})
