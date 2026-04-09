# Nextcloud Migration Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone RabbitMQ consumer that migrates Nextcloud files into Cozy instances via the Stack's `/remote/nextcloud/` proxy routes.

**Architecture:** Pure message consumer — no database, no web server. Consumes `nextcloud.migration.requested` messages, validates, ACKs early, then orchestrates file transfers in the background. Tracking document in CouchDB is the sole source of truth after ACK. Multiple concurrent migrations bounded by `prefetch: 10`.

**Tech Stack:** TypeScript (Node 20), `@linagora/rabbitmq-client`, `pino`, native `fetch`, `vitest`

---

## File Structure

```
src/
  index.ts              # Entry point: init client, subscribe, graceful shutdown
  consumer.ts           # Message handler: validate, early ACK, fire-and-forget migration
  migration.ts          # Core orchestration: traverse Nextcloud tree, transfer files
  stack-client.ts       # HTTP client for Cozy Stack API (files, remote, data, settings)
  cloudery-client.ts    # HTTP client for Cloudery token endpoint
  tracking.ts           # Read/update tracking doc with 409 retry + helper functions
  config.ts             # Environment variable parsing with defaults
  types.ts              # Message schema, tracking doc, Nextcloud entries, config shape
test/
  config.test.ts        # Config parsing tests
  cloudery-client.test.ts
  stack-client.test.ts
  tracking.test.ts
  consumer.test.ts
  migration.test.ts
Dockerfile
package.json
tsconfig.json
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "twake-nextcloud-migration",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsc --watch",
    "test": "vitest --run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@linagora/rabbitmq-client": "^0.1.2",
    "pino": "^9.6.0"
  },
  "devDependencies": {
    "@types/node": "^20.17.0",
    "typescript": "^5.7.0",
    "vitest": "^3.2.0"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` generated, no errors.

- [ ] **Step 4: Verify TypeScript compiles**

Create a minimal `src/index.ts`:

```typescript
console.log('twake-nextcloud-migration starting...')
```

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Verify vitest runs**

Create a minimal `test/smoke.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'

describe('smoke', () => {
  it('works', () => {
    expect(1 + 1).toBe(2)
  })
})
```

Run: `npm test`
Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json src/index.ts test/smoke.test.ts
git commit -m "chore: scaffold project with TypeScript, vitest, and rabbitmq-client"
```

---

### Task 2: Types and config

**Files:**
- Create: `src/types.ts`
- Create: `src/config.ts`
- Create: `test/config.test.ts`

- [ ] **Step 1: Write `src/types.ts`**

```typescript
/** Message published by the Stack when a user requests a migration. */
export interface MigrationCommand {
  migrationId: string
  workplaceFqdn: string
  accountId: string
  sourcePath: string
  timestamp: number
}

/** Tracking document stored in CouchDB (io.cozy.nextcloud.migrations). */
export interface TrackingDoc {
  _id: string
  _rev?: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  started_at?: string
  finished_at?: string
  bytes_total: number
  bytes_imported: number
  files_imported: number
  errors: TrackingError[]
  skipped: TrackingSkipped[]
}

export interface TrackingError {
  path: string
  message: string
}

export interface TrackingSkipped {
  path: string
  reason: string
  size: number
}

/** Entry returned by the Stack's Nextcloud directory listing. */
export interface NextcloudEntry {
  type: 'file' | 'directory'
  name: string
  path: string
  size: number
  mime: string
}

/** File document returned by the Stack after a transfer or dir creation. */
export interface CozyFile {
  _id: string
  _rev: string
  type: string
  name: string
  dir_id: string
  size: number
}

/** Disk usage from GET /settings/disk-usage. */
export interface DiskUsage {
  used: number
  quota: number
}

/** Parsed and validated environment config. */
export interface Config {
  rabbitmqUrl: string
  clouderyUrl: string
  clouderyToken: string
  logLevel: string
}
```

- [ ] **Step 2: Write the failing test for `config.ts`**

Create `test/config.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

