import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createStackClient } from '../src/stack-client.js'
import type { ClouderyClient } from '../src/cloudery-client.js'
import type { TrackingDoc } from '../src/types.js'

describe('StackClient', () => {
  const FQDN = 'alice.cozy.example'
  const TOKEN = 'initial-token'
  let mockCloudery: ClouderyClient
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    mockCloudery = { getToken: vi.fn().mockResolvedValue('refreshed-token') }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('listNextcloudDir', () => {
    it('calls the correct URL and returns entries', async () => {
      const entries = [
        { type: 'directory', name: 'Photos', path: '/Photos', size: 0, mime: '' },
        { type: 'file', name: 'doc.pdf', path: '/doc.pdf', size: 1024, mime: 'application/pdf' },
      ]
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(entries), { status: 200 })
      )

      const client = createStackClient(FQDN, TOKEN, mockCloudery)
      const result = await client.listNextcloudDir('acc-123', '/')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://alice.cozy.example/remote/nextcloud/acc-123/',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer initial-token',
          }),
        })
      )
      expect(result).toEqual(entries)
    })
  })

  describe('transferFile', () => {
    it('calls downstream route with correct params', async () => {
      const cozyFile = { _id: 'file-1', _rev: '1-abc', type: 'file', name: 'doc.pdf', dir_id: 'dir-1', size: 1024 }
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(cozyFile), { status: 201 })
      )

      const client = createStackClient(FQDN, TOKEN, mockCloudery)
      const result = await client.transferFile('acc-123', '/doc.pdf', 'dir-1')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://alice.cozy.example/remote/nextcloud/acc-123/downstream/doc.pdf?To=dir-1&Copy=true',
        expect.objectContaining({ method: 'POST' })
      )
      expect(result).toEqual(cozyFile)
    })
  })

  describe('createDir', () => {
    it('creates a directory and returns its ID', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { id: 'new-dir-id' } }), { status: 201 })
      )

      const client = createStackClient(FQDN, TOKEN, mockCloudery)
      const dirId = await client.createDir('parent-id', 'Photos')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://alice.cozy.example/files/parent-id?Name=Photos&Type=directory',
        expect.objectContaining({ method: 'POST' })
      )
      expect(dirId).toBe('new-dir-id')
    })

    it('returns existing dir ID on 409 conflict', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ detail: 'conflict', source: { id: 'existing-dir-id' } }] }), { status: 409 })
      )

      const client = createStackClient(FQDN, TOKEN, mockCloudery)
      const dirId = await client.createDir('parent-id', 'Photos')

      expect(dirId).toBe('existing-dir-id')
    })
  })

  describe('getDiskUsage', () => {
    it('returns used and quota', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { attributes: { used: '5000', quota: '10000' } } }), { status: 200 })
      )

      const client = createStackClient(FQDN, TOKEN, mockCloudery)
      const usage = await client.getDiskUsage()

      expect(usage).toEqual({ used: 5000, quota: 10000 })
    })
  })

  describe('getTrackingDoc', () => {
    it('fetches the tracking document', async () => {
      const doc: TrackingDoc = {
        _id: 'mig-1', _rev: '1-abc', status: 'pending',
        bytes_total: 0, bytes_imported: 0, files_imported: 0,
        errors: [], skipped: [],
      }
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(doc), { status: 200 })
      )

      const client = createStackClient(FQDN, TOKEN, mockCloudery)
      const result = await client.getTrackingDoc('mig-1')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://alice.cozy.example/data/io.cozy.nextcloud.migrations/mig-1',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer initial-token',
          }),
        })
      )
      expect(result).toEqual(doc)
    })
  })

  describe('updateTrackingDoc', () => {
    it('PUTs the doc and returns the updated version', async () => {
      const doc: TrackingDoc = {
        _id: 'mig-1', _rev: '1-abc', status: 'running',
        bytes_total: 5000, bytes_imported: 0, files_imported: 0,
        errors: [], skipped: [],
      }
      const updated = { ...doc, _rev: '2-def' }
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(updated), { status: 200 })
      )

      const client = createStackClient(FQDN, TOKEN, mockCloudery)
      const result = await client.updateTrackingDoc(doc)

      expect(mockFetch).toHaveBeenCalledWith(
        'https://alice.cozy.example/data/io.cozy.nextcloud.migrations/mig-1',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(doc),
        })
      )
      expect(result).toEqual(updated)
    })
  })

  describe('token refresh on 401', () => {
    it('refreshes the token and retries the request once', async () => {
      const entries = [{ type: 'file', name: 'a.txt', path: '/a.txt', size: 10, mime: 'text/plain' }]
      mockFetch
        .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(entries), { status: 200 }))

      const client = createStackClient(FQDN, TOKEN, mockCloudery)
      const result = await client.listNextcloudDir('acc-123', '/')

      expect(mockCloudery.getToken).toHaveBeenCalledWith(FQDN)
      expect(mockFetch).toHaveBeenCalledTimes(2)
      // Second call uses the refreshed token
      expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe('Bearer refreshed-token')
      expect(result).toEqual(entries)
    })

    it('throws after refresh + retry still fails', async () => {
      mockFetch
        .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
        .mockResolvedValueOnce(new Response('still unauthorized', { status: 401 }))

      const client = createStackClient(FQDN, TOKEN, mockCloudery)

      await expect(client.listNextcloudDir('acc-123', '/')).rejects.toThrow('401')
    })
  })
})
