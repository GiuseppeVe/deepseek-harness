import { describe, expect, it } from 'vitest'
import { createLeaseStore } from '../src/lease.ts'

describe('Desktop backend lease', () => {
  it('persists exact process identity and control token for an owned backend', async () => {
    let written = ''
    const store = createLeaseStore('C:/Users/A/AppData/Local/DSH Desktop/backend.lease.json', {
      readFile: async () => { throw new Error('ENOENT') },
      writeFile: async (_path, value) => { written = value },
      unlink: async () => {},
    })

    await store.write({
      pid: 42,
      nonce: 'instance-nonce-with-at-least-32-characters',
      token: 'control-token-with-at-least-32-characters',
      creationFiletime: '134010000000000000',
    })

    expect(JSON.parse(written)).toEqual({
      pid: 42,
      nonce: 'instance-nonce-with-at-least-32-characters',
      token: 'control-token-with-at-least-32-characters',
      creationFiletime: '134010000000000000',
    })
  })

  it('refuses missing, malformed, or extra process-identity fields', async () => {
    for (const value of [
      '{"pid":42,"token":"control-token-with-at-least-32-characters"}',
      '{"pid":0,"nonce":"nonce-with-at-least-32-characters","token":"control-token-with-at-least-32-characters","creationFiletime":"134010000000000000"}',
      '{"pid":42,"nonce":"short","token":"control-token-with-at-least-32-characters","creationFiletime":"134010000000000000"}',
      '{"pid":42,"nonce":"nonce-with-at-least-32-characters","token":"control-token-with-at-least-32-characters","creationFiletime":"not-a-filetime"}',
      '{"pid":42,"nonce":"nonce-with-at-least-32-characters","token":"control-token-with-at-least-32-characters","creationFiletime":"134010000000000000","extra":true}',
    ]) {
      const store = createLeaseStore('lease.json', {
        readFile: async () => value,
        writeFile: async () => {},
        unlink: async () => {},
      })
      await expect(store.read()).rejects.toThrow('invalid Desktop backend lease')
    }
  })
})