describe('loadConfig', () => {
  const VALID_ENV = {
    RABBITMQ_URL: 'amqp://localhost',
    CLOUDERY_URL: 'https://manager.cozycloud.cc',
    CLOUDERY_TOKEN: 'secret-token',
  }

  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('parses valid environment variables', async () => {
    Object.assign(process.env, VALID_ENV)
    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig()
    expect(config).toEqual({
      rabbitmqUrl: 'amqp://localhost',
      clouderyUrl: 'https://manager.cozycloud.cc',
      clouderyToken: 'secret-token',
      logLevel: 'info',
    })
  })

  it('uses LOG_LEVEL when provided', async () => {
    Object.assign(process.env, { ...VALID_ENV, LOG_LEVEL: 'debug' })
    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig()
    expect(config.logLevel).toBe('debug')
  })

  it('throws when RABBITMQ_URL is missing', async () => {
    Object.assign(process.env, { ...VALID_ENV, RABBITMQ_URL: undefined })
    delete process.env.RABBITMQ_URL
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow('RABBITMQ_URL')
  })

  it('throws when CLOUDERY_URL is missing', async () => {
    Object.assign(process.env, { ...VALID_ENV, CLOUDERY_URL: undefined })
    delete process.env.CLOUDERY_URL
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow('CLOUDERY_URL')
  })

  it('throws when CLOUDERY_TOKEN is missing', async () => {
    Object.assign(process.env, { ...VALID_ENV, CLOUDERY_TOKEN: undefined })
    delete process.env.CLOUDERY_TOKEN
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow('CLOUDERY_TOKEN')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../src/config.js`

- [ ] **Step 4: Write `src/config.ts`**

```typescript
import type { Config } from './types.js'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

export function loadConfig(): Config {
  return {
    rabbitmqUrl: requireEnv('RABBITMQ_URL'),
    clouderyUrl: requireEnv('CLOUDERY_URL'),
    clouderyToken: requireEnv('CLOUDERY_TOKEN'),
    logLevel: process.env.LOG_LEVEL ?? 'info',
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all config tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts test/config.test.ts
git commit -m "feat: add types and config module with env validation"
```

---

### Task 3: Cloudery client

**Files:**
- Create: `src/cloudery-client.ts`
- Create: `test/cloudery-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/cloudery-client.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createClouderyClient } from '../src/cloudery-client.js'

describe('ClouderyClient', () => {
  const CLOUDERY_URL = 'https://manager.cozycloud.cc'
  const CLOUDERY_TOKEN = 'api-secret'

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches a token for a given instance', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'instance-jwt' }), { status: 200 })
    )

    const client = createClouderyClient(CLOUDERY_URL, CLOUDERY_TOKEN)
    const token = await client.getToken('alice.cozy.example')

    expect(mockFetch).toHaveBeenCalledWith(
      'https://manager.cozycloud.cc/api/public/instances/alice.cozy.example/nextcloud_migration_token',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer api-secret',
        },
      }
    )
    expect(token).toBe('instance-jwt')
  })

  it('throws on non-OK response with status and body', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce(
      new Response('instance not found', { status: 404 })
    )

    const client = createClouderyClient(CLOUDERY_URL, CLOUDERY_TOKEN)

    await expect(client.getToken('unknown.cozy.example')).rejects.toThrow(
      'Cloudery token request failed (404): instance not found'
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../src/cloudery-client.js`

- [ ] **Step 3: Write `src/cloudery-client.ts`**

```typescript
export interface ClouderyClient {
  getToken(workplaceFqdn: string): Promise<string>
}

export function createClouderyClient(
  clouderyUrl: string,
  clouderyToken: string
): ClouderyClient {
  return {
    async getToken(workplaceFqdn: string): Promise<string> {
      const url = `${clouderyUrl}/api/public/instances/${workplaceFqdn}/nextcloud_migration_token`
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clouderyToken}`,
        },
      })

      if (!response.ok) {
        const body = await response.text()
        throw new Error(
          `Cloudery token request failed (${response.status}): ${body}`
        )
      }

      const data = (await response.json()) as { token: string }
      return data.token
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all cloudery-client tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cloudery-client.ts test/cloudery-client.test.ts
git commit -m "feat: add Cloudery client for migration token acquisition"
```

---

### Task 4: Stack client

**Files:**
- Create: `src/stack-client.ts`
- Create: `test/stack-client.test.ts`

This is the largest client. It wraps all Cozy Stack HTTP calls and handles 401 token refresh.

- [ ] **Step 1: Write the failing tests**

Create `test/stack-client.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../src/stack-client.js`

- [ ] **Step 3: Write `src/stack-client.ts`**

```typescript
import type { ClouderyClient } from './cloudery-client.js'
import type {
  NextcloudEntry,
  CozyFile,
  DiskUsage,
  TrackingDoc,
} from './types.js'

export interface StackClient {
  listNextcloudDir(accountId: string, path: string): Promise<NextcloudEntry[]>
  transferFile(accountId: string, ncPath: string, cozyDirId: string): Promise<CozyFile>
  createDir(parentDirId: string, name: string): Promise<string>
  getDiskUsage(): Promise<DiskUsage>
  getTrackingDoc(id: string): Promise<TrackingDoc>
  updateTrackingDoc(doc: TrackingDoc): Promise<TrackingDoc>
}

export function createStackClient(
  workplaceFqdn: string,
  initialToken: string,
  clouderyClient: ClouderyClient
): StackClient {
  const baseUrl = `https://${workplaceFqdn}`
  let token = initialToken

  async function request(path: string, options: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...(options.headers as Record<string, string> ?? {}),
    }

    const response = await fetch(`${baseUrl}${path}`, { ...options, headers })

    if (response.status === 401) {
      token = await clouderyClient.getToken(workplaceFqdn)
      const retryHeaders = { ...headers, Authorization: `Bearer ${token}` }
      const retry = await fetch(`${baseUrl}${path}`, { ...options, headers: retryHeaders })
      if (!retry.ok) {
        const body = await retry.text()
        throw new Error(`Stack request failed after token refresh (${retry.status}): ${body}`)
      }
      return retry
    }

    return response
  }

  function assertOk(response: Response, body: string): void {
    if (!response.ok) {
      throw new Error(`Stack request failed (${response.status}): ${body}`)
    }
  }

  return {
    async listNextcloudDir(accountId: string, path: string): Promise<NextcloudEntry[]> {
      const normalizedPath = path.startsWith('/') ? path.slice(1) : path
      const response = await request(`/remote/nextcloud/${accountId}/${normalizedPath}`)
      const body = await response.text()
      assertOk(response, body)
      return JSON.parse(body) as NextcloudEntry[]
    },

    async transferFile(accountId: string, ncPath: string, cozyDirId: string): Promise<CozyFile> {
      const normalizedPath = ncPath.startsWith('/') ? ncPath.slice(1) : ncPath
      const response = await request(
        `/remote/nextcloud/${accountId}/downstream/${normalizedPath}?To=${cozyDirId}&Copy=true`,
        { method: 'POST' }
      )
      const body = await response.text()
      assertOk(response, body)
      return JSON.parse(body) as CozyFile
    },

    async createDir(parentDirId: string, name: string): Promise<string> {
      const response = await request(
        `/files/${parentDirId}?Name=${name}&Type=directory`,
        { method: 'POST' }
      )
      const body = await response.text()
      if (response.status === 409) {
        const parsed = JSON.parse(body) as { errors: Array<{ source: { id: string } }> }
        return parsed.errors[0].source.id
      }
      assertOk(response, body)
      const parsed = JSON.parse(body) as { data: { id: string } }
      return parsed.data.id
    },

    async getDiskUsage(): Promise<DiskUsage> {
      const response = await request('/settings/disk-usage')
      const body = await response.text()
      assertOk(response, body)
      const parsed = JSON.parse(body) as { data: { attributes: { used: string; quota: string } } }
      return {
        used: parseInt(parsed.data.attributes.used, 10),
        quota: parseInt(parsed.data.attributes.quota, 10),
      }
    },

    async getTrackingDoc(id: string): Promise<TrackingDoc> {
      const response = await request(`/data/io.cozy.nextcloud.migrations/${id}`)
      const body = await response.text()
      assertOk(response, body)
      return JSON.parse(body) as TrackingDoc
    },

    async updateTrackingDoc(doc: TrackingDoc): Promise<TrackingDoc> {
      const response = await request(
        `/data/io.cozy.nextcloud.migrations/${doc._id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(doc),
        }
      )
      const body = await response.text()
      assertOk(response, body)
      return JSON.parse(body) as TrackingDoc
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all stack-client tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/stack-client.ts test/stack-client.test.ts
git commit -m "feat: add Stack client with token refresh on 401"
```

---

### Task 5: Tracking document helpers

**Files:**
- Create: `src/tracking.ts`
- Create: `test/tracking.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/tracking.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  updateTracking,
  setRunning,
  setCompleted,
  setFailed,
  incrementProgress,
  addError,
  addSkipped,
} from '../src/tracking.js'
import type { StackClient } from '../src/stack-client.js'
import type { TrackingDoc } from '../src/types.js'

function makeDoc(overrides: Partial<TrackingDoc> = {}): TrackingDoc {
  return {
    _id: 'mig-1',
    _rev: '1-abc',
    status: 'pending',
    bytes_total: 0,
    bytes_imported: 0,
    files_imported: 0,
    errors: [],
    skipped: [],
    ...overrides,
  }
}

describe('updateTracking', () => {
  let mockStack: StackClient

  beforeEach(() => {
    mockStack = {
      getTrackingDoc: vi.fn(),
      updateTrackingDoc: vi.fn(),
      listNextcloudDir: vi.fn(),
      transferFile: vi.fn(),
      createDir: vi.fn(),
      getDiskUsage: vi.fn(),
    } as unknown as StackClient
  })

  it('reads, applies updater, and writes the doc', async () => {
    const doc = makeDoc()
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValueOnce(doc)
    vi.mocked(mockStack.updateTrackingDoc).mockResolvedValueOnce({ ...doc, _rev: '2-def', status: 'running' })

    await updateTracking(mockStack, 'mig-1', (d) => ({ ...d, status: 'running' }))

    expect(mockStack.getTrackingDoc).toHaveBeenCalledWith('mig-1')
    expect(mockStack.updateTrackingDoc).toHaveBeenCalledWith({ ...doc, status: 'running' })
  })

  it('retries on 409 conflict up to 5 times', async () => {
    const doc = makeDoc()
    const error409 = new Error('Stack request failed (409): conflict')
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValue(doc)
    vi.mocked(mockStack.updateTrackingDoc)
      .mockRejectedValueOnce(error409)
      .mockRejectedValueOnce(error409)
      .mockResolvedValueOnce({ ...doc, _rev: '2-def', status: 'running' })

    await updateTracking(mockStack, 'mig-1', (d) => ({ ...d, status: 'running' }))

    // 1 initial + 2 retries = 3 calls to getTrackingDoc (re-read on each retry)
    expect(mockStack.getTrackingDoc).toHaveBeenCalledTimes(3)
    expect(mockStack.updateTrackingDoc).toHaveBeenCalledTimes(3)
  })

  it('throws after 5 consecutive 409 conflicts', async () => {
    const doc = makeDoc()
    const error409 = new Error('Stack request failed (409): conflict')
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValue(doc)
    vi.mocked(mockStack.updateTrackingDoc).mockRejectedValue(error409)

    await expect(
      updateTracking(mockStack, 'mig-1', (d) => ({ ...d, status: 'running' }))
    ).rejects.toThrow('409')
  })

  it('throws non-409 errors immediately', async () => {
    const doc = makeDoc()
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValue(doc)
    vi.mocked(mockStack.updateTrackingDoc).mockRejectedValueOnce(
      new Error('Stack request failed (500): internal error')
    )

    await expect(
      updateTracking(mockStack, 'mig-1', (d) => ({ ...d, status: 'running' }))
    ).rejects.toThrow('500')
  })
})

describe('helper functions', () => {
  let mockStack: StackClient
  let capturedUpdater: ((doc: TrackingDoc) => TrackingDoc) | null

  beforeEach(() => {
    capturedUpdater = null
    mockStack = {
      getTrackingDoc: vi.fn().mockResolvedValue(makeDoc()),
      updateTrackingDoc: vi.fn().mockImplementation(async (doc: TrackingDoc) => doc),
      listNextcloudDir: vi.fn(),
      transferFile: vi.fn(),
      createDir: vi.fn(),
      getDiskUsage: vi.fn(),
    } as unknown as StackClient

    // Capture the updater function passed to updateTrackingDoc
    vi.mocked(mockStack.updateTrackingDoc).mockImplementation(async (doc: TrackingDoc) => {
      return doc
    })
  })

  it('setRunning sets status, started_at, and bytes_total', async () => {
    await setRunning(mockStack, 'mig-1', 5000)

    const calledDoc = vi.mocked(mockStack.updateTrackingDoc).mock.calls[0][0]
    expect(calledDoc.status).toBe('running')
    expect(calledDoc.started_at).toBeDefined()
    expect(calledDoc.bytes_total).toBe(5000)
  })

  it('setCompleted sets status and finished_at', async () => {
    await setCompleted(mockStack, 'mig-1')

    const calledDoc = vi.mocked(mockStack.updateTrackingDoc).mock.calls[0][0]
    expect(calledDoc.status).toBe('completed')
    expect(calledDoc.finished_at).toBeDefined()
  })

  it('setFailed sets status, finished_at, and appends error', async () => {
    await setFailed(mockStack, 'mig-1', 'something broke')

    const calledDoc = vi.mocked(mockStack.updateTrackingDoc).mock.calls[0][0]
    expect(calledDoc.status).toBe('failed')
    expect(calledDoc.finished_at).toBeDefined()
    expect(calledDoc.errors).toContainEqual({ path: '', message: 'something broke' })
  })

  it('incrementProgress adds to bytes_imported and files_imported', async () => {
    await incrementProgress(mockStack, 'mig-1', 1024)

    const calledDoc = vi.mocked(mockStack.updateTrackingDoc).mock.calls[0][0]
    expect(calledDoc.bytes_imported).toBe(1024)
    expect(calledDoc.files_imported).toBe(1)
  })

  it('addError appends to errors array', async () => {
    await addError(mockStack, 'mig-1', '/bad-file.txt', 'transfer failed')

    const calledDoc = vi.mocked(mockStack.updateTrackingDoc).mock.calls[0][0]
    expect(calledDoc.errors).toContainEqual({ path: '/bad-file.txt', message: 'transfer failed' })
  })

  it('addSkipped appends to skipped array', async () => {
    await addSkipped(mockStack, 'mig-1', '/huge.iso', 'exceeds quota', 999999)

    const calledDoc = vi.mocked(mockStack.updateTrackingDoc).mock.calls[0][0]
    expect(calledDoc.skipped).toContainEqual({ path: '/huge.iso', reason: 'exceeds quota', size: 999999 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../src/tracking.js`

- [ ] **Step 3: Write `src/tracking.ts`**

```typescript
import type { StackClient } from './stack-client.js'
import type { TrackingDoc } from './types.js'

const MAX_CONFLICT_RETRIES = 5

function isConflictError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('(409)')
}

export async function updateTracking(
  stackClient: StackClient,
  docId: string,
  updater: (doc: TrackingDoc) => TrackingDoc
): Promise<void> {
  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
    const doc = await stackClient.getTrackingDoc(docId)
    const updated = updater(doc)
    try {
      await stackClient.updateTrackingDoc(updated)
      return
    } catch (error) {
      if (!isConflictError(error) || attempt === MAX_CONFLICT_RETRIES - 1) {
        throw error
      }
    }
  }
}

export async function setRunning(
  stackClient: StackClient,
  docId: string,
  bytesTotal: number
): Promise<void> {
  await updateTracking(stackClient, docId, (doc) => ({
    ...doc,
    status: 'running',
    started_at: new Date().toISOString(),
    bytes_total: bytesTotal,
  }))
}

export async function setCompleted(
  stackClient: StackClient,
  docId: string
): Promise<void> {
  await updateTracking(stackClient, docId, (doc) => ({
    ...doc,
    status: 'completed',
    finished_at: new Date().toISOString(),
  }))
}

export async function setFailed(
  stackClient: StackClient,
  docId: string,
  errorMessage: string
): Promise<void> {
  await updateTracking(stackClient, docId, (doc) => ({
    ...doc,
    status: 'failed',
    finished_at: new Date().toISOString(),
    errors: [...doc.errors, { path: '', message: errorMessage }],
  }))
}

export async function incrementProgress(
  stackClient: StackClient,
  docId: string,
  fileSize: number
): Promise<void> {
  await updateTracking(stackClient, docId, (doc) => ({
    ...doc,
    bytes_imported: doc.bytes_imported + fileSize,
    files_imported: doc.files_imported + 1,
  }))
}

export async function addError(
  stackClient: StackClient,
  docId: string,
  path: string,
  message: string
): Promise<void> {
  await updateTracking(stackClient, docId, (doc) => ({
    ...doc,
    errors: [...doc.errors, { path, message }],
  }))
}

export async function addSkipped(
  stackClient: StackClient,
  docId: string,
  path: string,
  reason: string,
  size: number
): Promise<void> {
  await updateTracking(stackClient, docId, (doc) => ({
    ...doc,
    skipped: [...doc.skipped, { path, reason, size }],
  }))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tracking tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tracking.ts test/tracking.test.ts
git commit -m "feat: add tracking document helpers with 409 conflict retry"
```

---

### Task 6: Core migration logic

**Files:**
- Create: `src/migration.ts`
- Create: `test/migration.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/migration.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runMigration } from '../src/migration.js'
import type { StackClient } from '../src/stack-client.js'
import type { MigrationCommand, TrackingDoc, NextcloudEntry } from '../src/types.js'
import type { Logger } from 'pino'

function makeStack(overrides: Partial<StackClient> = {}): StackClient {
  return {
    listNextcloudDir: vi.fn().mockResolvedValue([]),
    transferFile: vi.fn().mockResolvedValue({ _id: 'f1', _rev: '1-a', type: 'file', name: 'f', dir_id: 'd', size: 100 }),
    createDir: vi.fn().mockResolvedValue('dir-id'),
    getDiskUsage: vi.fn().mockResolvedValue({ used: 1000, quota: 100000 }),
    getTrackingDoc: vi.fn().mockResolvedValue({
      _id: 'mig-1', _rev: '1-abc', status: 'pending',
      bytes_total: 0, bytes_imported: 0, files_imported: 0,
      errors: [], skipped: [],
    } satisfies TrackingDoc),
    updateTrackingDoc: vi.fn().mockImplementation(async (doc: TrackingDoc) => ({ ...doc, _rev: 'next' })),
    ...overrides,
  } as StackClient
}

function makeCommand(overrides: Partial<MigrationCommand> = {}): MigrationCommand {
  return {
    migrationId: 'mig-1',
    workplaceFqdn: 'alice.cozy.example',
    accountId: 'acc-123',
    sourcePath: '/',
    timestamp: Date.now(),
    ...overrides,
  }
}

const logger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as Logger

describe('runMigration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates target directory and transfers a flat list of files', async () => {
    const entries: NextcloudEntry[] = [
      { type: 'file', name: 'photo.jpg', path: '/photo.jpg', size: 2048, mime: 'image/jpeg' },
      { type: 'file', name: 'doc.pdf', path: '/doc.pdf', size: 1024, mime: 'application/pdf' },
    ]
    const stack = makeStack({
      listNextcloudDir: vi.fn().mockResolvedValueOnce(entries),
    })

    await runMigration(makeCommand(), stack, logger)

    // Creates /Nextcloud target directory
    expect(stack.createDir).toHaveBeenCalledWith('io.cozy.files.root-dir', 'Nextcloud')
    // Transfers both files
    expect(stack.transferFile).toHaveBeenCalledTimes(2)
    expect(stack.transferFile).toHaveBeenCalledWith('acc-123', '/photo.jpg', 'dir-id')
    expect(stack.transferFile).toHaveBeenCalledWith('acc-123', '/doc.pdf', 'dir-id')
    // Updates tracking: running, 2x increment, completed
    expect(stack.updateTrackingDoc).toHaveBeenCalled()
  })

  it('recursively traverses subdirectories', async () => {
    const rootEntries: NextcloudEntry[] = [
      { type: 'directory', name: 'Photos', path: '/Photos', size: 0, mime: '' },
    ]
    const subEntries: NextcloudEntry[] = [
      { type: 'file', name: 'sunset.jpg', path: '/Photos/sunset.jpg', size: 512, mime: 'image/jpeg' },
    ]
    const stack = makeStack({
      listNextcloudDir: vi.fn()
        .mockResolvedValueOnce(rootEntries)    // calculateTotalBytes('/')
        .mockResolvedValueOnce(subEntries)     // calculateTotalBytes('/Photos')
        .mockResolvedValueOnce(subEntries),    // traverseDir re-lists '/Photos'
      createDir: vi.fn()
        .mockResolvedValueOnce('nextcloud-dir')   // /Nextcloud
        .mockResolvedValueOnce('photos-dir'),      // /Nextcloud/Photos
    })

    await runMigration(makeCommand(), stack, logger)

    // Creates both directories
    expect(stack.createDir).toHaveBeenCalledWith('io.cozy.files.root-dir', 'Nextcloud')
    expect(stack.createDir).toHaveBeenCalledWith('nextcloud-dir', 'Photos')
    // Transfers the file into the Photos subdirectory
    expect(stack.transferFile).toHaveBeenCalledWith('acc-123', '/Photos/sunset.jpg', 'photos-dir')
  })

  it('skips files that already exist (409 on transfer)', async () => {
    const entries: NextcloudEntry[] = [
      { type: 'file', name: 'exists.txt', path: '/exists.txt', size: 100, mime: 'text/plain' },
    ]
    const stack = makeStack({
      listNextcloudDir: vi.fn().mockResolvedValueOnce(entries),
      transferFile: vi.fn().mockRejectedValueOnce(new Error('Stack request failed (409): conflict')),
    })

    await runMigration(makeCommand(), stack, logger)

    // Should not throw — migration completes despite the 409
    // updateTrackingDoc should still be called for running + completed
    const statusUpdates = vi.mocked(stack.updateTrackingDoc).mock.calls
      .map((c) => (c[0] as TrackingDoc).status)
    expect(statusUpdates).toContain('running')
    expect(statusUpdates).toContain('completed')
  })

  it('records per-file errors and continues', async () => {
    const entries: NextcloudEntry[] = [
      { type: 'file', name: 'bad.txt', path: '/bad.txt', size: 100, mime: 'text/plain' },
      { type: 'file', name: 'good.txt', path: '/good.txt', size: 200, mime: 'text/plain' },
    ]
    const stack = makeStack({
      listNextcloudDir: vi.fn().mockResolvedValueOnce(entries),
      transferFile: vi.fn()
        .mockRejectedValueOnce(new Error('Stack request failed (500): internal'))
        .mockResolvedValueOnce({ _id: 'f2', _rev: '1-b', type: 'file', name: 'good.txt', dir_id: 'd', size: 200 }),
    })

    await runMigration(makeCommand(), stack, logger)

    // Error recorded in tracking doc
    const errorUpdates = vi.mocked(stack.updateTrackingDoc).mock.calls
      .filter((c) => (c[0] as TrackingDoc).errors.length > 0)
    expect(errorUpdates.length).toBeGreaterThan(0)
    // Second file still transferred
    expect(stack.transferFile).toHaveBeenCalledTimes(2)
  })

  it('calculates bytes_total from directory listing', async () => {
    const entries: NextcloudEntry[] = [
      { type: 'file', name: 'a.txt', path: '/a.txt', size: 300, mime: 'text/plain' },
      { type: 'file', name: 'b.txt', path: '/b.txt', size: 700, mime: 'text/plain' },
    ]
    const stack = makeStack({
      listNextcloudDir: vi.fn().mockResolvedValueOnce(entries),
    })

    await runMigration(makeCommand(), stack, logger)

    // setRunning should include bytes_total = 300 + 700 = 1000
    const runningUpdate = vi.mocked(stack.updateTrackingDoc).mock.calls
      .find((c) => (c[0] as TrackingDoc).status === 'running')
    expect(runningUpdate).toBeDefined()
    expect((runningUpdate![0] as TrackingDoc).bytes_total).toBe(1000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../src/migration.js`

- [ ] **Step 3: Write `src/migration.ts`**

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all migration tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/migration.ts test/migration.test.ts
git commit -m "feat: add core migration logic with recursive traversal and per-file error handling"
```

---

### Task 7: RabbitMQ consumer

**Files:**
- Create: `src/consumer.ts`
- Create: `test/consumer.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/consumer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleMigrationMessage } from '../src/consumer.js'
import type { ClouderyClient } from '../src/cloudery-client.js'
import type { StackClient } from '../src/stack-client.js'
import type { MigrationCommand, TrackingDoc } from '../src/types.js'
import type { Logger } from 'pino'

// Mock the migration module so runMigration doesn't actually execute
vi.mock('../src/migration.js', () => ({
  runMigration: vi.fn().mockResolvedValue(undefined),
}))

// Mock stack-client factory
vi.mock('../src/stack-client.js', () => ({
  createStackClient: vi.fn(),
}))

import { runMigration } from '../src/migration.js'
import { createStackClient } from '../src/stack-client.js'

const logger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as Logger

function makeCommand(overrides: Partial<MigrationCommand> = {}): MigrationCommand {
  return {
    migrationId: 'mig-1',
    workplaceFqdn: 'alice.cozy.example',
    accountId: 'acc-123',
    sourcePath: '/',
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('handleMigrationMessage', () => {
  let mockCloudery: ClouderyClient
  let mockStack: StackClient

  beforeEach(() => {
    vi.clearAllMocks()

    mockCloudery = {
      getToken: vi.fn().mockResolvedValue('jwt-token'),
    }

    mockStack = {
      getTrackingDoc: vi.fn().mockResolvedValue({
        _id: 'mig-1', _rev: '1-abc', status: 'pending',
        bytes_total: 0, bytes_imported: 0, files_imported: 0,
        errors: [], skipped: [],
      } satisfies TrackingDoc),
      getDiskUsage: vi.fn().mockResolvedValue({ used: 1000, quota: 100000 }),
      listNextcloudDir: vi.fn().mockResolvedValue([]),
      updateTrackingDoc: vi.fn().mockImplementation(async (doc: TrackingDoc) => doc),
      transferFile: vi.fn(),
      createDir: vi.fn(),
    } as unknown as StackClient

    vi.mocked(createStackClient).mockReturnValue(mockStack)
  })

  it('fetches token, validates, and fires migration', async () => {
    const command = makeCommand()

    await handleMigrationMessage(command, mockCloudery, logger)

    expect(mockCloudery.getToken).toHaveBeenCalledWith('alice.cozy.example')
    expect(createStackClient).toHaveBeenCalledWith('alice.cozy.example', 'jwt-token', mockCloudery)
    expect(mockStack.getTrackingDoc).toHaveBeenCalledWith('mig-1')
    expect(runMigration).toHaveBeenCalledWith(command, mockStack, logger)
  })

  it('skips migration if status is completed', async () => {
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValueOnce({
      _id: 'mig-1', _rev: '1-abc', status: 'completed',
      bytes_total: 5000, bytes_imported: 5000, files_imported: 10,
      errors: [], skipped: [],
    } satisfies TrackingDoc)

    await handleMigrationMessage(makeCommand(), mockCloudery, logger)

    expect(runMigration).not.toHaveBeenCalled()
  })

  it('skips migration if status is running', async () => {
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValueOnce({
      _id: 'mig-1', _rev: '1-abc', status: 'running',
      bytes_total: 5000, bytes_imported: 2000, files_imported: 5,
      errors: [], skipped: [],
    } satisfies TrackingDoc)

    await handleMigrationMessage(makeCommand(), mockCloudery, logger)

    expect(runMigration).not.toHaveBeenCalled()
  })

  it('proceeds if status is failed (retry scenario)', async () => {
    vi.mocked(mockStack.getTrackingDoc).mockResolvedValueOnce({
      _id: 'mig-1', _rev: '1-abc', status: 'failed',
      bytes_total: 5000, bytes_imported: 2000, files_imported: 5,
      errors: [{ path: '/x', message: 'boom' }], skipped: [],
    } satisfies TrackingDoc)

    await handleMigrationMessage(makeCommand(), mockCloudery, logger)

    expect(runMigration).toHaveBeenCalled()
  })

  it('marks migration as failed if quota is insufficient', async () => {
    vi.mocked(mockStack.getDiskUsage).mockResolvedValueOnce({ used: 99000, quota: 100000 })
    vi.mocked(mockStack.listNextcloudDir).mockResolvedValueOnce([
      { type: 'file', name: 'big.zip', path: '/big.zip', size: 50000, mime: 'application/zip' },
    ])

    await handleMigrationMessage(makeCommand(), mockCloudery, logger)

    expect(runMigration).not.toHaveBeenCalled()
    // Should have updated tracking doc to failed
    const failedUpdate = vi.mocked(mockStack.updateTrackingDoc).mock.calls
      .find((c) => (c[0] as TrackingDoc).status === 'failed')
    expect(failedUpdate).toBeDefined()
  })

  it('throws on Cloudery failure (triggers retry/DLQ)', async () => {
    vi.mocked(mockCloudery.getToken).mockRejectedValueOnce(
      new Error('Cloudery token request failed (503): unavailable')
    )

    await expect(
      handleMigrationMessage(makeCommand(), mockCloudery, logger)
    ).rejects.toThrow('503')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../src/consumer.js`

- [ ] **Step 3: Write `src/consumer.ts`**

```typescript
import type { Logger } from 'pino'
import type { ClouderyClient } from './cloudery-client.js'
import { createStackClient, type StackClient } from './stack-client.js'
import { runMigration } from './migration.js'
import { setFailed } from './tracking.js'
import type { MigrationCommand } from './types.js'

async function estimateSourceSize(
  stackClient: StackClient,
  accountId: string,
  path: string
): Promise<number> {
  const entries = await stackClient.listNextcloudDir(accountId, path)
  let total = 0
  for (const entry of entries) {
    total += entry.size
  }
  return total
}

export async function handleMigrationMessage(
  command: MigrationCommand,
  clouderyClient: ClouderyClient,
  logger: Logger
): Promise<void> {
  const migrationLogger = logger.child({
    migration_id: command.migrationId,
    instance: command.workplaceFqdn,
  })

  // Phase 1: token acquisition (throws on failure → retry/DLQ)
  const token = await clouderyClient.getToken(command.workplaceFqdn)
  const stackClient = createStackClient(command.workplaceFqdn, token, clouderyClient)

  // Phase 2: idempotency check
  const trackingDoc = await stackClient.getTrackingDoc(command.migrationId)
  if (trackingDoc.status === 'completed' || trackingDoc.status === 'running') {
    migrationLogger.info({ status: trackingDoc.status }, 'Migration already processed, skipping')
    return
  }

  // Phase 3: quota validation
  const [diskUsage, sourceSize] = await Promise.all([
    stackClient.getDiskUsage(),
    estimateSourceSize(stackClient, command.accountId, command.sourcePath || '/'),
  ])
  const availableSpace = diskUsage.quota - diskUsage.used
  if (sourceSize > availableSpace) {
    migrationLogger.warn(
      { sourceSize, availableSpace },
      'Insufficient quota for migration'
    )
    await setFailed(
      stackClient,
      command.migrationId,
      `Insufficient quota: need ${sourceSize} bytes, only ${availableSpace} available`
    )
    return
  }

  // Phase 4: fire and forget (handler returns = ACK)
  migrationLogger.info('Validation passed, starting migration')
  runMigration(command, stackClient, logger).catch((error) => {
    migrationLogger.error({ error }, 'Migration failed after ACK')
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all consumer tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/consumer.ts test/consumer.test.ts
git commit -m "feat: add RabbitMQ message handler with idempotency and quota checks"
```

---

### Task 8: Entry point with graceful shutdown

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Write `src/index.ts`**

Replace the placeholder with the full entry point:

```typescript
import pino from 'pino'
import { RabbitMQClient, type RabbitMQMessage } from '@linagora/rabbitmq-client'
import { loadConfig } from './config.js'
import { createClouderyClient } from './cloudery-client.js'
import { handleMigrationMessage } from './consumer.js'
import type { MigrationCommand } from './types.js'

const EXCHANGE = 'migration'
const ROUTING_KEY = 'nextcloud.migration.requested'
const QUEUE = 'migration.nextcloud.commands'

async function main(): Promise<void> {
  const config = loadConfig()
  const logger = pino({ level: config.logLevel })

  logger.info('Starting Nextcloud migration service')

  const clouderyClient = createClouderyClient(config.clouderyUrl, config.clouderyToken)

  const rabbitClient = new RabbitMQClient({
    url: config.rabbitmqUrl,
    maxRetries: 3,
    retryDelay: 1000,
    prefetch: 10,
    logger,
  })

  await rabbitClient.init()
  logger.info('Connected to RabbitMQ')

  await rabbitClient.subscribe(
    EXCHANGE,
    ROUTING_KEY,
    QUEUE,
    async (msg: RabbitMQMessage) => {
      await handleMigrationMessage(msg as unknown as MigrationCommand, clouderyClient, logger)
    }
  )
  logger.info({ exchange: EXCHANGE, queue: QUEUE, routingKey: ROUTING_KEY }, 'Subscribed to migration queue')

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down')
    await rabbitClient.close()
    logger.info('RabbitMQ connection closed')
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error) => {
  console.error('Fatal error during startup:', error)
  process.exit(1)
})
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add entry point with RabbitMQ subscription and graceful shutdown"
```

---

### Task 9: Dockerfile

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

- [ ] **Step 1: Create `Dockerfile`**

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Create `.dockerignore`**

```
node_modules
dist
test
.git
*.md
```

- [ ] **Step 3: Verify Docker builds**

Run: `docker build -t twake-nextcloud-migration .`
Expected: builds successfully, no errors.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "chore: add Dockerfile with multi-stage build"
```

---

### Task 10: Clean up and final verification

**Files:**
- Delete: `test/smoke.test.ts` (no longer needed)

- [ ] **Step 1: Remove smoke test**

```bash
rm test/smoke.test.ts
```

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: all tests pass (config, cloudery-client, stack-client, tracking, migration, consumer).

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove smoke test, verify full test suite passes"
```
