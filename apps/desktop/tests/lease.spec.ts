import { describe, expect, it } from 'vitest'
import { createLeaseStore } from '../src/lease.ts'

describe('Desktop backend lease', () => {
  it('persists only pid and control token for an owned backend', async () => {
    let written = ''
    const store = createLeaseStore('C:/Users/A/AppData/Local/DSH Desktop/backend.lease.json', {
      readFile: async () => { throw new Error('ENOENT') },
      writeFile: async (_path, value) => { written = value },
      unlink: async () => {},
    })

    await store.write({ pid: 42, token: 'control-token-with-at-least-32-characters' })

    expect(JSON.parse(written)).toEqual({
      pid: 42,
      token: 'control-token-with-at-least-32-characters',
    })
  })

  it('refuses malformed leases instead of targeting an unvalidated pid', async () => {
    const store = createLeaseStore('lease.json', {
      readFile: async () => '{"pid":0,"token":"short"}',
      writeFile: async () => {},
      unlink: async () => {},
    })

    await expect(store.read()).rejects.toThrow('invalid Desktop backend lease')
  })
})
