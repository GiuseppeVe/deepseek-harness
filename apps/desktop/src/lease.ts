/** Durable proof that a local backend belongs to DSH Desktop. */

import { readFile, rm, writeFile } from 'node:fs/promises'

/** Minimum length enforced by the backend control-route configuration. */
const MINIMUM_CONTROL_TOKEN_LENGTH = 32

/** PID and bearer token required to authenticate one backend listener. */
export interface BackendLease {
  /** Root process PID for the owned backend tree. */
  pid: number
  /** Process-local token accepted by the Desktop control routes. */
  token: string
}

/** Lease persistence used by the backend supervisor. */
export interface LeaseStore {
  /** Read the prior owned backend proof, when present. */
  read(): Promise<BackendLease | undefined>
  /** Replace the proof after a backend authenticates its control route. */
  write(lease: BackendLease): Promise<void>
  /** Remove a proof whose owned backend exited. */
  remove(): Promise<void>
}

/** Injectable file operations for lease tests and Desktop's data root. */
export interface LeaseFileAdapter {
  /** Read one UTF-8 lease file. */
  readFile(path: string): Promise<string>
  /** Replace one lease file. */
  writeFile(path: string, value: string): Promise<void>
  /** Remove one lease file when its backend exits. */
  unlink(path: string): Promise<void>
}

/** Validate only fields that authorize a future process-tree action. */
function validateLease(value: unknown): BackendLease {
  if (typeof value !== 'object' || value === null) throw new Error('invalid Desktop backend lease')
  const record = value as Record<string, unknown>
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0 || typeof record.token !== 'string' || record.token.length < MINIMUM_CONTROL_TOKEN_LENGTH) {
    throw new Error('invalid Desktop backend lease')
  }
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, 'pid') || !Object.hasOwn(record, 'token')) {
    throw new Error('invalid Desktop backend lease')
  }
  return { pid: record.pid as number, token: record.token as string }
}

/** Build a file-backed lease store with no diagnostic or metadata fields. */
export function createLeaseStore(path: string, adapter: LeaseFileAdapter): LeaseStore {
  return {
    async read(): Promise<BackendLease | undefined> {
      let text: string
      try {
        text = await adapter.readFile(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
      try {
        return validateLease(JSON.parse(text))
      } catch {
        throw new Error('invalid Desktop backend lease')
      }
    },
    async write(lease: BackendLease): Promise<void> {
      const verified = validateLease(lease)
      await adapter.writeFile(path, JSON.stringify(verified))
    },
    async remove(): Promise<void> {
      try {
        await adapter.unlink(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },
  }
}

/** File adapter for the Windows Electron main process. */
export const nodeLeaseFileAdapter: LeaseFileAdapter = {
  readFile: async path => await readFile(path, 'utf8'),
  writeFile: async (path, value) => { await writeFile(path, value, { encoding: 'utf8', mode: 0o600 }) },
  unlink: async (path) => { await rm(path, { force: true }) },
}
