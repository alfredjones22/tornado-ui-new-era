import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decryptCliStore, extractPublicSnapshot } from '../scripts/export-tornado-snapshot.mjs'

const privateMarker = 'synthetic-private-data-must-never-be-exported'
const password = 'synthetic-test-password'
const registry = '0x1234'

function fixture(chainId = 1, block = '0x64') {
  const event = { blockNumber: '0x20', transactionHash: '0x777', pool: '0x2', privateField: privateMarker }
  const state = {
    deposits: { depositsTuples: [['0x2', [['0x3', { ...event, commitment: '0x3', leafIndex: 0, timestamp: '0x50', salt: privateMarker }]]]], secrets: privateMarker },
    withdrawals: { withdrawalsTuples: [['0x4', { ...event, nullifierHash: '0x4', to: '0x5', relayer: '0x0', fee: '0x1', secret: privateMarker }]] },
    assets: { assetsTuples: [['0x0', { name: 'ETH', decimals: 18, address: '0x0', symbol: 'ETH', metadata: privateMarker }]] },
    pools: { poolsTuples: [['0x2', { address: '0x2', asset: '0x0', isERC20: false, denomination: '0x10', registeredBlock: '0x10', state: 1, rootHistorySize: 30, protocolFeePercentage: 0, lastSyncedBlock: block, privateField: privateMarker }]] },
    instanceRegistryInfo: { chainId: `0x${chainId.toString(16)}`, ensSubdomainKey: 'test', instanceRegistry: { address: registry, deploymentBlock: '0x10', secret: privateMarker }, relayerRegistry: { address: '0x7', deploymentBlock: '0x10' }, aggregator: { address: '0x8' } },
    relayers: { relayersTuples: [['private-metadata', privateMarker]] },
    sync: { lastSyncedBlock: '0x999', relayerRegistrySyncedBlock: '0x10', privateField: privateMarker },
    legacySecrets: { importedNotes: privateMarker }, userSecrets: privateMarker, signatureSecrets: privateMarker, futureSlice: privateMarker,
  }
  const key = `tornado-cash-state-${chainId}-${BigInt(registry)}`
  return { key, state, store: { [key]: JSON.stringify(state), unrelatedWalletIdentity: privateMarker } }
}

function encrypt(store) {
  const salt = randomBytes(16), iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', pbkdf2Sync(password, salt, 310_000, 32, 'sha256'), iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(store)), cipher.final()])
  return { v: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
}

describe('CLI public Tornado snapshot export', () => {
  it.each([1, 11155111])('preserves public event history and pool checkpoints on chain %i while excluding all private fields', chainId => {
    const { key, store } = fixture(chainId)
    const before = JSON.stringify(store)
    const { snapshot, summary } = extractPublicSnapshot(store, chainId)
    expect(JSON.stringify(snapshot)).not.toContain(privateMarker)
    expect(Object.keys(snapshot)).toEqual([key])
    expect(snapshot[key].deposits.depositsTuples[0][1][0]).toEqual(['0x3', { blockNumber: '0x20', transactionHash: '0x777', pool: '0x2', commitment: '0x3', leafIndex: 0, timestamp: '0x50' }])
    expect(snapshot[key].withdrawals.withdrawalsTuples[0][1].nullifierHash).toBe('0x4')
    expect(snapshot[key].pools.poolsTuples[0][1].lastSyncedBlock).toBe('0x64')
    expect(summary).toMatchObject({ chainId, pools: 1, deposits: 1, withdrawals: 1, oldestPoolCheckpoint: '100' })
    expect(JSON.stringify(store)).toBe(before)
  })

  it('reads both current compressed CLI entries and older plain string entries', () => {
    const { key, store } = fixture()
    const compressed = { [key]: { codec: 'kohaku-gzip-v1', data: gzipSync(store[key]).toString('base64') } }
    expect(extractPublicSnapshot(compressed, 1)).toEqual(extractPublicSnapshot(store, 1))
    expect(() => extractPublicSnapshot({ [key]: { codec: 'unknown', data: '' } }, 1)).toThrow('compression format')
  })

  it('uses one derivation copy and normalizes a signature-only storage key', () => {
    const { key, store } = fixture()
    const normal = extractPublicSnapshot(store, 1)
    expect(extractPublicSnapshot({ [`sig:${key}`]: store[key] }, 1)).toEqual(normal)
    expect(extractPublicSnapshot({ ...store, [`sig:${key}`]: store[key] }, 1)).toEqual(normal)
    expect(() => extractPublicSnapshot({ ...store, 'tornado-cash-state-1-999': store[key] }, 1)).toThrow('one Tornado registry')
  })

  it('rejects absent per-pool checkpoints even when the global sync cursor is current', () => {
    const { key, state } = fixture()
    delete state.pools.poolsTuples[0][1].lastSyncedBlock
    expect(() => extractPublicSnapshot({ [key]: JSON.stringify(state) }, 1)).toThrow('sync checkpoint')
    expect(() => extractPublicSnapshot(fixture().store, 11155111)).toThrow('matching wallet')
    state.instanceRegistryInfo.chainId = '0x2'
    expect(() => extractPublicSnapshot({ [key]: JSON.stringify(state) }, 1)).toThrow('does not match')
  })

  it('decrypts the CLI AES-GCM envelope and rejects wrong passwords and tampering without logging content', () => {
    const { store } = fixture()
    const encrypted = encrypt(store)
    expect(decryptCliStore(encrypted, password)).toEqual(store)
    expect(() => decryptCliStore(encrypted, 'incorrect-password')).toThrow('wrong password or damaged file')
    expect(() => decryptCliStore({ ...encrypted, tag: Buffer.alloc(16).toString('base64') }, password)).toThrow('wrong password or damaged file')
  })
})
